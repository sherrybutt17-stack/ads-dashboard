import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, clients } from "@/db/schema";
import { agencyIdForClient } from "@/lib/tenancy";
import { auditScope } from "@/lib/audit-scope";
import type { SessionPayload } from "@/lib/session";

/**
 * Security & accountability audit trail.
 *
 * `record()` is fire-and-forget and swallows its own errors — a logging failure
 * must NEVER break the operation it is recording. Call it after the action has
 * succeeded (or, for failures, at the point of rejection).
 */

export interface AuditEntry {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  clientId?: string | null;
  /**
   * The tenant this event belongs to.
   *
   * Optional because most call sites do not need to pass it: an entry naming a
   * client has its agency derived below. Pass it explicitly for events with no
   * client — a login, a teammate invited, a password reset — where the session
   * is the only thing that knows the tenant.
   */
  agencyId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function record(entry: AuditEntry): Promise<void> {
  try {
    /*
     * Derived rather than required, so 46 existing call sites did not each have
     * to be edited to thread a tenant through — and, more to the point, so a
     * NEW call site cannot forget to. An entry that names a client always
     * belongs to that client's agency; there is no case where it does not.
     *
     * The cost is one indexed primary-key lookup on a path that is already
     * fire-and-forget and already off the response's critical path. An entry
     * filed under the wrong tenant — or under none, invisible to the agency it
     * concerns — is worth more than that query.
     */
    const agencyId =
      entry.agencyId ??
      (entry.clientId ? await agencyIdForClient(entry.clientId) : null);

    await db.insert(auditLog).values({
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      clientId: entry.clientId ?? null,
      agencyId,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    console.error(`[audit] failed to record "${entry.action}":`, err);
  }
}

/** Extract best-effort request forensics (source IP + user agent). */
export function requestContext(req: Request): {
  ip: string | null;
  userAgent: string | null;
} {
  const xff = req.headers.get("x-forwarded-for");
  const ip = xff
    ? xff.split(",")[0]!.trim()
    : (req.headers.get("x-real-ip")?.trim() ?? null);
  return { ip, userAgent: req.headers.get("user-agent") };
}

/* ------------------------------------------------------------------ *
 * Reading — powers the admin view
 * ------------------------------------------------------------------ */

export interface AuditView {
  id: string;
  at: Date;
  action: string;
  targetType: string | null;
  targetId: string | null;
  clientId: string | null;
  clientName: string | null;
  ip: string | null;
  metadata: unknown;
}

/**
 * Recent audit entries, newest first, with the client name resolved.
 *
 * `category` filters by action prefix (e.g. "auth", "meta_account"). The
 * session is required rather than optional — an audit reader that defaults to
 * unscoped when nobody passes one is the failure this signature prevents.
 */
export async function listAuditEntries(
  session: SessionPayload | null,
  opts: { limit?: number; category?: string } = {},
): Promise<AuditView[]> {
  const scope = auditScope(session);
  if (scope === "none") return [];

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const category = opts.category
    ? sql`${auditLog.action} LIKE ${opts.category + ".%"}`
    : undefined;

  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      clientId: auditLog.clientId,
      clientName: clients.name,
      ip: auditLog.ip,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .leftJoin(clients, eq(clients.id, auditLog.clientId))
    .where(and(category, scope))
    .orderBy(desc(auditLog.at))
    .limit(limit);
}
