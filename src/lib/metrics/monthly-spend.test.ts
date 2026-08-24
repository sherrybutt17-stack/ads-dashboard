import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";

/**
 * The grouped monthly spend behind the budget-delivery panel, against a real
 * Postgres.
 *
 * 🔴 Written because its sibling shipped broken. `getBookPipeStates` was
 * authored with an untyped array parameter, typechecked, built, and passed the
 * whole suite — because nothing had ever executed it. This query has the same
 * property and one more hazard: it derives a month key from a `date` COLUMN,
 * and Postgres does not implicitly cast a date to text, so the obvious
 * `substring(date, 1, 7)` is a runtime error rather than a wrong answer.
 *
 * Both failures are invisible to every other gate, and both hide behind a
 * caller's catch — `loadBudgetHistory` returns an empty history, so the panel
 * renders nothing and says nothing.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let q: typeof import("./queries");

beforeAll(async () => {
  harness = await createTestDb();
  q = await import("./queries");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.execute(sql`DELETE FROM fb_daily_metrics`);
  await harness.db.execute(sql`DELETE FROM google_daily_metrics`);
  await harness.db.execute(sql`DELETE FROM tiktok_daily_metrics`);
});

async function meta(
  clientId: string,
  date: string,
  spend: number,
  level: "campaign" | "ad" = "campaign",
) {
  await harness.db.execute(sql`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend)
    VALUES (${clientId}, ${date}, ${level}, 'c1', ${spend})
  `);
}

describe("grouping spend by month", () => {
  it("🔴 runs at all, and returns a yyyy-MM key", async () => {
    // The whole point: a query nothing has executed is a query that does not work.
    await meta(CLIENT_A, "2026-08-01", 100);
    const out = await q.getMonthlySpend(CLIENT_A, "meta", "2026-01-01", "2026-12-31");
    expect([...out.keys()]).toEqual(["2026-08"]);
    expect(out.get("2026-08")).toBe(100);
  });

  it("sums within a month and separates across months", async () => {
    await meta(CLIENT_A, "2026-07-31", 40);
    await meta(CLIENT_A, "2026-08-01", 100);
    await meta(CLIENT_A, "2026-08-31", 60);
    await meta(CLIENT_A, "2026-09-01", 5);

    const out = await q.getMonthlySpend(CLIENT_A, "meta", "2026-07-01", "2026-09-30");
    expect(out.get("2026-07")).toBe(40);
    // The month boundary is a boundary: the 31st belongs to August, the 1st to
    // September, and neither leaks.
    expect(out.get("2026-08")).toBe(160);
    expect(out.get("2026-09")).toBe(5);
  });

  it("respects the window on both ends", async () => {
    await meta(CLIENT_A, "2026-06-30", 999);
    await meta(CLIENT_A, "2026-07-01", 10);
    const out = await q.getMonthlySpend(CLIENT_A, "meta", "2026-07-01", "2026-07-31");
    expect(out.has("2026-06")).toBe(false);
    expect(out.get("2026-07")).toBe(10);
  });

  it("omits a month with no rows rather than reporting zero", async () => {
    // The caller reads a missing month as zero spend deliberately; what must not
    // happen is a fabricated key implying we looked and found activity.
    await meta(CLIENT_A, "2026-08-10", 20);
    const out = await q.getMonthlySpend(CLIENT_A, "meta", "2026-06-01", "2026-08-31");
    expect(out.has("2026-06")).toBe(false);
    expect(out.has("2026-07")).toBe(false);
  });

  it("does not read another client's spend", async () => {
    await meta(CLIENT_A, "2026-08-10", 20);
    await meta(CLIENT_B, "2026-08-10", 5000);
    const out = await q.getMonthlySpend(CLIENT_A, "meta", "2026-08-01", "2026-08-31");
    expect(out.get("2026-08")).toBe(20);
  });

  it("🔴 counts campaign rows only, never ad-level ones", async () => {
    /*
     * Ad-level rows report the same money one level down. Counting both doubles
     * every account's spend — and against a budget, a doubled spend turns a
     * client who delivered exactly into one who overspent by 100%.
     */
    await meta(CLIENT_A, "2026-08-10", 100, "campaign");
    await meta(CLIENT_A, "2026-08-10", 100, "ad");
    const out = await q.getMonthlySpend(CLIENT_A, "meta", "2026-08-01", "2026-08-31");
    expect(out.get("2026-08")).toBe(100);
  });
});

describe("the other two platforms", () => {
  it("reads Google from its own table", async () => {
    await harness.db.execute(sql`
      INSERT INTO google_daily_metrics (client_id, date, google_campaign_id, spend)
      VALUES (${CLIENT_A}, '2026-08-05', 'g1', 250)
    `);
    // And Meta spend must not appear under it.
    await meta(CLIENT_A, "2026-08-05", 900);

    const out = await q.getMonthlySpend(CLIENT_A, "google", "2026-08-01", "2026-08-31");
    expect(out.get("2026-08")).toBe(250);
  });

  it("reads TikTok from its own table", async () => {
    await harness.db.execute(sql`
      INSERT INTO tiktok_daily_metrics (client_id, advertiser_id, date, tiktok_campaign_id, spend)
      VALUES (${CLIENT_A}, 'adv1', '2026-08-06', 't1', 75)
    `);
    await meta(CLIENT_A, "2026-08-06", 900);

    const out = await q.getMonthlySpend(CLIENT_A, "tiktok", "2026-08-01", "2026-08-31");
    expect(out.get("2026-08")).toBe(75);
  });

  it("returns an empty map when a platform has no rows", async () => {
    const out = await q.getMonthlySpend(CLIENT_A, "tiktok", "2026-08-01", "2026-08-31");
    expect(out.size).toBe(0);
  });
});
