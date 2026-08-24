import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { adBudgets, type Client } from "@/db/schema";
import type { AdPlatform } from "@/lib/platforms";
import {
  currentMonthKey,
  monthShape,
  trailingMonths,
  windowFromKeys,
  shiftDateKey,
} from "@/lib/dates";
import {
  getAdTotals,
  getGoogleAccountSummary,
  getMonthlySpend,
  getTiktokCurrencies,
} from "@/lib/metrics/queries";
import { loadForecast } from "@/lib/metrics/forecast-load";
import { getAdPipeStatus } from "@/lib/metrics/pipe-status";
import type { AdPipeState } from "@/lib/metrics/pipe-state";
import type { ForecastReport } from "@/lib/metrics/forecast";
import { budgetForMonth, computePacing, type Pacing } from "@/lib/metrics/pacing";
import {
  buildBudgetHistory,
  EMPTY_BUDGET_HISTORY,
  type BudgetHistory,
} from "@/lib/metrics/budget-history";

/**
 * Reading and writing the monthly budget agreements, and turning them into
 * pacing.
 *
 * The arithmetic lives in `metrics/pacing.ts` and is pure; this module's whole
 * job is to hand it honest inputs. One of those inputs is subtle enough to be
 * the reason this file exists rather than the query being inlined at the call
 * site: pacing needs month-to-date spend TWICE, once including today and once
 * excluding it, because today is a partial figure that must not reach the run
 * rate. See the note at the top of `pacing.ts`.
 */

export interface BudgetRow {
  id: string;
  effectiveFrom: string;
  monthlyAmount: number | null;
  updatedAt: Date;
  updatedBy: string | null;
}

/** Every budget agreement on file for a client's platform, oldest first. */
export async function listBudgets(
  clientId: string,
  platform: AdPlatform,
): Promise<BudgetRow[]> {
  const rows = await db
    .select()
    .from(adBudgets)
    .where(and(eq(adBudgets.clientId, clientId), eq(adBudgets.platform, platform)))
    .orderBy(asc(adBudgets.effectiveFrom));

  return rows.map((r) => ({
    id: r.id,
    effectiveFrom: r.effectiveFrom,
    // `numeric` comes back as a string — cast on read, exactly as the ad
    // metrics do, so no float ever reaches the pacing arithmetic as a string.
    monthlyAmount: r.monthlyAmount === null ? null : Number(r.monthlyAmount),
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  }));
}

/**
 * Record an agreement effective from a month.
 *
 * Upserts on `(client, platform, effective_from)`: correcting a figure someone
 * typed wrong must fix that agreement, not stack a second row alongside it
 * where the older one would silently win or lose depending on read order.
 */
export async function setBudget(opts: {
  clientId: string;
  platform: AdPlatform;
  effectiveFrom: string;
  monthlyAmount: number | null;
  updatedBy: string | null;
}): Promise<void> {
  const amount =
    opts.monthlyAmount === null ? null : opts.monthlyAmount.toFixed(2);

  await db
    .insert(adBudgets)
    .values({
      clientId: opts.clientId,
      platform: opts.platform,
      effectiveFrom: opts.effectiveFrom,
      monthlyAmount: amount,
      updatedBy: opts.updatedBy,
    })
    .onConflictDoUpdate({
      target: [adBudgets.clientId, adBudgets.platform, adBudgets.effectiveFrom],
      set: {
        monthlyAmount: amount,
        updatedAt: new Date(),
        updatedBy: opts.updatedBy,
      },
    });
}

/** Remove an agreement entirely — distinct from setting its amount to null. */
export async function deleteBudget(
  clientId: string,
  platform: AdPlatform,
  effectiveFrom: string,
): Promise<void> {
  await db
    .delete(adBudgets)
    .where(
      and(
        eq(adBudgets.clientId, clientId),
        eq(adBudgets.platform, platform),
        eq(adBudgets.effectiveFrom, effectiveFrom),
      ),
    );
}

