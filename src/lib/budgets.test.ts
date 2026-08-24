import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  CLIENT_A,
  CLIENT_B,
  type TestDb,
} from "./metrics/__testdb__/harness";
import type { Client } from "@/db/schema";

/**
 * Budget storage and pacing assembly, against a real Postgres.
 *
 * `pacing.test.ts` already proves the arithmetic. What cannot be proved without
 * a database is that this module hands that arithmetic honest inputs, and there
 * is exactly one way it goes wrong that no type or unit test would catch:
 *
 * 🔴 **the two spend windows collapsing into one.** `spendToDate` includes
 * today, `spendThroughYesterday` must not — and both are a `SUM(spend)` over a
 * date range against the same table, so a copy-paste that reuses one window for
 * both compiles, returns a plausible number, and silently reports every client
 * as underspending each morning. The fixture below puts a distinctive amount on
 * today specifically so the two cannot be confused.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let budgets: typeof import("./budgets");

const TZ = "America/Los_Angeles";

/** The client, as `loadPacing` reads it — only these two fields are touched. */
const client = { id: CLIENT_A, timezone: TZ } as Client;

/** Mid-month: the 10th of August 2026, 9am in the client's timezone. */
const MORNING_OF_THE_10TH = new Date("2026-08-10T16:00:00Z");

beforeAll(async () => {
  harness = await createTestDb();
  budgets = await import("./budgets");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.execute(sql`DELETE FROM ad_budgets`);
  await harness.db.execute(sql`DELETE FROM fb_daily_metrics`);
});

/** £100 on each of Aug 1–9, plus a partial £8 so far on the 10th. */
async function seedSpend(clientId = CLIENT_A) {
  for (let day = 1; day <= 9; day++) {
    await harness.db.execute(sql`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend)
      VALUES (${clientId}, ${`2026-08-${String(day).padStart(2, "0")}`}, 'campaign', 'c1', 100)
    `);
  }
  await harness.db.execute(sql`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend)
    VALUES (${clientId}, '2026-08-10', 'campaign', 'c1', 8)
  `);
}

describe("storing agreements", () => {
  it("reads back what was written, oldest first", async () => {
    await budgets.setBudget({
      clientId: CLIENT_A,
      platform: "meta",
      effectiveFrom: "2026-06",
      monthlyAmount: 4000,
      updatedBy: "someone@example.com",
    });
    await budgets.setBudget({
      clientId: CLIENT_A,
      platform: "meta",
      effectiveFrom: "2026-03",
      monthlyAmount: 2000,
      updatedBy: null,
    });

    const rows = await budgets.listBudgets(CLIENT_A, "meta");
    expect(rows.map((r) => r.effectiveFrom)).toEqual(["2026-03", "2026-06"]);
    // `numeric` arrives as a string from Postgres; a string reaching the pacing
    // arithmetic would concatenate instead of adding.
    expect(rows.map((r) => r.monthlyAmount)).toEqual([2000, 4000]);
    expect(typeof rows[0].monthlyAmount).toBe("number");
  });

  it("🔴 corrects a figure rather than stacking a second row", async () => {
    // A typo fixed a minute later must not leave two agreements for one month,
    // where which one wins depends on read order.
    const write = (amount: number) =>
      budgets.setBudget({
        clientId: CLIENT_A,
        platform: "meta",
        effectiveFrom: "2026-08",
        monthlyAmount: amount,
        updatedBy: null,
      });
    await write(30000);
    await write(3000);

    const rows = await budgets.listBudgets(CLIENT_A, "meta");
    expect(rows).toHaveLength(1);
    expect(rows[0].monthlyAmount).toBe(3000);
  });

  it("keeps platforms and clients apart", async () => {
    await budgets.setBudget({
      clientId: CLIENT_A,
      platform: "meta",
      effectiveFrom: "2026-08",
      monthlyAmount: 3000,
      updatedBy: null,
    });
    await budgets.setBudget({
      clientId: CLIENT_A,
      platform: "google",
      effectiveFrom: "2026-08",
      monthlyAmount: 1500,
      updatedBy: null,
    });
    await budgets.setBudget({
      clientId: CLIENT_B,
      platform: "meta",
      effectiveFrom: "2026-08",
      monthlyAmount: 9999,
      updatedBy: null,
    });

    expect((await budgets.listBudgets(CLIENT_A, "meta"))[0].monthlyAmount).toBe(3000);
    expect((await budgets.listBudgets(CLIENT_A, "google"))[0].monthlyAmount).toBe(1500);
    expect((await budgets.listBudgets(CLIENT_B, "meta"))[0].monthlyAmount).toBe(9999);
  });

  it("stores an explicit null as 'no budget from this month'", async () => {
    await budgets.setBudget({
      clientId: CLIENT_A,
      platform: "meta",
      effectiveFrom: "2026-09",
      monthlyAmount: null,
      updatedBy: null,
    });
    const rows = await budgets.listBudgets(CLIENT_A, "meta");
    expect(rows).toHaveLength(1);
    expect(rows[0].monthlyAmount).toBeNull();
  });

  it("deletes an agreement", async () => {
    await budgets.setBudget({
      clientId: CLIENT_A,
      platform: "meta",
      effectiveFrom: "2026-08",
      monthlyAmount: 3000,
      updatedBy: null,
    });
    await budgets.deleteBudget(CLIENT_A, "meta", "2026-08");
    expect(await budgets.listBudgets(CLIENT_A, "meta")).toEqual([]);
  });
});

