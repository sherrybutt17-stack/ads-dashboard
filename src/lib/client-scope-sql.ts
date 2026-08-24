import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { clients } from "@/db/schema";
import { isCrossTenantRole } from "@/lib/client-scope";
import type { SessionPayload } from "@/lib/session";

/**
 * The tenant rule again, as SQL — narrowing only, never the decision.
 *
 * ── 🔴 Read this before changing it ──────────────────────────────────────
 *
 * `sessionMaySeeClient` remains the authority, and still runs on every row the
 * queries in `clients.ts` return. This predicate exists so the DATABASE stops
 * handing back forty agencies' clients to answer one agency's dashboard —
 * `listClientsForSession` previously selected every client row on the platform
 * and filtered in memory. That was correct and unscalable, and it also meant a
 * single missing `.filter()` in a future caller would have served the whole
 * table.
 *
 * The two checks are deliberately redundant, and the redundancy is
 * one-directional. If they ever disagree, this one is either too NARROW (a row
 * goes missing — visible, annoying, safe) or too WIDE (the in-memory check
 * still rejects it — invisible, wasteful, safe). Neither drift serves a row to
 * the wrong tenant. `client-scope-sql.test.ts` runs both over the same fixture
 * matrix in a real Postgres and asserts they agree exactly.
 *
 * ── Why it is not in `client-scope.ts` ───────────────────────────────────
 *
 * That module is dependency-free on purpose: it holds the one rule that must be
 * verifiable without a database, and importing Drizzle into it would put that
 * rule behind an import chain. This module imports only table definitions —
 * `@/db/schema` opens no connection, unlike `@/db` — so it stays testable
 * against PGlite.
 */
export function clientScopeFilter(session: SessionPayload): SQL | undefined {
  /*
   * `undefined`, not `sql\`true\``: Drizzle's `and()` drops undefined operands,
   * so a cross-tenant role composes with a caller's own WHERE cleanly instead
   * of appending a redundant clause to every query.
   */
  if (isCrossTenantRole(session.role)) return undefined;

  /*
   * No tenant, no rows — and specifically not a crash.
   *
   * `SessionPayload.agencyId` is the empty string for the pre-tenancy
   * shared-password bootstrap, whose role is cross-tenant and so never reaches
   * here. If any other role ever arrives without one, `clients.agency_id` is a
   * uuid column and Postgres answers `invalid input syntax for type uuid: ""` —
   * a 500 on the client list rather than an empty one. Deny is the correct
   * reading of "belongs to no agency" either way.
   */
  if (!session.agencyId) return sql`false`;

  const tenant = eq(clients.agencyId, session.agencyId);
  if (session.role !== "client") return tenant;

  /*
   * A `client` login with no grants sees nothing.
   *
   * Spelled out rather than left to `inArray(col, [])`, whose behaviour has
   * changed across Drizzle versions — some throw, some emit invalid `in ()`.
   * The one reading that must never happen is "empty list, so no filter", and
   * that is exactly what a silent failure here would produce.
   */
  if (session.slugs.length === 0) return sql`false`;
  return and(tenant, inArray(clients.slug, session.slugs));
}
