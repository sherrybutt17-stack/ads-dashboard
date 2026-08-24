import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, clientAccessGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { isValidHexColor, normalizeBrandColor } from "@/lib/branding";
import { getClientBranding, saveClientBranding } from "@/lib/branding-store";
import {
  ClientBrandingSchema,
  authorizeClientBrandingWrite,
  readLogoUpload,
  BRANDING_WRITE_FAILED,
} from "@/lib/branding-write";

/**
 * A client editing their OWN brand — W3.
 *
 * This is the only endpoint in the app that a client-role user may write
 * through, so its shape is deliberate:
 *
 *  1. `clientAccessGuard` — re-reads role and status from the database, so a
 *     demoted or deactivated account loses access on its next request rather
 *     than whenever its 30-day token happens to expire.
 *  2. `authorizeClientBrandingWrite` — the named decision, tested exhaustively
 *     in `branding-write.test.ts`. **It runs before the body is read.**
 *  3. Rate limiting, keyed by client.
 *  4. `ClientBrandingSchema`, which is `.strict()` and does not contain the
 *     agency-owned fields at all.
 *  5. `saveClientBranding`, which writes only the keys it is handed.
 *
 * 🔴 Steps 2 and 4 are the escape-hatch defence, and they are two separate
 * mechanisms on purpose. Reading the STORED `clientEditable` before parsing
 * means a locked-out client's body never gets to argue about whether the body
 * is allowed; the strict schema then means that even an unlocked client cannot
 * reach the switch that unlocked them. Either alone would be enough today —
 * both together survive one of them being edited by someone who has not read
 * this comment.
 *
 * The proxy carve-out that makes this path reachable is NOT what authorizes it.
 * The checks here hold even if that rule is later loosened.
 */

const WRITE_LIMIT = 20;
const WRITE_WINDOW_MS = 10 * 60_000;

export async function GET(
  _req: NextRequest,
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

  return NextResponse.json({ branding: await getClientBranding(client.id) });
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

  // The STORED switch, read before anything from the request is trusted.
  const current = await getClientBranding(client.id);
  const session = await getSessionUser();
  const verdict = authorizeClientBrandingWrite(session, slug, current);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  /*
   * Keyed by client rather than by IP or user. The resource being protected is
   * this client's branding row and the Postgres writes behind it — a limit that
   * a single actor could multiply by switching networks would not protect it.
   */
  const gate = rateLimit(`branding:${client.id}`, WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes just now. Try again in a few minutes." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const actor = session?.userId ?? null;
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const result = await readLogoUpload(form);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const wrote = await write(() =>
      saveClientBranding(client.id, { logo: result.logo, updatedBy: actor }),
    );
    if (wrote) return wrote;
    await audit(
      req,
      client.id,
      result.logo ? "branding.logo_uploaded" : "branding.logo_removed",
      { by: verdict.staff ? "staff" : "client" },
    );
    return NextResponse.json({ ok: true, logo: Boolean(result.logo) });
  }

  const body = await req.json().catch(() => null);
  const parsed = ClientBrandingSchema.safeParse(body);
  if (!parsed.success) {
    /*
     * A rejected key is very likely an agency-only field. Say so, rather than
     * returning a bare validation dump — the caller is either a client whose UI
     * offered something it should not have, or someone probing the boundary,
     * and both are better served by the actual rule.
     */
    return NextResponse.json(
      {
        error:
          "Invalid input. Display name, brand colour, contact line and logo are the fields you can change here.",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  if (parsed.data.brandColor && !isValidHexColor(parsed.data.brandColor)) {
    return NextResponse.json(
      { error: "Brand colour must be a hex value like #2aa9b8." },
      { status: 400 },
    );
  }

  const wrote = await write(() =>
    saveClientBranding(client.id, { ...parsed.data, updatedBy: actor }),
  );
  if (wrote) return wrote;
  await audit(req, client.id, "branding.update", {
    fields: Object.keys(parsed.data),
    by: verdict.staff ? "staff" : "client",
  });

  return NextResponse.json({
    ok: true,
    branding: await getClientBranding(client.id),
    // What the colour actually BECAME. It is normalised into a band legible on
    // both themes, so the stored value frequently differs from the one typed.
    normalizedColor: parsed.data.brandColor
      ? normalizeBrandColor(parsed.data.brandColor)
      : undefined,
  });
}

/**
 * Run a branding write, turning a thrown database error into a named response.
 * Returns null on success, or the error response to send.
 */
async function write(fn: () => Promise<void>): Promise<NextResponse | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    console.error("[branding] write failed:", err);
    return NextResponse.json({ error: BRANDING_WRITE_FAILED }, { status: 500 });
  }
}

async function audit(
  req: NextRequest,
  clientId: string,
  action: string,
  metadata: Record<string, unknown>,
) {
  await record({
    action,
    targetType: "client",
    targetId: clientId,
    clientId,
    ...requestContext(req),
    metadata,
  });
}
