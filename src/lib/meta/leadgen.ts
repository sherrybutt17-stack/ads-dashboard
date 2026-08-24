import { MetaApiError, MetaClient } from "./client";

/**
 * Recovering attribution for native Instant Form leads.
 *
 * ── The gap this closes ───────────────────────────────────────────────
 *
 * Per-campaign reporting works by reading ids out of the landing-page URL: the
 * ad carries `utm_id`, `ad_id` and so on, the browser passes them to the form,
 * and GoHighLevel stores them on the contact. A **native Lead Ad** has no
 * landing page and no URL — the form opens inside Facebook — so that entire
 * path is absent and every such lead arrives unattributed. No amount of URL
 * tagging fixes it, because there is no URL to tag.
 *
 * What those leads DO carry is a leadgen id, which Meta will resolve back to the
 * ad, ad set and campaign that produced it. That is the only route, and it is
 * what this file is.
 *
 * ── 🔴 It probably will not work with the token this app holds ─────────
 *
 * Reading `GET /{leadgen_id}` needs `leads_retrieval`, and the system user token
 * here is provisioned `ads_read` only. Reading a lead means reading the personal
 * details someone typed into a form, which Meta gates separately and more
 * tightly than ad statistics — reasonably so.
 *
 * That is not a reason to skip building it, but it IS a reason not to let it
 * fail quietly: an attribution repair that silently writes nothing looks
 * identical to one that found nothing to repair, and the operator would conclude
 * their Instant Form leads simply have no data. So a permission failure is
 * detected specifically, reported as `permission`, and named in the output with
 * the scope that would fix it.
 *
 * ── Idempotent by construction ────────────────────────────────────────
 *
 * The resolver only reads. Nothing here writes to the database; the caller
 * decides, and the caller only ever fills a column that is null. A lead's
 * originating ad cannot change after the fact, so a value already present is
 * never worth overwriting with a second opinion.
 */

export interface LeadgenAttribution {
  leadId: string;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  /** Meta's own timestamp for the submission, ISO. */
  createdTime: string | null;
}

export type LeadgenFailure =
  /** The token lacks `leads_retrieval`. Every id will fail the same way. */
  | "permission"
  /** The id does not resolve — deleted, or from another business. */
  | "not_found"
  /** Rate limited or transient. Worth retrying later. */
  | "transient"
  | "unknown";

export interface LeadgenResult {
  resolved: LeadgenAttribution[];
  failures: Array<{ leadId: string; reason: LeadgenFailure; message: string }>;
}

/**
 * A leadgen id, as far as we can tell one.
 *
 * Purely numeric and long. The check exists because this value is interpolated
 * into a Graph API path: anything else must not reach the request, and a form
 * field carrying free text is exactly the sort of thing that ends up in this
 * column.
 */
export function isLeadgenId(v: string | null | undefined): v is string {
  return typeof v === "string" && /^\d{6,25}$/.test(v.trim());
}

/**
 * Classify a Meta error into something the caller can act on.
 *
 * The permission case is the one that matters — see the header. Meta reports a
 * missing scope as code 10 or code 200 (both "permission"), and code 100 with
 * subcode 33 for an object the token cannot see, which for our purposes is the
 * same conversation: the token is not allowed to read this.
 */
export function classifyLeadgenError(err: unknown): {
  reason: LeadgenFailure;
  message: string;
} {
  if (!(err instanceof MetaApiError)) {
    return { reason: "unknown", message: String(err) };
  }
  const message = err.message;
  if (err.code === 10 || err.code === 200) return { reason: "permission", message };
  if (err.code === 100 && err.subcode === 33) {
    return { reason: "permission", message };
  }
  if (err.code === 100) return { reason: "not_found", message };
  if (err.isRateLimit || err.status >= 500) {
    return { reason: "transient", message };
  }
  return { reason: "unknown", message };
}

/**
 * Resolve leadgen ids to the ad that produced each one.
 *
 * Serial rather than parallel, matching the rest of the Meta client: Meta warns
 * explicitly that concurrent bursts are likelier to trip rate limiting, and this
 * runs as a backfill where wall-clock time is worth nothing.
 *
 * 🔴 **Stops on the first permission error.** With no `leads_retrieval` every id
 * fails identically, so continuing would issue one doomed request per lead — a
 * few thousand calls that achieve nothing except burning the account's rate
 * budget and possibly tripping a temporary block that affects the nightly sync.
 * One failure is enough evidence.
 */
export async function resolveLeadgen(
  leadIds: readonly string[],
  /*
   * One or the other, not "maybe neither". The old shape defaulted to `{}` and
   * let `MetaClient` reach for the shared system-user token — which is exactly
   * the fallback that made any agency able to read any account our system user
   * could see. There is no token to default to now, so the caller names one.
   */
  opts: { client: MetaClient } | { token: string },
): Promise<LeadgenResult> {
  const client = "client" in opts ? opts.client : new MetaClient(opts.token);
  const resolved: LeadgenAttribution[] = [];
  const failures: LeadgenResult["failures"] = [];

  for (const raw of leadIds) {
    const leadId = raw.trim();
    if (!isLeadgenId(leadId)) {
      failures.push({
        leadId: raw,
        reason: "not_found",
        message: "Not a leadgen id",
      });
      continue;
    }

    try {
      const row = await client.getLeadgen(leadId);
      resolved.push({
        leadId,
        adId: row.ad_id ?? null,
        adsetId: row.adset_id ?? null,
        campaignId: row.campaign_id ?? null,
        createdTime: row.created_time ?? null,
      });
    } catch (err) {
      const classified = classifyLeadgenError(err);
      failures.push({ leadId, ...classified });
      if (classified.reason === "permission") break;
    }
  }

  return { resolved, failures };
}

/**
 * Did the whole run fail for one reason, rather than lead by lead?
 *
 * Used to phrase the outcome. "The token cannot read leads" is a different
 * message from "3 of 40 leads could not be found", and conflating them would
 * send someone hunting for missing leads when the fix is a scope.
 */
export function isBlockedByPermission(result: LeadgenResult): boolean {
  return (
    result.resolved.length === 0 &&
    result.failures.some((f) => f.reason === "permission")
  );
}
