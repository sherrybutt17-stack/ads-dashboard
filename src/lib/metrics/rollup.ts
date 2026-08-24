import { costPer, pctChange, roasFrom } from "./compute";
import type { PaidLeadFilter } from "./queries";

/** How a client decides which leads are paid. One of `PaidLeadFilter["mode"]`. */
type LeadMode = PaidLeadFilter["mode"];

/**
 * The book — every client on one screen.
 *
 * The portfolio question is not "how is this client doing" repeated N times. It
 * is "where is my money and my attention going", and it is the one view an
 * agency owner opens first and a client never opens at all.
 *
 * ---
 *
 * FOUR WAYS TO ADD UP A BOOK WRONGLY, ALL OF THEM PLAUSIBLE
 *
 * **1 · Averaging the ratios.** The book's cost per lead is total spend over
 * total leads, never the mean of each client's cost per lead. Averaging gives a
 * $200-a-month client the same weight as a $20,000 one, so the number moves on
 * the smallest accounts and barely notices the largest. Every ratio here is
 * recomputed from summed components — the same rule the schema applies to CTR
 * and CPM across days, one level up.
 *
 * **2 · Adding money in different currencies.** `$4,000 + £3,000 = 7,000` of
 * nothing. Totals are grouped by currency and there is no grand total across
 * them, because there is no exchange rate in this system and inventing one
 * would put a fabricated number at the top of the page.
 *
 * **3 · 🔴 Adding reach.** Reach is deduplicated PEOPLE, and this is worse
 * across clients than across days. Meta deduplicates within an ad account and
 * cannot do it between accounts — two clients advertising to the same city
 * reach overlapping people that no query can subtract. So a book-wide reach is
 * not "a number needing a separate query", as it is for a single account over a
 * period; it is **not knowable from this data at all**, and the honest thing is
 * to not print one. See `REACH_NOT_AGGREGATABLE`.
 *
 * **4 · Letting a dead pipe deflate the book.** A client with ads running and
 * no CRM connected contributes spend and zero leads, so the book's cost per
 * lead rises for a reason that has nothing to do with advertising. Sums include
 * every client — the money was really spent. Ratios are computed over clients
 * whose pipe has ever delivered, and the ones left out are named along with how
 * much spend went with them, so the exclusion is visible rather than flattering.
 *
 * Pure and deterministic. No I/O, no clock.
 */

/** Why there is no total-reach column, stated where a reader would look for one. */
export const REACH_NOT_AGGREGATABLE =
  "Reach is deduplicated people. Meta deduplicates inside one ad account and cannot do it across accounts, so the number of distinct people this book reached is not derivable from these rows — it is not shown rather than shown wrong.";

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

/** One client's figures for one window. Counts and money only; no ratios. */
export interface ClientPeriod {
  spend: number;
  metaSpend: number;
  googleSpend: number;
  tiktokSpend: number;
  leads: number;
  appointments: number;
  showed: number;
  closedWon: number;
  revenue: number;
  /** Won opportunities carrying a non-zero deal value. */
  wonWithValue: number;
}

export const EMPTY_CLIENT_PERIOD: ClientPeriod = {
  spend: 0,
  metaSpend: 0,
  googleSpend: 0,
  tiktokSpend: 0,
  leads: 0,
  appointments: 0,
  showed: 0,
  closedWon: 0,
  revenue: 0,
  wonWithValue: 0,
};

