import { and, asc, eq, gt, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agencyEmailDomains, type AgencyEmailDomainRow } from "@/db/schema";
import * as audit from "@/lib/audit";
import { DOMAIN_EXPIRY_DAYS, type DnsRecord, type DomainView } from "./identity";
import type { ResendDomain } from "./resend-domains";

/**
 * The `agency_email_domains` row: reading it, and the few ways it changes.
 *
 * 🔴 The read that the SEND path uses never throws. A missing table (code
 * deployed before migration 0031), a dropped connection, a bad id — each of
 * them reads as "no domain", and the email goes from our address under the
 * agency's name. A password reset must not fail because a settings table did.
 * Writes do throw: they come from the Email domain tab, where the operator is
 * waiting for an answer and needs to see that it did not save.
 */

const EXPIRY_MS = DOMAIN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export async function getAgencyDomain(agencyId: string): Promise<AgencyEmailDomainRow | null> {
  try {
    const [row] = await db
      .select()
      .from(agencyEmailDomains)
      .where(eq(agencyEmailDomains.agencyId, agencyId))
      .limit(1);
    return row ?? null;
  } catch (err) {
    console.error("[email-domains] domain lookup failed", err);
    return null;
  }
}

export async function insertAgencyDomain(values: {
  agencyId: string;
  domain: string;
  resendDomainId: string;
  status: string;
  records: DnsRecord[];
  fromLocal: string;
  fromName: string | null;
  replyTo: string | null;
  createdBy: string | null;
}): Promise<AgencyEmailDomainRow> {
  const now = new Date();
  const [row] = await db
    .insert(agencyEmailDomains)
    .values({ ...values, checkedAt: now, createdAt: now, updatedAt: now })
    .returning();
  return row;
}

export async function updateSenderDetails(
  agencyId: string,
  patch: { fromLocal?: string; fromName?: string | null; replyTo?: string | null },
): Promise<AgencyEmailDomainRow | null> {
  const [row] = await db
    .update(agencyEmailDomains)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(agencyEmailDomains.agencyId, agencyId))
    .returning();
  return row ?? null;
}

/**
 * Store what Resend says about a domain now.
 *
 * Scoped to the Resend id as well as the agency, so a check that started before
 * the agency removed the domain and added another cannot write the old domain's
 * status onto the new one.
 *
 * The first `verified` stamps `verified_at` — which never clears, and is what
 * stops expiry from ever touching a domain that has worked — and is audited:
 * it is the moment this agency's mail started leaving under its own name.
 */
export async function applyResendStatus(
  row: AgencyEmailDomainRow,
  fetched: Pick<ResendDomain, "status" | "records">,
  now: Date = new Date(),
): Promise<AgencyEmailDomainRow> {
  const verified = fetched.status === "verified";
  const firstTime = verified && !row.verifiedAt;
  const [updated] = await db
    .update(agencyEmailDomains)
    .set({
      status: fetched.status,
      records: fetched.records,
      checkedAt: now,
      updatedAt: now,
      ...(verified ? { lastError: null } : {}),
      ...(firstTime ? { verifiedAt: now } : {}),
    })
    .where(
      and(
        eq(agencyEmailDomains.agencyId, row.agencyId),
        eq(agencyEmailDomains.resendDomainId, row.resendDomainId),
      ),
    )
    .returning();

  if (firstTime && updated) {
    void audit.record({
      action: "agency.email_domain_verified",
      targetType: "agency",
      targetId: row.agencyId,
      agencyId: row.agencyId,
      metadata: { domain: row.domain },
    });
  }
  return updated ?? row;
}

/**
 * A send from this domain was refused as unverified: stop using it until a
 * check says otherwise. Only ever moves `verified` to `recheck` — a domain that
 * was already not sending has nothing to stop. `checked_at` is cleared so the
 * next hourly pass looks at it first. Never throws: it runs after the email has
 * already gone from our address, and its failure must not undo that.
 */
export async function markRecheck(agencyId: string, reason: string): Promise<void> {
  try {
    await db
      .update(agencyEmailDomains)
      .set({ status: "recheck", lastError: reason.slice(0, 500), checkedAt: null, updatedAt: new Date() })
      .where(and(eq(agencyEmailDomains.agencyId, agencyId), eq(agencyEmailDomains.status, "verified")));
  } catch (err) {
    console.error("[email-domains] could not mark a domain for re-check", err);
  }
}

export async function deleteAgencyDomain(agencyId: string): Promise<void> {
  await db.delete(agencyEmailDomains).where(eq(agencyEmailDomains.agencyId, agencyId));
}

/**
 * Release a never-verified domain — only if it is still that domain and still
 * never verified, so a check that verified it a moment ago wins the race.
 */
export async function releaseExpiredDomain(row: AgencyEmailDomainRow): Promise<boolean> {
  const gone = await db
    .delete(agencyEmailDomains)
    .where(
      and(
        eq(agencyEmailDomains.agencyId, row.agencyId),
        eq(agencyEmailDomains.resendDomainId, row.resendDomainId),
        isNull(agencyEmailDomains.verifiedAt),
      ),
    )
    .returning({ agencyId: agencyEmailDomains.agencyId });
  return gone.length > 0;
}

/**
 * Domains worth asking Resend about: anything not verified, except a
 * never-verified claim past its expiry (that one is released instead). The
 * longest-unchecked first, so a busy hour still reaches every domain in turn.
 */
export async function domainsToRefresh(limit: number, now: Date = new Date()): Promise<AgencyEmailDomainRow[]> {
  return db
    .select()
    .from(agencyEmailDomains)
    .where(
      and(
        ne(agencyEmailDomains.status, "verified"),
        or(
          isNotNull(agencyEmailDomains.verifiedAt),
          gt(agencyEmailDomains.createdAt, new Date(now.getTime() - EXPIRY_MS)),
        ),
      ),
    )
    .orderBy(sql`${agencyEmailDomains.checkedAt} ASC NULLS FIRST`, asc(agencyEmailDomains.createdAt))
    .limit(limit);
}

/** Never verified, and added more than `DOMAIN_EXPIRY_DAYS` ago. */
export async function expiredDomains(now: Date = new Date()): Promise<AgencyEmailDomainRow[]> {
  return db
    .select()
    .from(agencyEmailDomains)
    .where(
      and(
        isNull(agencyEmailDomains.verifiedAt),
        ne(agencyEmailDomains.status, "verified"),
        lte(agencyEmailDomains.createdAt, new Date(now.getTime() - EXPIRY_MS)),
      ),
    );
}

function storedRecords(value: unknown): DnsRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is DnsRecord =>
      Boolean(r) && typeof r === "object" && typeof (r as DnsRecord).name === "string" && typeof (r as DnsRecord).value === "string",
  );
}

/** The row as the Email domain tab sees it — dates as strings, no ids. */
export function toDomainView(row: AgencyEmailDomainRow): DomainView {
  return {
    domain: row.domain,
    status: row.status,
    records: storedRecords(row.records),
    fromLocal: row.fromLocal,
    fromName: row.fromName,
    replyTo: row.replyTo,
    lastError: row.lastError,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    checkedAt: row.checkedAt?.toISOString() ?? null,
    expiresAt: row.verifiedAt ? null : new Date(row.createdAt.getTime() + EXPIRY_MS).toISOString(),
  };
}
