import { describe, it, expect } from "vitest";
import {
  buildRollup,
  EMPTY_CLIENT_PERIOD,
  REACH_NOT_AGGREGATABLE,
  type ClientInput,
  type ClientPeriod,
} from "./rollup";

/**
 * Adding up a book is arithmetic. Adding it up *correctly* is four judgement
 * calls, and each one has a plausible wrong answer that produces a number
 * nobody would question: an average of averages, a sum across currencies, a
 * total reach, and a cost per lead whose denominator is missing a client whose
 * webhook was never wired.
 */

const period = (o: Partial<ClientPeriod> = {}): ClientPeriod => ({
  ...EMPTY_CLIENT_PERIOD,
  ...o,
});

const client = (o: Partial<ClientInput> = {}): ClientInput => ({
  clientId: "c1",
  name: "Client One",
  slug: "one",
  currency: "USD",
  connected: true,
  leadMode: "either",
  googleCurrencies: [],
  tiktokCurrencies: [],
  current: period(),
  previous: period(),
  ...o,
});

const usd = (b: ReturnType<typeof buildRollup>) =>
  b.byCurrency.find((t) => t.currency === "USD")!;

/* ------------------------------------------------------------------ *
 * Ratios
 * ------------------------------------------------------------------ */

describe("the book's ratios", () => {
  /*
   * A $20,000 client at $100 a lead and a $200 client at $10 a lead.
   *
   *   weighted (right): 20,200 / 220  = $91.82
   *   mean of the two:  (100 + 10) / 2 = $55.00
   *
   * The second is the number every rolled-up dashboard in this category prints,
   * and it moves on the smallest account in the book.
   */
  const big = client({
    clientId: "big",
    name: "Big",
    current: period({ spend: 20_000, leads: 200, appointments: 40 }),
  });
  const small = client({
    clientId: "small",
    name: "Small",
    current: period({ spend: 200, leads: 20, appointments: 10 }),
  });

  it("🔴 divide summed spend by summed leads, never average the per-client rate", () => {
    const t = usd(buildRollup([big, small]));
    expect(t.cpLead).toBeCloseTo(20_200 / 220, 6);
    expect(t.cpLead).not.toBeCloseTo(55, 1);
  });

  it("recomputes cost per appointment the same way", () => {
    const t = usd(buildRollup([big, small]));
    expect(t.cpAppt).toBeCloseTo(20_200 / 50, 6);
  });

  it("returns null rather than a number when there is nothing to divide by", () => {
    const t = usd(buildRollup([client({ current: period({ spend: 500 }) })]));
    expect(t.cpLead).toBeNull();
    expect(t.cpAppt).toBeNull();
  });

  it("🔴 does not report free leads when spend is zero", () => {
    // The exact corruption in the source spreadsheet: 25 leads against $0.00.
    const t = usd(buildRollup([client({ current: period({ leads: 25 }) })]));
    expect(t.cpLead).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Currency
 * ------------------------------------------------------------------ */

describe("money in more than one currency", () => {
  const a = client({ clientId: "a", name: "A", currency: "USD", current: period({ spend: 4000, leads: 100 }) });
  const b = client({ clientId: "b", name: "B", currency: "GBP", current: period({ spend: 3000, leads: 50 }) });

  it("🔴 never adds them together", () => {
    const book = buildRollup([a, b]);
    expect(book.byCurrency).toHaveLength(2);
    expect(book.singleCurrency).toBe(false);
    expect(book.byCurrency.map((t) => t.spend).sort((x, y) => x - y)).toEqual([3000, 4000]);
    // And specifically: no total of 7000 exists anywhere.
    expect(book.byCurrency.some((t) => t.spend === 7000)).toBe(false);
  });

  it("computes each currency's cost per lead within that currency", () => {
    const book = buildRollup([a, b]);
    expect(book.byCurrency.find((t) => t.currency === "USD")!.cpLead).toBeCloseTo(40, 6);
    expect(book.byCurrency.find((t) => t.currency === "GBP")!.cpLead).toBeCloseTo(60, 6);
  });

  it("reports a single total when the whole book shares a currency", () => {
    const book = buildRollup([a, client({ clientId: "c", currency: "USD" })]);
    expect(book.singleCurrency).toBe(true);
    expect(book.byCurrency).toHaveLength(1);
  });

  it("🔴 treats 'usd' and 'USD' as one currency, not two half-totals", () => {
    const lower = client({ clientId: "l", currency: "usd", current: period({ spend: 100, leads: 10 }) });
    const upper = client({ clientId: "u", currency: "USD", current: period({ spend: 100, leads: 10 }) });
    const book = buildRollup([lower, upper]);
    expect(book.byCurrency).toHaveLength(1);
    expect(book.byCurrency[0].spend).toBeCloseTo(200, 6);
  });

  it("flags a client whose Google account is priced differently from its Meta one", () => {
    // Per-client spend adds Meta and Google together. That is only sound when
    // both are in the same currency, and nothing else in the system checks.
    const mixed = client({
      clientId: "m",
      name: "Mixed",
      currency: "USD",
      googleCurrencies: ["CAD"],
      current: period({ spend: 500, metaSpend: 300, googleSpend: 200 }),
    });
    const book = buildRollup([mixed]);
    expect(book.mixedCurrencyClients).toEqual(["Mixed"]);
    expect(book.rows[0].mixedCurrency).toBe(true);
  });

  it("does not flag a client whose Google account matches", () => {
    const ok = client({ currency: "USD", googleCurrencies: ["usd"] });
    expect(buildRollup([ok]).mixedCurrencyClients).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Coverage — the dead pipe
 * ------------------------------------------------------------------ */

describe("a client whose CRM was never wired", () => {
  const working = client({
    clientId: "w",
    name: "Working",
    connected: true,
    current: period({ spend: 1000, leads: 50 }),
  });
  const unwired = client({
    clientId: "u",
    name: "Unwired",
    connected: false,
    current: period({ spend: 3000, leads: 0 }),
  });

  it("🔴 keeps its spend in the total — the money was really spent", () => {
    const t = usd(buildRollup([working, unwired]));
    expect(t.spend).toBeCloseTo(4000, 6);
    expect(t.clients).toBe(2);
  });

  it("🔴 keeps it OUT of the cost per lead, which its zero would distort", () => {
    const t = usd(buildRollup([working, unwired]));
    // $1,000 / 50 from the working client. Including the unwired one gives
    // $80 — a book that looks 4× worse because of an unconfigured webhook.
    expect(t.cpLead).toBeCloseTo(20, 6);
    expect(t.cpLead).not.toBeCloseTo(80, 1);
  });

  it("🔴 names it and the spend that went with it", () => {
    // A ratio quietly computed over a subset is the same silent omission this
    // product exists to replace. The exclusion has to be visible.
    const t = usd(buildRollup([working, unwired]));
    expect(t.excluded).toEqual([{ name: "Unwired", spend: 3000 }]);
  });

  it("does NOT exclude a connected client that genuinely produced nothing", () => {
    // Zero leads on a working pipe is a result, and it belongs in the book's
    // cost per lead — that is what a bad month looks like.
    const quiet = client({
      clientId: "q",
      name: "Quiet",
      connected: true,
      current: period({ spend: 1000, leads: 0 }),
    });
    const t = usd(buildRollup([working, quiet]));
    expect(t.excluded).toEqual([]);
    expect(t.cpLead).toBeCloseTo(2000 / 50, 6);
  });
});

/* ------------------------------------------------------------------ *
 * Revenue
 * ------------------------------------------------------------------ */

describe("return on ad spend", () => {
  it("🔴 is null, not zero, when deals closed with no value recorded", () => {
    // "0.0× return" reads as *the advertising made nothing*. The truth is that
    // nobody filled in the deal value, and those are opposite conclusions.
    const c = client({
      current: period({ spend: 1000, leads: 20, closedWon: 3, wonWithValue: 0, revenue: 0 }),
    });
    const book = buildRollup([c]);
    expect(book.rows[0].roas).toBeNull();
    expect(book.rows[0].revenueKnown).toBe(false);
    expect(usd(book).roas).toBeNull();
  });

  it("is a real zero when nothing closed at all", () => {
    // We know the return was zero. Reserving the dash for absent knowledge is
    // what keeps the dash meaningful.
    const c = client({ current: period({ spend: 1000, leads: 20 }) });
    expect(buildRollup([c]).rows[0].roas).toBe(0);
  });

  it("computes the book's return from summed revenue and summed spend", () => {
    const a = client({
      clientId: "a",
      current: period({ spend: 1000, leads: 10, closedWon: 2, wonWithValue: 2, revenue: 5000 }),
    });
    const b = client({
      clientId: "b",
      current: period({ spend: 3000, leads: 10, closedWon: 1, wonWithValue: 1, revenue: 3000 }),
    });
    expect(usd(buildRollup([a, b])).roas).toBeCloseTo(8000 / 4000, 6);
  });
});

/* ------------------------------------------------------------------ *
 * Reach
 * ------------------------------------------------------------------ */

describe("reach", () => {
  it("🔴 is absent from every shape this module produces", () => {
    /*
     * Structural, not a style check. Reach is deduplicated people; Meta
     * deduplicates within one ad account and cannot across accounts, so two
     * clients advertising to the same city reach overlapping people nobody can
     * subtract. Unlike the across-days case there is no separate query that
     * would answer it — the number does not exist in this data.
     *
     * Asserted on the object rather than trusted to review, because a `reach`
     * field is the single most natural thing for the next person to add here.
     */
    const book = buildRollup([client({ current: period({ spend: 100, leads: 5 }) })]);
    expect(Object.keys(book.rows[0])).not.toContain("reach");
    expect(Object.keys(book.byCurrency[0])).not.toContain("reach");
    expect(REACH_NOT_AGGREGATABLE).toContain("not derivable");
  });
});

/* ------------------------------------------------------------------ *
 * Comparability of the lead definition
 * ------------------------------------------------------------------ */

describe("what counts as a lead", () => {
  it("🔴 reports when the book blends more than one definition", () => {
    /*
     * One client counts every enquiry, another only campaign-attributed ones.
     * Each client's own cost per lead is right. The book's divides one pool of
     * spend by leads counted two different ways, and the only honest thing is
     * to say so — the alternative is a number that looks like one measurement.
     */
    const book = buildRollup([
      client({ clientId: "a", leadMode: "all" }),
      client({ clientId: "b", leadMode: "attributed" }),
      client({ clientId: "c", leadMode: "attributed" }),
    ]);
    expect(book.leadBases).toEqual([
      { mode: "attributed", clients: 2 },
      { mode: "all", clients: 1 },
    ]);
  });

  it("reports a single basis when the book agrees with itself", () => {
    const book = buildRollup([client({ clientId: "a" }), client({ clientId: "b" })]);
    expect(book.leadBases).toEqual([{ mode: "either", clients: 2 }]);
  });
});

/* ------------------------------------------------------------------ *
 * Movement and ordering
 * ------------------------------------------------------------------ */

describe("period over period", () => {
  it("compares each client against its own previous window", () => {
    const c = client({
      current: period({ spend: 1200, leads: 60 }),
      previous: period({ spend: 1000, leads: 80 }),
    });
    const row = buildRollup([c]).rows[0];
    expect(row.spendChange).toBeCloseTo(0.2, 6);
    expect(row.leadsChange).toBeCloseTo(-0.25, 6);
  });

  it("🔴 declines to express a change from zero as a percentage", () => {
    // Any growth from nothing is infinite, and "+∞%" on a portfolio screen is
    // noise where a real signal should be.
    const c = client({
      current: period({ spend: 500, leads: 5 }),
      previous: period({ spend: 0, leads: 0 }),
    });
    const row = buildRollup([c]).rows[0];
    expect(row.spendChange).toBeNull();
    expect(row.leadsChange).toBeNull();
  });

  it("moves the book's totals, not the mean of the clients' changes", () => {
    const a = client({
      clientId: "a",
      current: period({ spend: 10_000 }),
      previous: period({ spend: 5000 }),
    });
    const b = client({
      clientId: "b",
      current: period({ spend: 100 }),
      previous: period({ spend: 1000 }),
    });
    // (10,100 − 6,000) / 6,000, not the average of +100% and −90%.
    expect(usd(buildRollup([a, b])).spendChange).toBeCloseTo(4100 / 6000, 6);
  });
});

describe("ordering", () => {
  it("puts the biggest spender first", () => {
    const book = buildRollup([
      client({ clientId: "a", name: "A", current: period({ spend: 100 }) }),
      client({ clientId: "b", name: "B", current: period({ spend: 900 }) }),
      client({ clientId: "c", name: "C", current: period({ spend: 400 }) }),
    ]);
    expect(book.rows.map((r) => r.name)).toEqual(["B", "C", "A"]);
  });

  it("breaks ties by name, so the order never jitters between loads", () => {
    const book = buildRollup([
      client({ clientId: "z", name: "Zed" }),
      client({ clientId: "a", name: "Alpha" }),
    ]);
    expect(book.rows.map((r) => r.name)).toEqual(["Alpha", "Zed"]);
  });
});

describe("an empty book", () => {
  it("produces nothing rather than throwing", () => {
    const book = buildRollup([]);
    expect(book.rows).toEqual([]);
    expect(book.byCurrency).toEqual([]);
    expect(book.singleCurrency).toBe(true);
    expect(book.leadBases).toEqual([]);
  });
});
