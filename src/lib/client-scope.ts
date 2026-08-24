import type { SessionPayload } from "@/lib/session";

/**
 * May this session see this client? One rule, in one place, with no I/O.
 *
 * ── Why this is a separate module ────────────────────────────────────────
 *
 * Because the answer has to be testable without a database. Tenant isolation is
 * the kind of property that is easy to assert loudly and hard to verify, and a
 * rule reachable only through a live query gets tested by whoever is confident
 * rather than by the test suite. Dependency-free, exactly like `platforms.ts`,
 * `stages.ts` and `password-policy.ts`.
 *
 * ── The shape of the check ───────────────────────────────────────────────
 *
 * Three gates, narrowing:
 *
 *   1. A session at all. Anonymous sees nothing.
 *   2. The tenant, unless the role is explicitly allowed to cross it.
 *   3. The slug grant, for a `client`-role login that may hold one dashboard
 *      inside an agency that owns forty.
 *
 * Gate 3 is not redundant with gate 2. An agency's own client-role logins pass
 * the tenant check by construction — they belong to that agency — so without
 * the grant check, giving a client a login to their dashboard would give them
 * every other client of the same agency.
 */

/**
 * Roles that see across agencies.
 *
 * `staff` is here because it is the pre-tenancy role and still means "sees every
 * row in the database" — every `staffGuard()` call site checks for it. Removing
 * it from this set is not a tightening, it is a lockout: it would take the
 * operator's own access away before `superadmin` has been assigned to anyone.
 * `staff` leaves this list when it leaves the codebase, in one deliberate step.
 */
const CROSS_TENANT_ROLES = new Set(["staff", "superadmin"]);

/**
 * Exported so the SQL narrowing in `clients.ts` reads the same set.
 *
 * That query cannot import the rule itself — this module is deliberately free
 * of Drizzle — so it rebuilds the tenant predicate in SQL. Sharing at least the
 * escape hatch means adding a cross-tenant role is one edit here rather than
 * two edits that have to be found.
 */
export function isCrossTenantRole(role: string | undefined): boolean {
  return role !== undefined && CROSS_TENANT_ROLES.has(role);
}

/** The minimum of a client needed to decide. Structural, so callers keep `Client`. */
export interface ScopableClient {
  agencyId: string;
  slug: string;
}

export function sessionMaySeeClient(
  session: SessionPayload | null | undefined,
  client: ScopableClient,
): boolean {
  if (!session) return false;
  if (CROSS_TENANT_ROLES.has(session.role)) return true;
  if (session.agencyId !== client.agencyId) return false;
  /*
   * An `agency` login sees every client its agency owns; a `client` login sees
   * only what it was granted. Anything else is denied rather than defaulted —
   * a role added later without a rule here must not inherit agency-wide sight
   * by falling through.
   */
  if (session.role === "agency") return true;
  if (session.role === "client") return session.slugs.includes(client.slug);
  return false;
}

/**
 * Why a lookup is deliberately NOT scoped to a session.
 *
 * A closed set, not free text, so the reasons can be counted and reviewed.
 * Every one of these is a path where authorization genuinely came from
 * somewhere other than a login, and the alternative to naming them is an
 * `getClientById` that looks identical whether or not anyone checked.
 *
 *   webhook_token  — routed by the unguessable per-client token in the URL
 *   share_token    — a share link; the token IS the grant
 *   oauth_state    — mid-flow, authorized by the HMAC-signed state cookie
 *   cron           — no user; the job iterates every tenant on purpose
 *   system         — internal machinery with no request behind it
 */
export type UnscopedReason =
  | "webhook_token"
  | "share_token"
  | "oauth_state"
  | "cron"
  | "system";
