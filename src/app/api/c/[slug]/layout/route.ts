import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, clientAccessGuard, isAgencyOperator } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getLayout, saveLayout, resetLayout } from "@/lib/dashboard/layout-store";
import {
  ClientLayoutSchema,
  StaffLayoutSchema,
  authorizeLayoutWrite,
  defaultAudience,
  parseAudience,
} from "@/lib/dashboard/layout-write";

/**
 * Which sections a dashboard shows — §5.
 *
 * The second endpoint a client-role user may write through, and it follows
 * exactly the shape W3 established, because it has exactly W3's problem: the
 * permission governing the write (`locked`) lives on the row being written.
 *
 *  1. `clientAccessGuard` — role and status re-read from the database.
 *  2. `authorizeLayoutWrite` on the STORED row, before any body is parsed.
 *  3. Rate limit.
 *  4. A `.strict()` schema that does not contain `locked` for clients.
 *  5. `saveLayout`, which sets `locked` only when explicitly given it.
 */

const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 10 * 60_000;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const denied = await clientAccessGuard(slug);
  if (denied) return denied;

  /*
   * Tenant-scoped, ON TOP OF the guard above rather than instead of it. The
   * guard says who the caller is; this says the client is theirs. `slug` is
   * derived from a business name and therefore guessable, so an unscoped
   * read here was reachable by typing one.
   */
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const session = await getSessionUser();
  const audience = audienceFor(req, session);
  if (!audience) {
    return NextResponse.json({ error: "Unknown audience" }, { status: 400 });
  }

  const layout = await getLayout(client.id, audience);
  return NextResponse.json({ audience, layout: serialise(layout) });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;

  const denied = await clientAccessGuard(slug);
  if (denied) return denied;

  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const session = await getSessionUser();
  const audience = audienceFor(req, session);
  if (!audience) {
    return NextResponse.json({ error: "Unknown audience" }, { status: 400 });
  }

  // The STORED row, read before anything from the request is trusted.
  const current = await getLayout(client.id, audience);
  const verdict = authorizeLayoutWrite(session, slug, audience, current);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  const gate = rateLimit(
    `layout:${client.id}:${audience}`,
    WRITE_LIMIT,
    WRITE_WINDOW_MS,
  );
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes just now. Try again in a few minutes." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const body = await req.json().catch(() => null);
  // The schema is chosen by the CALLER's role, not by the audience being
  // written — only staff may ever send `locked`.
  const schema = verdict.staff ? StaffLayoutSchema : ClientLayoutSchema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: verdict.staff
          ? "Invalid layout."
          : "Invalid layout. You can choose which sections are shown; the lock is set by your agency.",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const data = parsed.data;
  // Narrowed rather than spread: `locked` exists on the staff schema's output
  // only, and reading it off a union would type as `unknown`.
  const locked = verdict.staff
    ? (data as { locked?: boolean }).locked
    : undefined;

  let outcome;
  try {
    outcome = await saveLayout(client.id, audience, {
      sections: data.sections,
      // `!== undefined` rather than truthiness: `locked: false` is a real
      // instruction to unlock and must not be read as "not supplied".
      ...(locked !== undefined ? { locked } : {}),
      updatedBy: session?.userId ?? null,
      ifUnmodifiedSince: data.ifUnmodifiedSince,
    });
  } catch (err) {
    console.error("[layout] write failed:", err);
    return NextResponse.json(
      {
        error:
          "Could not save. If customising has never worked on this deployment, the database migration for it has not been applied yet.",
      },
      { status: 500 },
    );
  }

  if (!outcome.ok) {
    /*
     * 409 rather than last-write-wins. Staff setting a client's default and the
     * client editing it target the same row, so a silent overwrite means one of
     * them watches their change evaporate with no explanation.
     */
    return NextResponse.json(
      {
        error: "Someone else changed this layout while you were editing it.",
        layout: serialise(outcome.current),
      },
      { status: 409 },
    );
  }

  await recordChange(req, client.id, audience, verdict.staff, data.sections.length);
  return NextResponse.json({ audience, layout: serialise(outcome.row) });
}

/** Back to code defaults. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const denied = await clientAccessGuard(slug);
  if (denied) return denied;

  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const session = await getSessionUser();
  const audience = audienceFor(req, session);
  if (!audience) {
    return NextResponse.json({ error: "Unknown audience" }, { status: 400 });
  }

  const current = await getLayout(client.id, audience);
  const verdict = authorizeLayoutWrite(session, slug, audience, current);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  try {
    await resetLayout(client.id, audience);
  } catch (err) {
    console.error("[layout] reset failed:", err);
    return NextResponse.json({ error: "Could not reset." }, { status: 500 });
  }

  await record({
    action: "layout.reset",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: { audience },
  });

  return NextResponse.json({
    audience,
    layout: serialise(await getLayout(client.id, audience)),
  });
}

/**
 * Which audience row this request addresses.
 *
 * Defaults to the caller's own. An explicit `?audience=` is honoured only for
 * staff — `authorizeLayoutWrite` would refuse a client anyway, but returning
 * null here means a client cannot even READ the staff row.
 */
function audienceFor(
  req: NextRequest,
  session: Awaited<ReturnType<typeof getSessionUser>>,
) {
  const requested = req.nextUrl.searchParams.get("audience");
  if (!requested) return defaultAudience(session);
  if (!isAgencyOperator(session)) return null;
  return parseAudience(requested);
}

function serialise(layout: Awaited<ReturnType<typeof getLayout>>) {
  return {
    sections: layout.sections.map((s) => ({
      id: s.def.id,
      label: s.def.label,
      description: s.def.description,
      cadence: s.def.cadence,
      required: Boolean(s.def.required),
      visible: s.visible,
      isNew: s.isNew,
    })),
    locked: layout.locked,
    customised: layout.customised,
    updatedAt: layout.updatedAt?.toISOString() ?? null,
    updatedBy: layout.updatedBy,
  };
}

async function recordChange(
  req: NextRequest,
  clientId: string,
  audience: string,
  staff: boolean,
  count: number,
) {
  await record({
    action: "layout.update",
    targetType: "client",
    targetId: clientId,
    clientId,
    ...requestContext(req),
    metadata: { audience, by: staff ? "staff" : "client", sections: count },
  });
}
