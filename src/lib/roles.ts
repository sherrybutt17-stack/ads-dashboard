import type { UserRole } from "@/db/schema";

/**
 * Who may hand out which role.
 *
 * ── Why this is its own module ───────────────────────────────────────────
 *
 * It began in `users.ts`, which imports `@/db` — so importing it from a test
 * opened a database connection and threw before a single assertion ran. The
 * same reason `client-scope.ts`, `password-policy.ts`, `platforms.ts` and
 * `stages.ts` exist: a rule that can only be exercised through a live database
 * gets verified by whoever is confident rather than by the test suite. The
 * schema import here is type-only, so nothing follows it at runtime.
 *
 * ── Why the rule matters more than it looks ──────────────────────────────
 *
 * 🔴 This is the escalation surface of the entire tenancy model. Every other
 * boundary asks "does this session's agency own this row". A role handed
 * upward changes the answer permanently: an `agency` operator who can mint a
 * `staff` login has not bypassed a check, they have left their tenancy through
 * the ordinary "add a teammate" form, and every access afterwards is
 * legitimately authorized.
 */
/**
 * Which roles a given role may hand out.
 *
 * Strictly downward: nobody creates a peer or a superior. `staff` is listed as
 * assignable only by the platform tier because it is the pre-tenancy
 * see-everything role, and an agency handing it out would be handing out the
 * whole database.
 */
export function assignableRoles(creator: UserRole | undefined): UserRole[] {
  switch (creator) {
    case "staff":
    case "superadmin":
      return ["superadmin", "agency", "client", "staff"];
    case "agency":
      return ["agency", "client"];
    default:
      return [];
  }
}

/**
 * May someone holding `caller` manage an existing login holding `target` —
 * disable it, remove it, change its dashboards, or send it a password link?
 *
 * 🔴 The same downward rule as creation, and the reason it has to be.
 *
 * `assignableRoles` stopped an `agency` operator from MAKING a `superadmin`.
 * Nothing stopped them from taking one over: the Users page let any operator
 * reset the password of any login in their agency, so an agency operator could
 * set a password on the superadmin sharing their agency, sign in as them, and
 * read every tenant in the database. Escalation by "reset password" instead of
 * by "create user" — the same escape through a different button.
 *
 * Managing a login is at least as powerful as creating it, so it gets the same
 * answer.
 */
export function mayAdminister(
  caller: UserRole | undefined,
  target: UserRole,
): boolean {
  return assignableRoles(caller).includes(target);
}

/**
 * Does this role operate an agency's book, rather than hold one dashboard?
 *
 * ── 🔴 Why this is here and not spelled out at each call site ─────────────
 *
 * `authorizeLayoutWrite` and `authorizeClientBrandingWrite` each asked
 * `session.role === "staff"` directly, because when they were written `staff`
 * was the ONLY operator role. After the tenancy migration added `agency` and
 * `superadmin`, both silently answered "no" for an agency operator — and since
 * an `agency` session carries no slugs (`auth.ts` populates them for the
 * `client` role only), the very next check refused them too. The result was a
 * flat 403: agency operators could not edit or reset any dashboard layout or
 * their clients' branding, on a role the whole migration exists to move toward.
 *
 * Nothing errored. The failure looked exactly like a permission working.
 *
 * ⚠️ This is a ROLE test, not a tenant test. It says "this person operates an
 * agency", never "the agency that owns the row you are about to write". Every
 * caller must still pair it with `getClientForSession` / `sessionMaySeeClient`.
 * `auth.ts` re-exports it as `isAgencyOperator` for session-shaped callers; this
 * module stays dependency-free so the rule is reachable from modules that must
 * not import a database.
 */
export function isOperatorRole(role: UserRole | string | undefined): boolean {
  return isPlatformRole(role) || role === "agency";
}

/**
 * Roles with platform-wide reach, across agency boundaries.
 *
 * `staff` is here because it is the pre-tenancy role and still means "sees
 * every row in the database". It leaves when it leaves the codebase — see the
 * note on `userRoleEnum`. Kept separate from `isCrossTenantRole` in
 * `client-scope.ts` deliberately: that one answers a TENANCY question and this
 * one a TIER question. They list the same roles today and are allowed to
 * diverge without one silently dragging the other with it.
 */
export function isPlatformRole(role: UserRole | string | undefined): boolean {
  return role === "staff" || role === "superadmin";
}