export interface ClientInput {
  clientId: string;
  name: string;
  slug: string;
  /** The client's display currency — its Meta account's, as on its dashboard. */
  currency: string;
  /**
   * A webhook has landed at some point. `false` means the CRM half was never
   * wired, so this client's zero leads is a statement about the plumbing.
   */
  connected: boolean;
  /** Which leads this client counts as paid. Differs per client by design. */
  leadMode: LeadMode;
  /**
   * Currencies found on this client's Google ad accounts, if any.
   *
   * Meta, Google and TikTok spend are added together per client, which is only
   * sound when all are priced the same. Carried so the mismatch can be reported
   * rather than silently summed.
   */
  googleCurrencies: string[];
  /**
   * The same, for TikTok advertisers.
   *
   * Its own field rather than being folded into `googleCurrencies`, because the
   * warning has to name which platform disagrees — "spend is in two currencies"
   * with no pointer to where is a dead end for whoever has to fix it.
   */
  tiktokCurrencies: string[];
  current: ClientPeriod;
  previous: ClientPeriod;
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

export interface ClientRow {
  clientId: string;
  name: string;
  slug: string;
  currency: string;
  connected: boolean;
  spend: number;
  leads: number;
  appointments: number;
  showed: number;
  closedWon: number;
  revenue: number;
  /** Blended across platforms. Null when there were no leads. */
  cpLead: number | null;
  cpAppt: number | null;
  /** Null when no won deal carried a value — NOT zero. See `revenueKnown`. */
  roas: number | null;
  /** At least one won deal has a value, so revenue means something. */
  revenueKnown: boolean;
  spendChange: number | null;
  leadsChange: number | null;
  /** Spend was added across platforms priced in different currencies. */
  mixedCurrency: boolean;
}

export interface CurrencyTotals {
  currency: string;
  clients: number;
  spend: number;
  leads: number;
  appointments: number;
  showed: number;
  closedWon: number;
  revenue: number;
  /* Ratios, over the comparable subset only. */
  cpLead: number | null;
  cpAppt: number | null;
  roas: number | null;
  revenueKnown: boolean;
  spendChange: number | null;
  leadsChange: number | null;
  /** Clients whose CRM has never delivered, left out of the ratios above. */
  excluded: { name: string; spend: number }[];
}

export interface BookRollup {
  rows: ClientRow[];
  byCurrency: CurrencyTotals[];
  /** One currency across the whole book, so the single total IS the book. */
  singleCurrency: boolean;
  /**
   * The distinct paid-lead definitions in play, with how many clients use each.
   *
   * More than one entry means the book's blended cost per lead divides one pool
   * of spend by leads counted under different rules — a client counting every
   * enquiry and a client counting only campaign-attributed ones, added together.
   * Each client's own figure is right; the total is a blend of two definitions
   * and has to say so.
   */
  leadBases: { mode: LeadMode; clients: number }[];
  /** Clients with spend priced in more than one currency. */
  mixedCurrencyClients: string[];
}

export const EMPTY_BOOK: BookRollup = {
  rows: [],
  byCurrency: [],
  singleCurrency: true,
  leadBases: [],
  mixedCurrencyClients: [],
};

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

function addInto(a: ClientPeriod, b: ClientPeriod): ClientPeriod {
  return {
    spend: a.spend + b.spend,
    metaSpend: a.metaSpend + b.metaSpend,
    googleSpend: a.googleSpend + b.googleSpend,
    tiktokSpend: a.tiktokSpend + b.tiktokSpend,
    leads: a.leads + b.leads,
    appointments: a.appointments + b.appointments,
    showed: a.showed + b.showed,
    closedWon: a.closedWon + b.closedWon,
    revenue: a.revenue + b.revenue,
    wonWithValue: a.wonWithValue + b.wonWithValue,
  };
}

/**
 * ROAS, via the SAME helper each client's own dashboard uses.
 *
 * Reimplemented here it would drift, and the drift would be invisible: this
 * screen and the client's screen would print different return figures for the
 * same period and both would look plausible. `roasFrom` also carries a
 * distinction worth not losing — nothing closed is a real `0`, deals closed
 * with no value recorded is `null` — which a fresh implementation collapses on
 * the first reading.
 */
function roasOf(p: ClientPeriod): number | null {
  return roasFrom(
    { wonOpps: p.closedWon, wonWithValue: p.wonWithValue, revenue: p.revenue },
    p.spend,
  );
}

export function buildRollup(inputs: readonly ClientInput[]): BookRollup {
  const rows: ClientRow[] = inputs.map((c): ClientRow => {
    const cur = c.current;
    const mixedCurrency = [...c.googleCurrencies, ...c.tiktokCurrencies].some(
      (g) => g.toUpperCase() !== c.currency.toUpperCase(),
    );
    return {
      clientId: c.clientId,
      name: c.name,
      slug: c.slug,
      currency: c.currency,
      connected: c.connected,
      spend: cur.spend,
      leads: cur.leads,
      appointments: cur.appointments,
      showed: cur.showed,
      closedWon: cur.closedWon,
      revenue: cur.revenue,
      cpLead: costPer(cur.spend, cur.leads),
      cpAppt: costPer(cur.spend, cur.appointments),
      roas: roasOf(cur),
      revenueKnown: cur.wonWithValue > 0,
      spendChange: pctChange(cur.spend, c.previous.spend),
      leadsChange: pctChange(cur.leads, c.previous.leads),
      mixedCurrency,
    };
  });

  /*
   * Grouped by currency, and the key is normalised — a book holding "usd" and
   * "USD" would otherwise show two totals for one currency, each half right.
   */
  const groups = new Map<string, ClientInput[]>();
  for (const c of inputs) {
    const key = (c.currency || "USD").toUpperCase();
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }

  const byCurrency: CurrencyTotals[] = [...groups]
    .map(([currency, members]) => {
      const total = members.reduce(
        (a, c) => addInto(a, c.current),
        { ...EMPTY_CLIENT_PERIOD },
      );
      const prevTotal = members.reduce(
        (a, c) => addInto(a, c.previous),
        { ...EMPTY_CLIENT_PERIOD },
      );

      /*
       * 🔴 Sums use every client; ratios use only those whose CRM has ever
       * delivered. The money was really spent either way, so a total that left
       * it out would be wrong — but a cost per lead whose denominator is
       * missing a client's leads entirely is not a cost per lead, it is an
       * artifact of an unconfigured webhook.
       */
      const comparable = members.filter((c) => c.connected);
      const ratioBase = comparable.reduce(
        (a, c) => addInto(a, c.current),
        { ...EMPTY_CLIENT_PERIOD },
      );

      return {
        currency,
        clients: members.length,
        spend: total.spend,
        leads: total.leads,
        appointments: total.appointments,
        showed: total.showed,
        closedWon: total.closedWon,
        revenue: total.revenue,
        cpLead: costPer(ratioBase.spend, ratioBase.leads),
        cpAppt: costPer(ratioBase.spend, ratioBase.appointments),
        roas: roasOf(ratioBase),
        revenueKnown: ratioBase.wonWithValue > 0,
        spendChange: pctChange(total.spend, prevTotal.spend),
        leadsChange: pctChange(total.leads, prevTotal.leads),
        excluded: members
          .filter((c) => !c.connected)
          .map((c) => ({ name: c.name, spend: c.current.spend })),
      };
    })
    // Biggest book of money first; a stable tie-break so the order never jitters.
    .sort((a, b) => b.spend - a.spend || a.currency.localeCompare(b.currency));

  const modes = new Map<LeadMode, number>();
  for (const c of inputs) modes.set(c.leadMode, (modes.get(c.leadMode) ?? 0) + 1);

  return {
    rows: rows.sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name)),
    byCurrency,
    singleCurrency: byCurrency.length <= 1,
    leadBases: [...modes]
      .map(([mode, clients]) => ({ mode, clients }))
      .sort((a, b) => b.clients - a.clients || a.mode.localeCompare(b.mode)),
    mixedCurrencyClients: rows.filter((r) => r.mixedCurrency).map((r) => r.name),
  };
}
