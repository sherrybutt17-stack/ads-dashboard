import { describe, it, expect } from "vitest";
import { buildBookPacing, type BookPacingInput } from "./book-pacing";

/** A client mid-month: 9 complete days of a 31-day month, £100/day on target. */
function client(over: Partial<BookPacingInput> = {}): BookPacingInput {
  return {
    clientId: "c1",
    name: "Acme",
    slug: "acme",
    monthKey: "2026-08",
    budgets: [{ platform: "meta", amount: 3100, currency: "GBP" }],
    spendToDate: 908,
    spendThroughYesterday: 900,
    daysInMonth: 31,
    dayOfMonth: 10,
    spendTrusted: true,
    ...over,
  };
}

describe("what the book totals", () => {
  it("adds commitments within a currency", () => {
    const book = buildBookPacing(
      [
        client(),
        client({ clientId: "c2", name: "Beta", slug: "beta" }),
      ],
      "2026-08",
    );
    expect(book.byCurrency).toHaveLength(1);
    expect(book.byCurrency[0]).toMatchObject({
      currency: "GBP",
      clients: 2,
      committed: 6200,
      spentToDate: 1816,
    });
    expect(book.singleCurrency).toBe(true);
  });

  it("🔴 never adds money across currencies", () => {
    // `$4,000 + £3,000 = 7,000` of nothing. There is no exchange rate in this
    // system and inventing one would put a fabricated number on the page.
    const book = buildBookPacing(
      [
        client(),
        client({
          clientId: "c2",
          name: "Beta",
          slug: "beta",
          budgets: [{ platform: "meta", amount: 4000, currency: "USD" }],
        }),
      ],
      "2026-08",
    );
    expect(book.singleCurrency).toBe(false);
    expect(book.byCurrency.map((t) => t.currency)).toEqual(["GBP", "USD"]);
    expect(book.byCurrency.map((t) => t.committed)).toEqual([3100, 4000]);
  });

  it("🔴 leaves a client whose own budgets straddle currencies out of every total", () => {
    // Its own row still shows — the client is not hidden — but it contributes
    // to no total, because the sum of its own commitments is not a number.
    const book = buildBookPacing(
      [
        client({
          budgets: [
            { platform: "meta", amount: 3100, currency: "GBP" },
            { platform: "google", amount: 1000, currency: "USD" },
          ],
        }),
      ],
      "2026-08",
    );
    expect(book.rows[0].mixedCurrency).toBe(true);
    expect(book.byCurrency).toEqual([]);
  });

  it("🔴 names what it left out rather than quietly shrinking the book", () => {
    // A commitment total that silently omits half the book is worse than none.
    const book = buildBookPacing(
      [client(), client({ clientId: "c2", name: "Beta", slug: "beta", budgets: [] })],
      "2026-08",
    );
    expect(book.withoutBudget).toBe(1);
    expect(book.rows).toHaveLength(1);
  });

  it("sums the platforms a client budgeted, and only those", () => {
    const book = buildBookPacing(
      [
        client({
          budgets: [
            { platform: "meta", amount: 3100, currency: "GBP" },
            { platform: "google", amount: 900, currency: "GBP" },
          ],
        }),
      ],
      "2026-08",
    );
    expect(book.rows[0].committed).toBe(4000);
    expect(book.rows[0].platforms).toEqual(["meta", "google"]);
    expect(book.rows[0].mixedCurrency).toBe(false);
  });
});