describe("assembling pacing from real spend", () => {
  beforeEach(async () => {
    await seedSpend();
    await budgets.setBudget({
      clientId: CLIENT_A,
      platform: "meta",
      effectiveFrom: "2026-08",
      monthlyAmount: 3100, // 31 days × £100
      updatedBy: null,
    });
  });

  it("🔴 keeps today out of the run rate and in the total", async () => {
    vi.setSystemTime(MORNING_OF_THE_10TH);
    const p = await budgets.loadPacing(client, "meta", { monthKey: "2026-08" });

    // Everything, including this morning's partial £8.
    expect(p.spendToDate).toBe(908);
    // Nine complete days at £100 — the £8 must not be here.
    expect(p.completeDays).toBe(9);
    expect(p.projectedSpend).toBe(3100);
    expect(p.status).toBe("on_pace");
    vi.useRealTimers();
  });

  it("counts no complete days on the 1st rather than querying an inverted range", async () => {
    // "Yesterday" is in July. An inverted window would sum to 0 and be
    // indistinguishable from a real zero — here it must simply not be asked.
    vi.setSystemTime(new Date("2026-08-01T16:00:00Z"));
    const p = await budgets.loadPacing(client, "meta", { monthKey: "2026-08" });
    expect(p.completeDays).toBe(0);
    expect(p.projectedSpend).toBeNull();
    expect(p.status).toBe("too_early");
    vi.useRealTimers();
  });

  it("treats a closed month as wholly complete", async () => {
    // Viewed in September, August's last day must count toward the run rate.
    vi.setSystemTime(new Date("2026-09-15T16:00:00Z"));
    const p = await budgets.loadPacing(client, "meta", { monthKey: "2026-08" });
    expect(p.completeDays).toBe(31);
    expect(p.daysRemaining).toBe(0);
    expect(p.spendToDate).toBe(908);
    expect(p.projectedSpend).toBe(908);
    expect(p.isCurrentMonth).toBe(false);
    vi.useRealTimers();
  });

  it("applies the agreement in force for the month, not the newest one", async () => {
    // The distinction the effective-from model exists for.
    await budgets.setBudget({
      clientId: CLIENT_A,
      platform: "meta",
      effectiveFrom: "2026-09",
      monthlyAmount: 10000,
      updatedBy: null,
    });
    vi.setSystemTime(MORNING_OF_THE_10TH);
    const p = await budgets.loadPacing(client, "meta", { monthKey: "2026-08" });
    expect(p.budget).toBe(3100);
    vi.useRealTimers();
  });

  it("reports no budget, and still projects, when none is on file", async () => {
    await budgets.deleteBudget(CLIENT_A, "meta", "2026-08");
    vi.setSystemTime(MORNING_OF_THE_10TH);
    const p = await budgets.loadPacing(client, "meta", { monthKey: "2026-08" });
    expect(p.status).toBe("no_budget");
    expect(p.budget).toBeNull();
    expect(p.projectedSpend).toBe(3100);
    vi.useRealTimers();
  });

  it("does not read another client's spend", async () => {
    await seedSpend(CLIENT_B);
    vi.setSystemTime(MORNING_OF_THE_10TH);
    const p = await budgets.loadPacing(client, "meta", { monthKey: "2026-08" });
    expect(p.spendToDate).toBe(908);
    vi.useRealTimers();
  });

  it("does not read another platform's spend", async () => {
    // Meta spend must not appear under a Google budget — the two are separate
    // dashboards with separate numbers.
    vi.setSystemTime(MORNING_OF_THE_10TH);
    const p = await budgets.loadPacing(client, "google", { monthKey: "2026-08" });
    expect(p.spendToDate).toBe(0);
    vi.useRealTimers();
  });
});

