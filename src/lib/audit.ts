import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, clients } from "@/db/schema";

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
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function record(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      clientId: entry.clientId ?? null,
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
 * `category` filters by action prefix (e.g. "auth", "meta_account").
 */
export async function listAuditEntries(
  opts: { limit?: number; category?: string } = {},
): Promise<AuditView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const where = opts.category
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
    .where(where)
    .orderBy(desc(auditLog.at))
    .limit(limit);
}
