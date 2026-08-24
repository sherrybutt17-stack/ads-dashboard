import type { Client } from "@/db/schema";
import {
  previousWindow,
  shiftDateKey,
  todayKey,
  trailingWindowInclusive,
  windowFromKeys,
  type DateWindow,
} from "@/lib/dates";
import {
  getBookAggregates,
  getChurnWeeks,
  getGoogleCurrencies,
  getTiktokCurrencies,
  type BookAggregate,
  type BookWindow,
  type ChurnWeekWindow,
  type PaidLeadFilter,
} from "./queries";
import { buildChurn, WEEKS, type ChurnInput, type ChurnReport } from "./churn";
import {
  buildRollup,
  EMPTY_BOOK,
  EMPTY_CLIENT_PERIOD,
  type BookRollup,
  type ClientInput,
  type ClientPeriod,
} from "./rollup";

/**
 * Load the book.
 *
 * The I/O half of `rollup.ts`, kept apart from it for the same reason the rest
 * of `metrics/` is: the arithmetic that decides what a number means is worth
 * being able to test without a database, and the SQL that decides which rows
 * feed it is worth being able to test against a real one.
 */

export interface BookOptions {
  /** Explicit range. Omitted, each client gets its own trailing 30 days. */
  startKey?: string;
  endKey?: string;
}

/** The label the screen shows for the range it is describing. */
export interface BookResult {
  rollup: BookRollup;
  /** Days in the window, for the header. Identical across clients by construction. */
  days: number;
  /**
   * Why the book could not be read, if it could not.
   *
   * The portfolio screen's other half — the client list with health badges —
   * works without any of this, and a failure here must cost the roll-up rather
   * than the page. Same isolation the creative queries get on the dashboard.
   */
  error: string | null;
}

const DEFAULT_DAYS = 30;

/**
 * Each client's window, in its own timezone.
 *
 * 🔴 Not one window shared by the book. Meta buckets a day in the ad account's
 * timezone and every client's dashboard computes its own boundaries the same
 * way, so a shared UTC window would show one figure here and a different one on
 * the client's own screen for the same "last 30 days". The windows are built
 * per client and carried into SQL as data.
 *
 * A consequence worth stating rather than hiding: the book's totals span a
 * ragged edge — the last day of a Los Angeles client and a London client are
 * eight hours apart. That is the correct ragged edge. Forcing them flush would
 * make each client's contribution disagree with the client's own report.
 */
function windowFor(c: Client, opts: BookOptions): { current: DateWindow; previous: DateWindow } {
  const current =
    opts.startKey && opts.endKey
      ? windowFromKeys(opts.startKey, opts.endKey, c.timezone)
      : trailingWindowInclusive(DEFAULT_DAYS, c.timezone);
  return { current, previous: previousWindow(current, c.timezone) };
}

function periodFrom(a: BookAggregate | undefined): ClientPeriod {
  if (!a) return { ...EMPTY_CLIENT_PERIOD };
  return {
    // 🔴 All three. TikTok was absent from this sum while its leads arrived via
    // the platform-agnostic transition ledger, so the book's cost per lead came
    // out below the truth — an expensive client reading as the efficient one.
    spend: a.metaSpend + a.googleSpend + a.tiktokSpend,
    metaSpend: a.metaSpend,
    googleSpend: a.googleSpend,
    tiktokSpend: a.tiktokSpend,
    leads: a.funnel.new_lead,
    appointments: a.funnel.appointment_booked,
    showed: a.funnel.showed,
    closedWon: a.funnel.closed_won,
    revenue: a.revenue.revenue,
    wonWithValue: a.revenue.wonWithValue,
  };
}

