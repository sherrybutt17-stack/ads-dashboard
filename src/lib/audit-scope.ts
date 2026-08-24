import { eq, type SQL } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { isCrossTenantRole } from "@/lib/client-scope";
import type { SessionPayload } from "@/lib/session";

/**
 * Which audit entries a session may read.
 *
 * Its own module for the reason `client-scope-sql.ts` is: `lib/audit.ts`
 * imports `@/db`, which opens a connection at import time, so a rule left in
 * there can only be tested with a live database — and a tenant boundary that is
 * awkward to test is one that gets verified by whoever is confident. This
 * imports table definitions only.
 */

/**
 * `"none"` is a third answer, distinct from `undefined`.
 *
 * 🔴 `undefined` means "no filter" to Drizzle's `and()`, so a function
 * returning it for a denied session would return the WHOLE TABLE — the failure
 * is silent, total, and looks like ordinary code. The two cases are therefore
 * different types, and the caller cannot use the deny value as a predicate by
 * accident.
 */
export type AuditScope = SQL | undefined | "none";

export function auditScope(session: SessionPayload | null): AuditScope {
  if (!session) return "none";

  // Superadmin and staff read everything, untenanted rows included — a failed
  // login for an unknown address is visible nowhere else.
  if (isCrossTenantRole(session.role)) return undefined;

  /*
   * Only the agency tier reads its own trail. A `client`-role login is a
   * customer of a customer: they can see their dashboard, not the record of who
   * changed its credentials. Denied by default rather than by omission, so a
   * role added later does not inherit access by falling through.
   */
  if (session.role !== "agency") return "none";
  if (!session.agencyId) return "none";

  /*
   * 🔴 `agency_id = $1` excludes NULL, and that is the point rather than an
   * accident of SQL. NULL means "platform-level, no tenant" — a failed login
   * for an address matching no account, a signup throttled before any agency
   * existed. Reading NULL as "unknown, show it anyway" would hand every agency
   * the platform's untenanted security events.
   */
  return eq(auditLog.agencyId, session.agencyId);
}