export interface MonthPacing extends Pacing {
  monthKey: string;
  /**
   * The currency the budget and the spend are both in.
   *
   * Resolved per platform rather than taken from `clients.metaCurrency`, which
   * is Meta's alone: a TikTok budget labelled with the Meta account's symbol
   * would not be a display slip but a comparison between two different
   * currencies presented as one number.
   */
  currency: string;
  /** True while this is the month currently running, in the client's tz. */
  isCurrentMonth: boolean;
  /**
   * The state of the pipe these figures came out of.
   *
   * 🔴 Pacing divides RECORDED spend by an agreed budget, and a broken sync
   * records no spend. So a dead pipe and a paused ad account produce the same
   * number, and the confident reading of that number — "underspending by
   * £1,200" — is exactly wrong: the money may well have been spent and simply
   * not fetched. That is the failure this whole product replaced a spreadsheet
   * to avoid, arriving through a new panel.
   *
   * `spendTrusted` is false whenever the platform cannot be reached, has never
   * synced, or is still backfilling. The verdict is still computed — the numbers
   * are what they are — but every surface must withhold it and say why instead.
   */
  pipeState: AdPipeState;
  spendTrusted: boolean;
}

export interface LoadPacingOptions {
  /** Defaults to the month currently running in the client's timezone. */
  monthKey?: string;
  /**
   * An already-loaded forecast, when the caller has one.
   *
   * The dashboard loads `loadForecast` for its own panel, so passing it here
   * costs nothing and guarantees the pacing meter and "Where this month lands"
   * quote the same month-end figure. Omitted, this loads its own; a closed
   * month never loads one at all, because a forecast is only about the month in
   * progress and a finished month's projection is simply its total.
   */
  forecast?: ForecastReport | null;
  /**
   * An already-resolved pipe state, when the caller has one.
   *
   * The dashboard reads `getAdPipeStatus` for its own empty states, so passing
   * it costs nothing. Omitted, this loads its own — never skipped, because a
   * verdict from untrusted spend is the one output this module must not produce
   * silently.
   */
  pipeState?: AdPipeState;
}

/**
 * States in which recorded spend cannot be read as the money actually spent.
 *
 * `stale` is deliberately NOT here. Stale means the last successful sync is
 * older than the freshness threshold but did succeed — the figures are real, a
 * few hours behind, and pacing over a month is not moved by that. Withholding
 * the verdict for it would blank the panel most of the time on the free cron
 * cadence.
 */
const UNTRUSTED: ReadonlySet<AdPipeState> = new Set<AdPipeState>([
  "unreachable",
  "never_synced",
  "backfilling",
  "not_connected",
]);

/** The currency this platform's spend is reported in, for this client. */
async function platformCurrency(
  client: Client,
  platform: AdPlatform,
): Promise<string> {
  const fallback = client.metaCurrency ?? "USD";
  if (platform === "meta") return fallback;
  if (platform === "google") {
    const g = await getGoogleAccountSummary(client.id).catch(() => null);
    return g?.currency ?? fallback;
  }
  const map = await getTiktokCurrencies([client.id]).catch(() => null);
  return map?.get(client.id)?.[0] ?? fallback;
}

/**
 * The forecast's spend projection, if it is applicable and willing.
 *
 * Three conditions, each of which would otherwise put a wrong number on the
 * meter: the report must be for the month being paced, its verdict must be `ok`
 * (it declines with `too_early` and `no_data` rather than guessing), and it
 * must actually carry a spend metric.
 */
function forecastSpendFor(
  report: ForecastReport | null | undefined,
  monthKey: string,
): number | null {
  if (!report || report.verdict !== "ok" || report.monthKey !== monthKey) return null;
  const spend = report.metrics.find((m) => m.key === "spend");
  return spend && Number.isFinite(spend.projected) ? spend.projected : null;
}

/**
 * Pacing for one month, defaulting to the one currently running.
 *
 * 🔴 The two spend queries are not redundant. `spendToDate` includes today so
 * the headline "spent so far" matches what the rest of the dashboard shows for
 * the same range; `spendThroughYesterday` stops at the last complete day so the
 * run rate is not dragged down by a day that is still happening. Collapsing
 * them into one number is the bug `pacing.ts` opens by describing.
 *
 * Returns `no_budget` pacing rather than null when nothing is on file: the
 * projection is still worth showing, and an empty state that says what the
 * month is heading for invites a budget to be set.
 */