describe("twelve months of delivery", () => {
  /*
   * 🔴 A loader is not covered by tests of its parts. `getMonthlySpend` and
   * `buildBudgetHistory` are each tested, and the function that joins them still
   * shipped calling a query that could not run — so this executes the join.
   */
  beforeEach(async () => {
    await budgets.setBudget({
      clientId: CLIENT_A,
      platform: "meta",
      effectiveFrom: "2026-07",
      monthlyAmount: 1000,
      updatedBy: null,
    });
    for (const [date, spend] of [
      ["2026-07-10", 950],
      ["2026-06-10", 400],
      ["2026-08-05", 100],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend)
        VALUES (${CLIENT_A}, ${date}, 'campaign', 'c1', ${spend})
      `);
    }
  });

  it("scores closed months against the agreement in force", async () => {
    vi.setSystemTime(MORNING_OF_THE_10TH);
    const { history, currency } = await budgets.loadBudgetHistory(client, "meta");
    const july = history.months.find((m) => m.monthKey === "2026-07")!;
    expect(july.budget).toBe(1000);
    expect(july.spend).toBe(950);
    expect(july.verdict).toBe("on_target");

    // June predates the agreement: no budget, so nothing was missed.
    expect(history.months.find((m) => m.monthKey === "2026-06")!.verdict).toBe(
      "no_budget",
    );
    expect(currency).toBe("USD");
    vi.useRealTimers();
  });

  it("🔴 does not score the month in progress", async () => {
    vi.setSystemTime(MORNING_OF_THE_10TH);
    const { history } = await budgets.loadBudgetHistory(client, "meta");
    const august = history.months.find((m) => m.monthKey === "2026-08")!;
    expect(august.verdict).toBe("in_progress");
    // £100 of August spend must not appear in the record.
    expect(history.placed).toBe(950);
    expect(history.committed).toBe(1000);
    vi.useRealTimers();
  });

  it("does not read another client's spend", async () => {
    await harness.db.execute(sql`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend)
      VALUES (${CLIENT_B}, '2026-07-10', 'campaign', 'c1', 9999)
    `);
    vi.setSystemTime(MORNING_OF_THE_10TH);
    const { history } = await budgets.loadBudgetHistory(client, "meta");
    expect(history.months.find((m) => m.monthKey === "2026-07")!.spend).toBe(950);
    vi.useRealTimers();
  });
});
