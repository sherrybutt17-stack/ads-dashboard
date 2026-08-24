import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type Client } from "@/db/schema";
import { allowedSlugsForUser } from "@/lib/users";
import { isOperatorRole, isPlatformRole } from "@/lib/roles";
import { getClientByIdForSession } from "@/lib/clients";
import {
  verifySessionToken,
  SESSION_COOKIE,
  type SessionPayload,
} from "@/lib/session";

/**
 * Server-side session reader for pages and route handlers (node runtime).
 *
 * The edge proxy enforces coarse path access from the signed token alone (no DB
 * on the hot path). This is the authoritative check: it re-reads the user's
 * status, ROLE and client grants from the database rather than trusting the
 * token's baked-in claims — so a demotion (staff→client) or a revoked client
 * grant takes effect on the very next request, not only when the up-to-30-day
 * token expires. Any handler doing a real authorization decision must call this,
 * not read the token directly.
 */
export async function getSessionUser(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const payload = await verifySessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!payload) return null;

  // The shared-password bootstrap staff has no DB row.
  if (payload.userId === "shared") return payload;

  const [u] = await db
    .select({ status: users.status, role: users.role, agencyId: users.agencyId })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);
  if (!u || u.status !== "active") return null;

  /*
   * Authorization from the DB, not the token: role changes and grant
   * revocations are honoured immediately.
   *
   * 🔴 `agencyId` comes from the row too, and the token's copy is discarded.
   * The token is signed so it cannot be forged, but it can be STALE — it lives
   * up to 30 days, and a user moved between agencies would otherwise keep
   * acting inside the old one until their cookie happened to expire. The token
   * carries the tenant so the edge proxy can decide without a query; anything
   * that has already paid for a query uses the row.
   */
  const slugs = u.role === "client" ? await allowedSlugsForUser(payload.userId) : [];
  return { userId: payload.userId, agencyId: u.agencyId, role: u.role, slugs };
}

/* ------------------------------------------------------------------ *
 * The three tiers
 * ------------------------------------------------------------------ *
 *
 * Authorization used to be one bit: `staff` or not. That is the correct shape
 * for a tool one agency runs, and it has no room at all for the question SaaS
 * asks — "may this person do this to THEIR OWN book?" — because there was only
 * ever one book.
 *
 *   superadmin — us. Sees across agencies. `/audit` and nothing else, for now.
 *   agency     — runs one agency's book: creates clients, connects accounts,
 *                writes commentary, manages their own teammates.
 *   client     — one dashboard, and their own branding.
 *
 * `staff` satisfies BOTH upper tiers while it exists, because that is what it
 * has always meant. It is the pre-tenancy role and retires in one deliberate
 * step once nothing checks for it — see the note on `userRoleEnum`.
 */

/** Platform-wide reach. Crosses agency boundaries. */
export function isSuperadmin(session: SessionPayload | null): boolean {
  return isPlatformRole(session?.role);
}

/**
 * Runs an agency's own book.
 *
 * 🔴 This is a role test, NOT a tenant test. It says "this person operates an
 * agency", never "this person operates the agency that owns the thing you are
 * about to touch". The tenant check is `sessionMaySeeClient`, reached through
 * `requireClient` / `getClientForSession`, and a handler needs both.
 */
export function isAgencyOperator(session: SessionPayload | null): boolean {
  return isOperatorRole(session?.role);
}

/**
 * @deprecated Prefer `isAgencyOperator` (an agency's own book) or
 * `isSuperadmin` (across agencies). Kept while `staff` exists so the meaning of
 * each remaining call site is decided deliberately rather than in bulk.
 */
export function isStaff(session: SessionPayload | null): boolean {
  return session?.role === "staff";
}