export async function loadPacing(
  client: Client,
  platform: AdPlatform,
  opts: LoadPacingOptions = {},
): Promise<MonthPacing> {
  const tz = client.timezone;
  const month = opts.monthKey ?? currentMonthKey(tz);
  const shape = monthShape(month, tz);
  const isCurrentMonth = month === currentMonthKey(tz);

  const rows = await listBudgets(client.id, platform);
  const budget = budgetForMonth(rows, month);

  /*
   * The complete-days window ends the day before today — or on the month's last
   * day once it has closed, when every day is complete.
   *
   * On the 1st, "yesterday" is in the previous month and falls before
   * `startKey`. That window is skipped rather than queried, because an inverted
   * range returns 0 and would be indistinguishable from a real "spent nothing".
   */
  const todayKeyInMonth = `${month}-${String(shape.dayOfMonth).padStart(2, "0")}`;
  const throughKey =
    shape.dayOfMonth > shape.daysInMonth
      ? shape.endKey
      : shiftDateKey(todayKeyInMonth, -1);

  const [toDate, throughYesterday, forecast, currency, pipeState] = await Promise.all([
    getAdTotals(client.id, shape, undefined, platform),
    throughKey < shape.startKey
      ? Promise.resolve({ spend: 0 })
      : getAdTotals(
          client.id,
          windowFromKeys(shape.startKey, throughKey, tz),
          undefined,
          platform,
        ),
    /*
     * Only for the month in progress, and only when the caller has not already
     * loaded one. A closed month needs no forecast — every day is complete, so
     * the run rate over all of them IS the total — and asking for one would be
     * a query whose answer is discarded.
     */
    opts.forecast !== undefined
      ? Promise.resolve(opts.forecast)
      : isCurrentMonth
        ? loadForecast(client.id, tz, {
            mode: client.paidLeadFilter,
            tag: client.paidLeadTag,
          }, platform).catch(() => null)
        : Promise.resolve(null),
    platformCurrency(client, platform),
    opts.pipeState !== undefined
      ? Promise.resolve(opts.pipeState)
      : getAdPipeStatus(client, platform)
          .then((p) => p.state)
          // A pipe state we cannot read is itself a reason not to trust the
          // spend, so the failure resolves to `unreachable` rather than to
          // something reassuring.
          .catch(() => "unreachable" as AdPipeState),
  ]);

  const pacing = computePacing({
    budget,
    forecastSpend: forecastSpendFor(forecast, month),
    spendToDate: toDate.spend,
    spendThroughYesterday: throughYesterday.spend,
    daysInMonth: shape.daysInMonth,
    dayOfMonth: shape.dayOfMonth,
  });

  return {
    ...pacing,
    monthKey: month,
    currency,
    isCurrentMonth,
    pipeState,
    spendTrusted: !UNTRUSTED.has(pipeState),
  };
}

/**
 * Twelve months of "did we place what was agreed", for one client and platform.
 *
 * Two queries whatever the window: the budgets, and one grouped spend query.
 * The obvious shape — `getAdTotals` per month — is twelve round trips for a
 * panel sitting on a page that already issues dozens.
 *
 * Degrades to an empty history rather than throwing: `ad_budgets` is a new
 * table, and a deploy landing ahead of its migration must cost this panel and
 * nothing else.
 */
export async function loadBudgetHistory(
  client: Client,
  platform: AdPlatform,
  monthCount = 12,
): Promise<{ history: BudgetHistory; currency: string }> {
  const tz = client.timezone;
  const months = trailingMonths(monthCount, tz);
  const currency = await platformCurrency(client, platform).catch(() => "USD");

  if (months.length === 0) return { history: EMPTY_BUDGET_HISTORY, currency };

  try {
    const oldest = months[months.length - 1];
    const newest = months[0];
    const [spendByMonth, budgets] = await Promise.all([
      getMonthlySpend(client.id, platform, oldest.startKey, newest.endKey),
      listBudgets(client.id, platform),
    ]);

    return {
      history: buildBudgetHistory({
        months,
        spendByMonth,
        budgets,
        currentMonth: currentMonthKey(tz),
      }),
      currency,
    };
  } catch (err) {
    console.error(`[budgets] history unavailable for ${client.slug}:`, err);
    return { history: EMPTY_BUDGET_HISTORY, currency };
  }
}