export async function loadBook(
  clients: readonly Client[],
  opts: BookOptions = {},
): Promise<BookResult> {
  if (clients.length === 0) {
    return { rollup: EMPTY_BOOK, days: requestedDays(opts), error: null };
  }

  const windows = new Map<string, { current: DateWindow; previous: DateWindow }>();
  const bookWindows: BookWindow[] = clients.map((c) => {
    const w = windowFor(c, opts);
    windows.set(c.id, w);
    const filter: PaidLeadFilter = { mode: c.paidLeadFilter, tag: c.paidLeadTag };
    return { clientId: c.id, current: w.current, previous: w.previous, filter };
  });

  let aggregates: BookAggregate[];
  let googleCurrencies: Map<string, string[]>;
  let tiktokCurrencies: Map<string, string[]>;
  try {
    const ids = clients.map((c) => c.id);
    [aggregates, googleCurrencies, tiktokCurrencies] = await Promise.all([
      getBookAggregates(bookWindows),
      getGoogleCurrencies(ids),
      getTiktokCurrencies(ids),
    ]);
  } catch (err) {
    console.error("[book] roll-up queries failed", err);
    return {
      rollup: EMPTY_BOOK,
      days: requestedDays(opts),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const byKey = new Map(aggregates.map((a) => [`${a.clientId}:${a.bucket}`, a]));

  const inputs: ClientInput[] = clients.map((c) => ({
    clientId: c.id,
    name: c.name,
    slug: c.slug,
    currency: c.metaCurrency ?? "USD",
    /*
     * "Has a webhook ever landed", not "did this client have leads this month".
     * A client that genuinely produced nothing in June still has a working pipe
     * and belongs in the book's cost per lead; a client whose CRM was never
     * wired does not, because its zero is about the wiring.
     */
    connected: c.firstWebhookAt !== null,
    leadMode: c.paidLeadFilter,
    googleCurrencies: googleCurrencies.get(c.id) ?? [],
    tiktokCurrencies: tiktokCurrencies.get(c.id) ?? [],
    current: periodFrom(byKey.get(`${c.id}:current`)),
    previous: periodFrom(byKey.get(`${c.id}:previous`)),
  }));

  const first = windows.get(clients[0].id)!.current;
  return {
    rollup: buildRollup(inputs),
    days: daysIn(first),
    error: null,
  };
}

/**
 * The day count for the header, on the paths that never build a window.
 *
 * 🔴 Both early returns used to hard-code 30. So an operator with a 90-day
 * range selected, looking at a book that failed or has no clients yet, read
 * "last 30 days" over it — a header describing a period nobody asked for, on
 * the one screen where the number being wrong is the whole problem. The empty
 * and failed states must describe the range that was REQUESTED, since that is
 * what the picker still shows.
 */
function requestedDays(opts: BookOptions): number {
  return opts.startKey && opts.endKey
    ? daysBetweenKeys(opts.startKey, opts.endKey)
    : DEFAULT_DAYS;
}

function daysIn(w: DateWindow): number {
  return daysBetweenKeys(w.startKey, w.endKey);
}

/**
 * Inclusive day count between two `YYYY-MM-DD` keys.
 *
 * Deliberately arithmetic on the keys rather than on instants: a window that
 * crosses a DST boundary contains a 23- or 25-hour day, and dividing elapsed
 * milliseconds by 86,400,000 would report 29.96 days for a 30-day range.
 */
function daysBetweenKeys(startKey: string, endKey: string): number {
  const [ay, am, ad] = startKey.split("-").map(Number);
  const [by, bm, bd] = endKey.split("-").map(Number);
  return (
    Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000) + 1
  );
}

/* ------------------------------------------------------------------ *
 * Churn signals
 * ------------------------------------------------------------------ */

/**
 * Load the churn signals for the same set of clients.
 *
 * Separate from `loadBook` and failing separately, for the reason that file
 * already gives: the client list with its health badges works without either of
 * these, and a failure in one must cost that panel rather than the page.
 */
export async function loadChurn(
  clients: readonly Client[],
  now: Date = new Date(),
): Promise<{ report: ChurnReport; error: string | null }> {
  if (clients.length === 0) {
    return { report: buildChurn([]), error: null };
  }

  const windows: ChurnWeekWindow[] = [];
  for (const c of clients) {
    const today = todayKey(c.timezone, now);
    const filter: PaidLeadFilter = { mode: c.paidLeadFilter, tag: c.paidLeadTag };
    for (let idx = 0; idx < WEEKS; idx++) {
      /*
       * 🔴 Every bucket ends at or before the client's YESTERDAY. Today is
       * part-finished in every timezone, and a part-finished period compared
       * against complete ones manufactures a decline for every client, every
       * time — the defining failure of this kind of panel, and one that looks
       * exactly like a real finding.
       */
      const endOffset = -1 - 7 * (WEEKS - 1 - idx);
      const window = windowFromKeys(
        shiftDateKey(today, endOffset - 6),
        shiftDateKey(today, endOffset),
        c.timezone,
      );
      windows.push({ clientId: c.id, idx, window, filter });
    }
  }

  let data: Awaited<ReturnType<typeof getChurnWeeks>>;
  try {
    data = await getChurnWeeks(windows);
  } catch (err) {
    console.error("[churn] weekly queries failed", err);
    return {
      report: buildChurn([]),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const byKey = new Map(data.rows.map((r) => [`${r.clientId}:${r.idx}`, r]));
  const daysSince = (iso: string | undefined): number | null =>
    iso === undefined
      ? null
      : Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);

  const inputs: ChurnInput[] = clients.map((c) => ({
    clientId: c.id,
    name: c.name,
    slug: c.slug,
    currency: c.metaCurrency ?? "USD",
    weeks: Array.from({ length: WEEKS }, (_, idx) => {
      const r = byKey.get(`${c.id}:${idx}`);
      // A missing row is a week with no spend and no leads, which the query
      // returns as an explicit zero — but a client added mid-batch would have
      // none at all, and an absent week must never read as a gap.
      return { spend: r?.spend ?? 0, leads: r?.leads ?? 0 };
    }),
    daysSinceWebhook: daysSince(data.lastWebhook.get(c.id)),
    firstActivityDaysAgo: daysSince(data.firstActivity.get(c.id)),
  }));

  return { report: buildChurn(inputs), error: null };
}