/** `agencyGuard` for route handlers. Same contract as `staffGuard`. */
export async function agencyGuard(): Promise<NextResponse | null> {
  if (isAgencyOperator(await getSessionUser())) return null;
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/** For the handful of surfaces that are genuinely platform-wide. */
export async function superadminGuard(): Promise<NextResponse | null> {
  if (isSuperadmin(await getSessionUser())) return null;
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/**
 * Staff guard for route handlers: `const denied = await staffGuard(); if (denied) return denied;`
 *
 * Every staff-only handler must call this even though `src/proxy.ts` already
 * denies non-staff at the edge. Two reasons, both real:
 *
 *  1. The edge deny is a blanket rule over `/api/*`. The moment any path is
 *     carved out of it for client-role writes, every handler relying on that
 *     blanket becomes reachable — defence by accident, removed in one line.
 *  2. The proxy trusts the ROLE baked into the session token, which lives up to
 *     30 days (`session.ts`). This goes through `getSessionUser`, which re-reads
 *     role and status from the database, so a demoted or deactivated account
 *     loses API access on its next request rather than when its token expires.
 *
 * `src/lib/auth.test.ts` fails the build if a new handler omits it.
 */
export async function staffGuard(): Promise<NextResponse | null> {
  if (isStaff(await getSessionUser())) return null;
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/**
 * An agency operator may reach any slug their scoping allows; a client user
 * only their granted ones.
 *
 * ⚠️ Deliberately NOT a tenant check — it never sees an agency id. It is the
 * "is this one of yours" half, and it is only sound because every caller pairs
 * it with `getClientForSession`, which does the tenant half and returns null
 * across a boundary. On its own, an `agency` role passes for every slug in the
 * system, which is why this must never be the last word.
 */
export function canAccessSlug(
  session: SessionPayload | null,
  slug: string,
): boolean {
  if (!session) return false;
  return isAgencyOperator(session) || session.slugs.includes(slug);
}

/**
 * Guard for a route a CLIENT-role user is legitimately allowed to reach for
 * their own client — the branding asset route, and W3's branding editor.
 *
 * Not a weaker `staffGuard`, a differently-scoped one: it re-reads role and
 * status from the database on every call (via `getSessionUser`), so a demoted or
 * deactivated account loses access on its next request rather than whenever its
 * 30-day token happens to expire. The signed session's slug list is then checked
 * against the slug in the URL.
 *
 * Every route using this must ALSO be carved out of the proxy, which otherwise
 * 403s the entire `/api/` tree for client-role users — but the carve-out is not
 * the authorization. This is, and it holds even if the proxy rule is later
 * loosened by someone who has not read it.
 */
export async function clientAccessGuard(
  slug: string,
): Promise<NextResponse | null> {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canAccessSlug(session, slug)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * The one way an `/api/clients/[id]/*` handler should load its client.
 *
 * 🔴 Authorization and the tenant-scoped read, fused into a single call that
 * cannot be half-performed.
 *
 * The 29 routes under `/api/clients/[id]/` all had the same two-step shape —
 * `staffGuard()`, then an unscoped `getClientById(id)` — and in a single-tenant
 * world those two steps were one fact. They are not any more: the guard
 * establishes that the caller is somebody, and nothing at all established that
 * the client at `id` was theirs. Every one of those routes was an IDOR on a
 * guessed uuid.
 *
 * Fusing them is what keeps it fixed. A future route that copies its neighbour
 * gets both halves or neither, and there is no ordering to get wrong.
 *
 * Usage:
 *
 *   const got = await requireClient(id);
 *   if ("denied" in got) return got.denied;
 *   const { client, session } = got;
 *
 * The denial is 404 for both "no such client" and "not yours" — see the note on
 * `scoped()` in `clients.ts` for why distinguishing them would enumerate the
 * platform's customer list.
 */
export async function requireClient(
  id: string,
): Promise<
  { client: Client; session: SessionPayload } | { denied: NextResponse }
> {
  const session = await getSessionUser();
  if (!session) {
    return { denied: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  /*
   * 🔴 Still closed to `client`-role logins, exactly as `staffGuard()` was.
   *
   * These are agency-side management routes — trigger a sync, remap stages,
   * attach an ad account. Scoping without this check would have been a quiet
   * PRIVILEGE WIDENING: a client user would newly pass, for their own client,
   * routes that today they cannot reach at all. Adding tenant isolation must
   * not hand anybody a capability they did not have.
   */
  if (!isAgencyOperator(session)) {
    return { denied: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const client = await getClientByIdForSession(session, id);
  if (!client) {
    return { denied: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return { client, session };
}
