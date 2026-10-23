import type { AgencyEmailDomainRow } from "@/db/schema";
import { agencyEmailConfigured } from "@/lib/reports/email";
import * as audit from "@/lib/audit";
import { deleteDomain, getDomain, verifyDomain } from "./resend-domains";
import {
  applyResendStatus,
  domainsToRefresh,
  expiredDomains,
  releaseExpiredDomain,
} from "./store";

/**
 * Keeping each domain's status current without anyone watching the tab.
 *
 * An agency adds its records, presses Check now, sees "Checking" and closes the
 * tab. DNS takes its time, and without this its mail would keep going from our
 * address until someone happened to reopen Settings. The hourly report job runs
 * `refreshDomains` first, so a domain starts sending under its own name within
 * the hour of DNS catching up.
 *
 * Resend only checks a domain when asked to, so anything not already mid-check
 * is asked again (`verify`) before its status is read. A `pending` domain is
 * mid-check and is only read.
 */

/** Ask Resend (optionally to check again), then store its answer. Throws on failure. */
export async function refreshDomain(
  row: AgencyEmailDomainRow,
  opts: { verify?: boolean; timeoutMs?: number } = {},
): Promise<AgencyEmailDomainRow> {
  if (opts.verify) await verifyDomain(row.resendDomainId, opts.timeoutMs);
  const fetched = await getDomain(row.resendDomainId, opts.timeoutMs);
  return applyResendStatus(row, fetched);
}

/**
 * For the Email domain page: re-read an unverified domain from Resend before
 * showing it, unless it was read within `afterMs` — every agency shares one
 * Resend team, and reloading the page should not spend its rate limit. Never
 * throws: a slow or failing Resend shows the last known status instead.
 */
export async function freshenForDisplay(
  row: AgencyEmailDomainRow,
  opts: { afterMs?: number; timeoutMs?: number } = {},
): Promise<AgencyEmailDomainRow> {
  if (row.status === "verified") return row;
  if (row.checkedAt && Date.now() - row.checkedAt.getTime() <= (opts.afterMs ?? 30_000)) return row;
  return refreshDomain(row, { timeoutMs: opts.timeoutMs ?? 3_000 }).catch((err) => {
    console.error(`[email-domains] could not refresh ${row.domain} for display`, err);
    return row;
  });
}

export interface RefreshSummary {
  checked: number;
  verified: number;
  expired: number;
  errors: number;
}

/**
 * One pass: release expired claims, then re-check what is unverified.
 *
 * Never throws — it runs at the top of the report job, and one domain's DNS
 * must not stop anyone's report. Bounded twice: by `budgetMs` between domains,
 * and by each request's own timeout within one.
 *
 * Expiry is what keeps the one-agency-per-domain rule from being a way to
 * squat: a domain someone added and never proved is released after
 * `DOMAIN_EXPIRY_DAYS`, in Resend first and then here. If Resend refuses the
 * delete, the row stays and the next pass tries again, rather than leaving a
 * claim in Resend that nothing here knows about.
 */
export async function refreshDomains(opts: {
  budgetMs: number;
  limit?: number;
  now?: Date;
}): Promise<RefreshSummary> {
  const summary: RefreshSummary = { checked: 0, verified: 0, expired: 0, errors: 0 };
  if (!agencyEmailConfigured()) return summary;

  const started = Date.now();
  const now = opts.now ?? new Date();
  const outOfTime = () => Date.now() - started > opts.budgetMs;

  try {
    for (const row of await expiredDomains(now)) {
      if (outOfTime()) return summary;
      try {
        await deleteDomain(row.resendDomainId);
        if (await releaseExpiredDomain(row)) {
          summary.expired++;
          void audit.record({
            action: "agency.email_domain_expired",
            targetType: "agency",
            targetId: row.agencyId,
            agencyId: row.agencyId,
            metadata: { domain: row.domain },
          });
        }
      } catch (err) {
        summary.errors++;
        console.error(`[email-domains] could not release ${row.domain}`, err);
      }
    }

    for (const row of await domainsToRefresh(opts.limit ?? 20, now)) {
      if (outOfTime()) return summary;
      try {
        const updated = await refreshDomain(row, {
          verify: row.status !== "pending",
          timeoutMs: 5_000,
        });
        summary.checked++;
        if (updated.status === "verified") summary.verified++;
      } catch (err) {
        summary.errors++;
        console.error(`[email-domains] could not check ${row.domain}`, err);
      }
    }
  } catch (err) {
    // The table itself (migration not applied) or the database. Nothing to do
    // this hour; the report job carries on.
    summary.errors++;
    console.error("[email-domains] refresh pass failed", err);
  }
  return summary;
}
