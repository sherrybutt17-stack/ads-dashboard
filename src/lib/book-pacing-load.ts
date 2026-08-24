import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { adBudgets, type Client } from "@/db/schema";
import { currentMonthKey, monthShape, windowFromKeys, shiftDateKey } from "@/lib/dates";
import {
  getBookAggregates,
  getGoogleCurrencies,
  getTiktokCurrencies,
  type BookAggregate,
  type BookWindow,
} from "@/lib/metrics/queries";
import { budgetForMonth } from "@/lib/metrics/pacing";
import { getBookPipeStates } from "@/lib/metrics/pipe-status";
import type { AdPipeState } from "@/lib/metrics/pipe-state";
import {
  buildBookPacing,
  EMPTY_BOOK_PACING,
  type BookPacing,
  type BookPacingInput,
} from "@/lib/metrics/book-pacing";
import { AD_PLATFORMS, type AdPlatform } from "@/lib/platforms";

/**
 * Feeding `buildBookPacing` from the database in a fixed number of queries.
 *
 * Five, regardless of how many clients are in the book: the budgets, the two
 * currency maps, and `getBookAggregates` (itself three statements) covering
 * every client's month-to-date and complete-days spend at once. The naive shape
 * — `loadPacing` per client — is five queries EACH, which on a book of twelve
 * is sixty queries to render one panel.
 *
 * 🔴 `getBookAggregates` takes a `current` and a `previous` window per client,
 * and this passes something other than what those names suggest: `current` is
 * the month to date INCLUDING today, `previous` is the same month across
 * COMPLETE days only. It is not the preceding period. The two windows exist
 * because today is a partial figure that must not reach the pace calculation —
 * see the header of `metrics/pacing.ts` — and they are unpacked into honestly
 * named fields immediately below so the misleading pair never travels further.
 */
export interface BookPacingResult {
  pacing: BookPacing;
  error: string | null;
}

