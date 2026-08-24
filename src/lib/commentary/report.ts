import type { Client } from "@/db/schema";
import type { AdPlatform } from "@/lib/metrics/queries";
import { getPeriodMetrics, type PeriodMetrics } from "@/lib/metrics/queries";
import { windowFromKeys } from "@/lib/dates";
import {
  monthBounds,
  resolveAccountability,
  type Accountability,
  type Commitment,
  type MetricSource,
} from "./model";
import {
  getCommentary,
  getPublishedMonths,
  type StoredCommentary,
} from "./store";

/**
 * Joining the written commentary to the figures that judge it.
 *
 * The month's figures come from `getPeriodMetrics` — the same function behind
 * the month-on-month table, the moving averages and every KPI tile — rather
 * than from anything written for this feature. If a target says "cost per lead
 * at most $40" and the month-on-month row says $47, the accountability panel
 * must say $47 too. Two implementations of "August's cost per lead" is how a
 * report ends up contradicting itself on the same page.
 */

/**
 * A month's figures, or `null` if they could not be fetched.
 *
 * Explicitly nullable rather than falling back to zeroes: zeroes would judge
 * every target as missed, and reporting a database outage to a client as an
 * agency's failure is worse than reporting nothing.
 */
async function monthActuals(
  client: Client,
  platform: AdPlatform,
  month: string,
): Promise<PeriodMetrics | null> {
  try {
    const { startKey, endKey } = monthBounds(month);
    return await getPeriodMetrics(
      client.id,
      windowFromKeys(startKey, endKey, client.timezone),
      month,
      undefined,
      { mode: client.paidLeadFilter, tag: client.paidLeadTag },
      platform,
      /*
       * Revenue is opted in because a target may be set on revenue or ROAS, and
       * `getPeriodMetrics` skips that second round trip by default. This whole
       * call only happens when a prior commitment carries a target at all.
       */
      true,
    );
  } catch (err) {
    console.error("[commentary] month figures unavailable:", err);
    return null;
  }
}

/** Are any of these commitments answerable by arithmetic? */
function anyTargeted(commitments: readonly Commitment[]): boolean {
  return commitments.some((c) => c.target !== null);
}

export interface CommentaryForReport {
  month: string;
  did: string;
  /** The plan for next month, as published. */
  commitments: Commitment[];
  /** Last month's plan, judged. Null when there was no published plan. */
  accountability: Accountability | null;
  currency: string;
}

/**
 * Everything the client-facing report may show for a month.
 *
 * Reads only frozen text, at both ends: this month's published commentary, and
 * the previous month's published commitments. Returns `null` when nothing has
 * been published for the month, so the section is absent rather than empty.
 */
export async function loadCommentaryForReport(
  client: Client,
  platform: AdPlatform,
  month: string,
): Promise<CommentaryForReport | null> {
  const { current, prior } = await getPublishedMonths({
    clientId: client.id,
    platform,
    month,
  });
  if (!current) return null;

  const accountability = prior
    ? resolveAccountability({
        priorMonth: prior.month,
        priorCommitments: prior.commitments,
        outcomes: current.outcomes,
        actuals: anyTargeted(prior.commitments)
          ? await monthActuals(client, platform, month)
          : null,
      })
    : null;

  return {
    month,
    did: current.did,
    commitments: current.commitments,
    /*
     * A prior month with an empty published plan produces an accountability
     * block with no items; the renderer drops it. Kept as a distinct case from
     * `null` so "they published a plan and it had nothing in it" is
     * distinguishable in a test from "there was no prior month".
     */
    accountability: accountability && accountability.total > 0 ? accountability : null,
    currency: client.metaCurrency ?? "USD",
  };
}

export interface CommentaryForEditor {
  month: string;
  current: StoredCommentary | null;
  prior: {
    month: string;
    commitments: Commitment[];
    /** False when last month's plan exists but was never published. */
    published: boolean;
  } | null;
  /** This month's figures, for judging last month's targets live as they type. */
  actuals: MetricSource | null;
  currency: string;
  error: string | null;
}

/**
 * The agency's editing view: the working copy, plus the previous month's
 * published plan and this month's figures so the derived verdicts are visible
 * while the commentary is being written.
 */
export async function loadCommentaryForEditor(
  client: Client,
  platform: AdPlatform,
  month: string,
): Promise<CommentaryForEditor> {
  const { current, prior, error } = await getCommentary({
    clientId: client.id,
    platform,
    month,
  });

  const actuals =
    prior && anyTargeted(prior.commitments)
      ? await monthActuals(client, platform, month)
      : null;

  return {
    month,
    current,
    prior,
    actuals,
    currency: client.metaCurrency ?? "USD",
    error,
  };
}