describe("who needs attention", () => {
  const onPace = client();
  const under = client({
    clientId: "c2",
    name: "Zeta",
    slug: "zeta",
    spendToDate: 500,
    spendThroughYesterday: 495,
  });
  const over = client({
    clientId: "c3",
    name: "Beta",
    slug: "beta",
    spendToDate: 1800,
    spendThroughYesterday: 1790,
  });

  it("lists the clients off pace and no others", () => {
    const book = buildBookPacing([onPace, under, over], "2026-08");
    expect(book.needsAttention.map((r) => r.name)).toEqual(["Beta", "Zeta"]);
    expect(book.needsAttention.map((r) => r.status)).toEqual(["over", "under"]);
  });

  it("🔴 is alphabetical, not ranked by who is worst", () => {
    /*
     * A list sorted by variance is a leaderboard whatever it is called, and
     * this product does not compare one client against another in any form —
     * every judgement here is a client against their own agreement.
     */
    const book = buildBookPacing([under, over], "2026-08");
    // Zeta is further off pace than Beta, and still sorts second.
    expect(book.needsAttention.map((r) => r.name)).toEqual(["Beta", "Zeta"]);
  });

  it("says nothing about a month too young to judge", () => {
    const day2 = client({ dayOfMonth: 2, spendToDate: 10, spendThroughYesterday: 8 });
    const book = buildBookPacing([day2], "2026-08");
    expect(book.rows[0].status).toBe("too_early");
    expect(book.needsAttention).toEqual([]);
  });

  it("keeps every budgeted client in rows even when on pace", () => {
    // The attention list is an exception report; the rows are the commitment.
    const book = buildBookPacing([onPace, under], "2026-08");
    expect(book.rows).toHaveLength(2);
  });
});

describe("empty and edge", () => {
  it("handles a book with no clients", () => {
    const book = buildBookPacing([], "2026-08");
    expect(book.rows).toEqual([]);
    expect(book.byCurrency).toEqual([]);
    expect(book.withoutBudget).toBe(0);
    expect(book.singleCurrency).toBe(true);
  });

  it("orders rows alphabetically regardless of input order", () => {
    const book = buildBookPacing(
      [
        client({ clientId: "c2", name: "Zeta", slug: "zeta" }),
        client({ clientId: "c1", name: "Acme", slug: "acme" }),
      ],
      "2026-08",
    );
    expect(book.rows.map((r) => r.name)).toEqual(["Acme", "Zeta"]);
  });
});

describe("which month the book is describing", () => {
  it("names one month when every client is in it", () => {
    const book = buildBookPacing(
      [client(), client({ clientId: "c2", name: "Beta", slug: "beta" })],
      "2026-08",
    );
    expect(book.mixedMonths).toBe(false);
    expect(book.monthKey).toBe("2026-08");
  });

  it("🔴 admits when the book straddles two calendars", () => {
    /*
     * Each client's month is resolved in that client's own timezone, so for a
     * few hours around a boundary a Sydney client has turned the page and a Los
     * Angeles one has not. Labelling both with one month would put one client's
     * figures under another's calendar.
     */
    const book = buildBookPacing(
      [
        client(),
        client({ clientId: "c2", name: "Beta", slug: "beta", monthKey: "2026-09" }),
      ],
      "2026-08",
    );
    expect(book.mixedMonths).toBe(true);
  });
});

describe("spend that cannot be trusted", () => {
  /*
   * 🔴 The same guard the client panel and the alert apply. Spend that was never
   * fetched is recorded as zero, which is indistinguishable from an account that
   * stopped delivering — and "Underspending" over a broken sync sends someone to
   * raise a budget that was already being spent.
   */
  const broken = client({
    clientId: "c2",
    name: "Broken",
    slug: "broken",
    spendToDate: 0,
    spendThroughYesterday: 0,
    spendTrusted: false,
  });

  it("🔴 does not report a dead pipe as underspending", () => {
    const book = buildBookPacing([broken], "2026-08");
    expect(book.needsAttention).toEqual([]);
    expect(book.untrusted).toBe(1);
  });

  it("keeps it out of the totals rather than deflating them", () => {
    // Its zero would otherwise read as money the agency failed to place.
    const book = buildBookPacing([client(), broken], "2026-08");
    expect(book.byCurrency).toHaveLength(1);
    expect(book.byCurrency[0].clients).toBe(1);
    expect(book.byCurrency[0].committed).toBe(3100);
    expect(book.byCurrency[0].spentToDate).toBe(908);
  });

  it("still shows the client, so it is excluded visibly and not hidden", () => {
    const book = buildBookPacing([broken], "2026-08");
    expect(book.rows).toHaveLength(1);
    expect(book.rows[0].spendTrusted).toBe(false);
  });

  it("still counts a trusted client that is genuinely off pace", () => {
    const genuine = client({
      clientId: "c3",
      name: "Genuine",
      slug: "genuine",
      spendToDate: 400,
      spendThroughYesterday: 395,
    });
    const book = buildBookPacing([broken, genuine], "2026-08");
    expect(book.needsAttention.map((r) => r.name)).toEqual(["Genuine"]);
  });
});
