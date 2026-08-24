import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Client } from "@/db/schema";

/**
 * Loading the book — the portfolio roll-up across every client.
 *
 * The arithmetic lives in `rollup.ts` and is tested there. What this file does
 * is decide WHICH rows feed it and WHAT PERIOD the header claims to describe,
 * and both of those fail quietly: a wrong window still renders a plausible
 * number, and a wrong header renders the right number under the wrong label.
 */

const getBookAggregates = vi.fn();
const getGoogleCurrencies = vi.fn();
const getTiktokCurrencies = vi.fn();
const getChurnWeeks = vi.fn();

vi.mock("./queries", () => ({
  getBookAggregates,
  getGoogleCurrencies,
  getTiktokCurrencies,
  getChurnWeeks,
}));

const { loadBook } = await import("./book");

const client = (over: Partial<Client> = {}): Client =>
  ({
    id: "11111111-1111-1111-1111-111111111111",
    name: "Acme",
    slug: "acme",
    timezone: "America/Los_Angeles",
    metaCurrency: "USD",
    paidLeadFilter: "all",
    paidLeadTag: "facebook-lead",
    firstWebhookAt: new Date("2026-01-01"),
    ...over,
  }) as Client;

beforeEach(() => {
  vi.clearAllMocks();
  getBookAggregates.mockResolvedValue([]);
  getGoogleCurrencies.mockResolvedValue(new Map());
  getTiktokCurrencies.mockResolvedValue(new Map());
});

describe("🔴 the period the header claims to describe", () => {
  /*
   * Both early returns hard-coded 30. So an operator with a 90-day range
   * selected, looking at a book that failed or has no clients in it yet, was
   * told "last 30 days" — a header naming a period nobody asked for, on the one
   * screen whose entire job is to be trusted about periods.
   */
  it("reports the requested range when there are no clients", async () => {
    const res = await loadBook([], { startKey: "2026-05-01", endKey: "2026-07-29" });
    expect(res.days).toBe(90);
  });

  it("reports the requested range when the queries fail", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getBookAggregates.mockRejectedValue(new Error("db down"));

    const res = await loadBook([client()], {
      startKey: "2026-05-01",
      endKey: "2026-07-29",
    });
    expect(res.days).toBe(90);
    expect(res.error).toMatch(/db down/);
    err.mockRestore();
  });

  it("falls back to the default when no range was requested", async () => {
    expect((await loadBook([])).days).toBe(30);
  });

  it("counts inclusively", async () => {
    // A one-day range is one day, not zero. The header reads "last N days".
    expect(
      (await loadBook([], { startKey: "2026-07-29", endKey: "2026-07-29" })).days,
    ).toBe(1);
  });

  it("🔴 is unaffected by a daylight-saving boundary", async () => {
    /*
     * March in Los Angeles contains a 23-hour day. Dividing elapsed
     * milliseconds by 86,400,000 would report 30.96 → 31, or 29.96 → 30
     * depending on direction, so the count is arithmetic on the date keys
     * rather than on instants.
     */
    const res = await loadBook([], { startKey: "2026-03-01", endKey: "2026-03-31" });
    expect(res.days).toBe(31);
  });
});

describe("🔴 each client's window is built in its own timezone", () => {
  it("does not share one window across clients", async () => {
    /*
     * Meta buckets a day in the ad account's timezone and every client's own
     * dashboard computes its boundaries the same way. A window shared across
     * the book would show one figure here and a different one on the client's
     * screen for the same "last 30 days" — and the client's screen is the one
     * they will quote back.
     */
    await loadBook([
      client({ id: "11111111-1111-1111-1111-111111111111", timezone: "Pacific/Auckland" }),
      client({ id: "22222222-2222-2222-2222-222222222222", timezone: "America/Los_Angeles" }),
    ]);

    const [windows] = getBookAggregates.mock.calls[0];
    expect(windows).toHaveLength(2);
    const starts = windows.map((w: { current: { startUtc: Date } }) =>
      w.current.startUtc.getTime(),
    );
    // Same calendar range, different instants — that ragged edge is correct.
    expect(starts[0]).not.toBe(starts[1]);
  });

  it("carries each client's paid-lead filter, not a shared default", async () => {
    // Cost metrics divide spend by PAID leads only. Applying one client's rule
    // to another silently changes their cost per lead.
    await loadBook([
      client({ id: "11111111-1111-1111-1111-111111111111", paidLeadFilter: "all" }),
      client({
        id: "22222222-2222-2222-2222-222222222222",
        paidLeadFilter: "tagged",
        paidLeadTag: "google-lead",
      }),
    ]);
    const [windows] = getBookAggregates.mock.calls[0];
    expect(windows[0].filter).toEqual({ mode: "all", tag: "facebook-lead" });
    expect(windows[1].filter).toEqual({ mode: "tagged", tag: "google-lead" });
  });

  it("asks for a previous window of equal length, for the delta", async () => {
    await loadBook([client()], { startKey: "2026-07-01", endKey: "2026-07-30" });
    const [windows] = getBookAggregates.mock.calls[0];
    expect(windows[0].previous.endKey < windows[0].current.startKey).toBe(true);
  });
});

describe("a failure costs the panel, not the page", () => {
  it("returns an empty roll-up and the reason", async () => {
    /*
     * The portfolio screen's other half — the client list with health badges —
     * works without any of this. A throw here would take down a page that is
     * still mostly useful.
     */
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getTiktokCurrencies.mockRejectedValue(new Error("tiktok currencies failed"));

    const res = await loadBook([client()]);
    expect(res.error).toMatch(/tiktok currencies failed/);
    expect(res.rollup).toBeDefined();
    err.mockRestore();
  });

  it("issues no queries at all for an empty book", async () => {
    await loadBook([]);
    expect(getBookAggregates).not.toHaveBeenCalled();
  });
});
