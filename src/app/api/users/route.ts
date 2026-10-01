import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import {
  createUser,
  listUsersForAgency,
  allowedClientNamesForUser,
  inviterNameFor,
} from "@/lib/users";
import { assignableRoles } from "@/lib/roles";
import { invitesConfigured } from "@/lib/invites";
import { issueAccessLink } from "@/lib/access-links";
import { rateLimit } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Their own agency's team, not the platform's.
  return NextResponse.json({
    users: await listUsersForAgency(session!.agencyId),
  });
}

/**
 * An invite. The operator names the person and what they may see; the person
 * chooses their own password from the link this returns and emails.
 *
 * 🔴 No `password` field. This used to take one, with an 8-character minimum
 * against a 12-character policy everywhere else, and the page then displayed
 * it for pasting into a chat. `.strict()` so a stale client still sending one
 * is refused loudly instead of having it silently dropped.
 */
const CreateSchema = z.object({
  email: z.string().trim().email(),
  // Validated as a shape here; whether the CALLER may hand it out is decided
  // below against `assignableRoles`, which the request body cannot influence.
  role: z.enum(["superadmin", "agency", "staff", "client"]),
  name: z.string().trim().max(120).optional(),
  clientIds: z.array(z.string().uuid()).optional(),
}).strict();

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  /*
   * A client login with no dashboards signs in to an empty list and reads it as
   * "my numbers are gone". The form already insisted; the endpoint must too.
   */
  if (parsed.data.role === "client" && !parsed.data.clientIds?.length) {
    return NextResponse.json(
      { error: "Pick at least one dashboard for a client login." },
      { status: 400 },
    );
  }

  /*
   * Before the login exists, not after: without a signing secret no link can be
   * minted, and creating the row anyway would leave an account nobody can ever
   * set up — sitting in the list looking invited.
   */
  if (!invitesConfigured()) {
    return NextResponse.json(
      { error: "Invites need AUTH_SECRET (or ENCRYPTION_KEY) set on the server." },
      { status: 503 },
    );
  }

  // Each invite can send an email from our domain. Per operator, generous.
  const limit = rateLimit(`invite:${session!.userId}`, 30, 60 * 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many invites in the last hour. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  try {
    /*
     * 🔴 Roles are handed out strictly downward.
     *
     * Without this an `agency` operator could POST `role: "staff"` and mint an
     * account that reads every tenant in the database — a one-request escape
     * from their own tenancy, through the ordinary "add a teammate" form. The
     * check is against the caller's role from `getSessionUser` (re-read from
     * the database), never against anything in the body.
     */
    if (!assignableRoles(session!.role).includes(parsed.data.role)) {
      return NextResponse.json(
        { error: "You cannot create a user with that role." },
        { status: 403 },
      );
    }

    const user = await createUser({
      // Same rule as client creation: the tenant comes from the caller's
      // session, so nobody can plant a login inside another agency.
      agencyId: session!.agencyId,
      email: parsed.data.email,
      // No password: an invite. See `createUser`.
      role: parsed.data.role,
      name: parsed.data.name,
      clientIds:
        parsed.data.role === "client" ? (parsed.data.clientIds ?? []) : [],
    });
    const link = await issueAccessLink({
      user,
      kind: "invite",
      inviterName: await inviterNameFor(session!.userId),
      clientNames:
        user.role === "client" ? await allowedClientNamesForUser(user.id) : [],
    });

    void audit.record({
      action: "user.invite",
      targetType: "user",
      targetId: user.id,
      // A teammate change names no client, so the tenant comes from the
      // session — the same one the user was just created inside.
      agencyId: session!.agencyId,
      metadata: {
        email: user.email,
        role: user.role,
        clients:
          parsed.data.role === "client"
            ? (parsed.data.clientIds ?? []).length
            : "all",
        // 🔴 Never the URL — it IS the credential until it is used.
        emailed: link?.emailed ?? false,
      },
      ...audit.requestContext(req),
    });
    return NextResponse.json(
      {
        ok: true,
        user: { id: user.id, email: user.email, role: user.role },
        link,
      },
      { status: 201 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed";
    const dup = /unique|duplicate/i.test(msg);
    return NextResponse.json(
      {
        ok: false,
        error: dup
          ? "A user with that email already exists."
          : "Failed to create user",
      },
      { status: dup ? 409 : 500 },
    );
  }
}
