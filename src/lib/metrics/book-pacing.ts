import { computePacing, type PaceStatus } from "./pacing";
import type { AdPlatform } from "@/lib/platforms";

/**
 * Budget commitment across the book — what the agency has promised to place
 * this month, and which clients are not on track to place it.
 *
 * The per-client panel answers "is THIS client on track". The question an
 * agency owner actually opens the app with is "which of my twelve need me
 * today", and answering it by opening twelve dashboards is how underspend goes
 * unnoticed until the month closes.
 *
 * ---
 *
 * THREE RULES CARRIED OVER FROM THE ROLL-UP, FOR THE SAME REASONS
 *
 * **1 · Money in different currencies is never added.** A client budgeted in
 * GBP and one in USD have no common total without an exchange rate this system
 * does not have. Totals are grouped by currency, and a client whose own
 * budgeted platforms disagree on currency is reported as `mixedCurrency` and
 * left out of every total rather than silently folded into one.
 *
 * **2 · Ratios are recomputed from summed components**, never averaged across
 * clients — otherwise a £200 account moves the book's number as much as a
 * £20,000 one.
 *
 * **3 · What is excluded is named.** `withoutBudget` counts the clients that
 * have no agreement on file, because a commitment total that quietly omits half
 * the book is worse than no total.
 *
 * ---
 *
 * 🔴 **Spend is counted only for platforms that have a budget**, not the
 * client's whole spend. A client with a Meta budget who also runs Google would
 * otherwise have their Google spend charged against a Meta-only commitment and
 * read as overspending — a wrong answer produced from two correct numbers.
 *
 * 🔴 **No projection here, deliberately.** The verdict comes from complete-day
 * spend against the linear target, which is exactly what the per-client panel
 * uses, so the two cannot disagree. A month-end projection needs the
 * weekday-weighted forecast, which is a query per client; running twelve of
 * them to render a summary panel is not a trade worth making, and using the
 * cruder flat run rate here would print a different number from the one on the
 * client's own page.
 *
 * Pure and deterministic. No I/O, no clock.
 */

export interface BookPacingInput {
  clientId: string;
  name: string;
  slug: string;
  /** The month this client is in, in that client's timezone. */
  monthKey: string;
  /** Platforms with a budget for this month, and what each committed. */
  budgets: Array<{ platform: AdPlatform; amount: number; currency: string }>;
  /** Spend on those platforms only, including today. */
  spendToDate: number;
  /** The same, across complete days only. */
  spendThroughYesterday: number;
  daysInMonth: number;
  dayOfMonth: number;
  /**
   * Whether the spend above can be read as the money actually spent.
   *
   * 🔴 False when any budgeted platform's pipe is unreachable, never synced or
   * still backfilling. Spend that was never fetched is recorded as zero, which
   * is indistinguishable from an account that stopped delivering — so scoring
   * it would put "Underspending" against a client whose sync is simply broken,
   * and send someone to raise a budget that was already being spent.
   */
  spendTrusted: boolean;
}

export interface BookPacingRow {
  clientId: string;
  name: string;
  slug: string;
  currency: string;
  /** Budgeted platforms disagree on currency, so nothing here may be summed. */
  mixedCurrency: boolean;
  committed: number;
  spentToDate: number;
  expectedToDate: number | null;
  status: PaceStatus;
  daysRemaining: number;
  platforms: AdPlatform[];
  /** See `BookPacingInput.spendTrusted`. A false row is shown but never scored. */
  spendTrusted: boolean;
}

export interface BookPacingTotals {
  currency: string;
  clients: number;
  committed: number;
  spentToDate: number;
  /** Where an even pace would have the book by now. */
  expectedToDate: number;
}