export async function loadBookPacing(
  clients: readonly Client[],
  monthKey?: string,
): Promise<BookPacingResult> {
  if (clients.length === 0) {
    return { pacing: EMPTY_BOOK_PACING, error: null };
  }

  const ids = clients.map((c) => c.id);

  try {
    const windows: BookWindow[] = [];
    const shapes = new Map<string, ReturnType<typeof monthShape>>();

    for (const c of clients) {
      const month = monthKey ?? currentMonthKey(c.timezone);
      const shape = monthShape(month, c.timezone);
      shapes.set(c.id, shape);

      /*
       * The complete-days window ends the day before today, or on the last day
       * of a month that has closed. On the 1st there are no complete days at
       * all, and the window is collapsed onto the month's first day rather than
       * inverted — the result is discarded below, but an inverted range is the
       * kind of thing that later reads as a real zero.
       */
      const todayInMonth = `${shape.monthKey}-${String(shape.dayOfMonth).padStart(2, "0")}`;
      const throughKey =
        shape.dayOfMonth > shape.daysInMonth
          ? shape.endKey
          : shiftDateKey(todayInMonth, -1);
      const completeWindow =
        throughKey < shape.startKey
          ? windowFromKeys(shape.startKey, shape.startKey, c.timezone)
          : windowFromKeys(shape.startKey, throughKey, c.timezone);

      windows.push({
        clientId: c.id,
        current: shape,
        previous: completeWindow,
        filter: { mode: c.paidLeadFilter, tag: c.paidLeadTag },
      });
    }

    const [aggregates, googleCurrencies, tiktokCurrencies, budgetRows, pipeStates] =
      await Promise.all([
        getBookAggregates(windows),
        getGoogleCurrencies(ids),
        getTiktokCurrencies(ids),
        db.select().from(adBudgets).where(inArray(adBudgets.clientId, ids)),
        /*
         * 🔴 Two queries for the whole book, not two per client. Spend that was
         * never fetched is recorded as zero and reads as an underspend, so the
         * book needs the same trust check the client page makes — and doing it
         * per client would turn a five-query panel into thirty.
         */
        getBookPipeStates(ids).catch((err) => {
          /*
           * Fails CLOSED — an empty map leaves every client untrusted, so the
           * panel withholds verdicts rather than scoring spend it cannot vouch
           * for. But it must not fail SILENTLY: this exact query shipped
           * broken (an untyped array parameter) and the bare catch would have
           * turned "the panel is wrong" into "the panel is empty", with
           * nothing anywhere saying why.
           */
          console.error("[book] pipe states unavailable:", err);
          return new Map<string, { state: AdPipeState }>();
        }),
      ]);

    const byKey = new Map(aggregates.map((a) => [`${a.clientId}:${a.bucket}`, a]));

    const inputs: BookPacingInput[] = clients.map((c) => {
      const shape = shapes.get(c.id)!;
      const month = shape.monthKey;

      const currencyOf = (platform: AdPlatform): string => {
        if (platform === "google") {
          return googleCurrencies.get(c.id)?.[0] ?? c.metaCurrency ?? "USD";
        }
        if (platform === "tiktok") {
          return tiktokCurrencies.get(c.id)?.[0] ?? c.metaCurrency ?? "USD";
        }
        return c.metaCurrency ?? "USD";
      };

      const budgets = AD_PLATFORMS.flatMap((platform) => {
        const rows = budgetRows
          .filter((r) => r.clientId === c.id && r.platform === platform)
          .map((r) => ({
            effectiveFrom: r.effectiveFrom,
            monthlyAmount: r.monthlyAmount === null ? null : Number(r.monthlyAmount),
          }));
        const amount = budgetForMonth(rows, month);
        // A null amount is an explicit "no budget from this month", which is
        // not a commitment and must not be summed as one.
        return amount === null
          ? []
          : [{ platform, amount, currency: currencyOf(platform) }];
      });

      /*
       * Spend on the BUDGETED platforms only. A client with a Meta budget who
       * also runs Google would otherwise have their Google spend charged
       * against a Meta-only commitment and read as overspending.
       */
      const spendOn = (a: BookAggregate | undefined): number => {
        if (!a) return 0;
        let sum = 0;
        for (const b of budgets) {
          if (b.platform === "meta") sum += a.metaSpend;
          else if (b.platform === "google") sum += a.googleSpend;
          else sum += a.tiktokSpend;
        }
        return sum;
      };

      const noCompleteDays = shape.dayOfMonth <= 1;

      /*
       * Trust is per BUDGETED platform: a client whose Google sync is broken but
       * who only budgeted Meta is perfectly scoreable. One bad pipe among the
       * platforms actually being measured is enough to withhold the verdict.
       */
      const spendTrusted = budgets.every((b) => {
        const state: AdPipeState | undefined = pipeStates.get(`${c.id}:${b.platform}`)
          ?.state;
        return state === "live" || state === "stale";
      });

      return {
        clientId: c.id,
        name: c.name,
        slug: c.slug,
        monthKey: month,
        budgets,
        spendToDate: spendOn(byKey.get(`${c.id}:current`)),
        // Explicitly zero on the 1st rather than trusting the collapsed window.
        spendThroughYesterday: noCompleteDays
          ? 0
          : spendOn(byKey.get(`${c.id}:previous`)),
        daysInMonth: shape.daysInMonth,
        dayOfMonth: shape.dayOfMonth,
        spendTrusted,
      };
    });

    const month = monthKey ?? currentMonthKey(clients[0].timezone);
    return { pacing: buildBookPacing(inputs, month), error: null };
  } catch (err) {
    /*
     * Degrades to an empty panel rather than taking the client list down. This
     * reads `ad_budgets`, a new table, and a deploy landing before its
     * migration must cost this panel and nothing else.
     */
    console.error("[book] pacing queries failed", err);
    return {
      pacing: EMPTY_BOOK_PACING,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