export interface BookPacing {
  /**
   * The month these rows describe.
   *
   * 🔴 Not necessarily the same month for every row. Each client's month is
   * resolved in that client's OWN timezone — the same rule the roll-up applies
   * to its windows — so for a few hours around a boundary a Sydney client has
   * turned the page while a Los Angeles one has not. `mixedMonths` says so, and
   * the panel then names no single month rather than labelling one client's
   * figures with another's calendar.
   */
  monthKey: string;
  /** Rows span more than one calendar month. See `monthKey`. */
  mixedMonths: boolean;
  rows: BookPacingRow[];
  byCurrency: BookPacingTotals[];
  /** One currency across every budgeted client, so a single total IS the book. */
  singleCurrency: boolean;
  /**
   * Clients off pace, alphabetical.
   *
   * Alphabetical and NOT ranked by variance, deliberately: this product does
   * not compare one client against another in any form, and a list sorted by
   * who is worst is a leaderboard whatever it is called. Each row here is a
   * client measured against their own agreement.
   */
  needsAttention: BookPacingRow[];
  /** Clients with no agreement on file — named, not silently dropped. */
  withoutBudget: number;
  /**
   * Budgeted clients whose spend could not be trusted, so they were not scored.
   *
   * Counted on the face of the panel for the same reason `withoutBudget` is: a
   * total that quietly omits a client reads as a total that includes them.
   */
  untrusted: number;
}

export const EMPTY_BOOK_PACING: BookPacing = {
  monthKey: "",
  mixedMonths: false,
  untrusted: 0,
  rows: [],
  byCurrency: [],
  singleCurrency: true,
  needsAttention: [],
  withoutBudget: 0,
};

/** Statuses that mean somebody should look. */
const ATTENTION: ReadonlySet<PaceStatus> = new Set<PaceStatus>(["under", "over"]);

export function buildBookPacing(
  inputs: readonly BookPacingInput[],
  monthKey: string,
): BookPacing {
  const rows: BookPacingRow[] = [];
  let withoutBudget = 0;

  for (const input of inputs) {
    if (input.budgets.length === 0) {
      withoutBudget++;
      continue;
    }

    const currencies = new Set(input.budgets.map((b) => b.currency));
    const mixedCurrency = currencies.size > 1;
    const committed = input.budgets.reduce((sum, b) => sum + b.amount, 0);

    const pacing = computePacing({
      budget: committed,
      spendToDate: input.spendToDate,
      spendThroughYesterday: input.spendThroughYesterday,
      daysInMonth: input.daysInMonth,
      dayOfMonth: input.dayOfMonth,
    });

    rows.push({
      clientId: input.clientId,
      name: input.name,
      slug: input.slug,
      currency: input.budgets[0].currency,
      mixedCurrency,
      committed,
      spentToDate: input.spendToDate,
      expectedToDate: pacing.expectedToDate,
      status: pacing.status,
      daysRemaining: pacing.daysRemaining,
      platforms: input.budgets.map((b) => b.platform),
      spendTrusted: input.spendTrusted,
    });
  }

  const totals = new Map<string, BookPacingTotals>();
  for (const row of rows) {
    // Rule 1: a client whose own budgets straddle two currencies has no single
    // figure to contribute, so it contributes to nothing.
    if (row.mixedCurrency) continue;
    // Nor does a client whose spend was never fetched: its zero would deflate
    // the book's placed total and read as money that was not spent.
    if (!row.spendTrusted) continue;
    const t = totals.get(row.currency) ?? {
      currency: row.currency,
      clients: 0,
      committed: 0,
      spentToDate: 0,
      expectedToDate: 0,
    };
    t.clients++;
    t.committed += row.committed;
    t.spentToDate += row.spentToDate;
    t.expectedToDate += row.expectedToDate ?? 0;
    totals.set(row.currency, t);
  }

  const byCurrency = [...totals.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );

  const months = new Set(inputs.map((i) => i.monthKey).filter(Boolean));

  return {
    monthKey,
    mixedMonths: months.size > 1,
    rows: [...rows].sort((a, b) => a.name.localeCompare(b.name)),
    byCurrency,
    singleCurrency: byCurrency.length <= 1,
    untrusted: rows.filter((r) => !r.spendTrusted).length,
    needsAttention: rows
      // Untrusted spend produces no verdict, so it produces no alarm either.
      .filter((r) => r.spendTrusted && ATTENTION.has(r.status))
      .sort((a, b) => a.name.localeCompare(b.name)),
    withoutBudget,
  };
}
