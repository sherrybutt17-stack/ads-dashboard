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
 * The book-pacing loader end to end, against a real Postgres.
 *
 * `book-pacing.ts` proves the arithmetic and the currency rules. This proves
 * the part that only a database can: five queries whose results have to line up
 * by client, by platform and by bucket — and where being wrong produces a
 * plausible number rather than an error.
 *
 * 🔴 It exists because two of the queries behind this panel shipped broken and
 * green. `getBookPipeStates` bound an untyped array; `getMonthlySpend` ran
 * `substring()` on a date column. Both typechecked, both built, both passed a
 * full suite — because nothing had executed them. A loader is not covered by
 * tests of its parts.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let mod: typeof import("./book-pacing-load");

/** Mid-month: the 10th of August 2026, 09:00 in Los Angeles. */
const NOW = new Date("2026-08-10T16:00:00Z");
const TZ = "America/Los_Angeles";

const client = (id: string, name: string, over: Partial<Client> = {}): Client =>
  ({
    id,
    name,
    slug: name.toLowerCase(),
    timezone: TZ,
    metaCurrency: "GBP",
    paidLeadFilter: "all",
    paidLeadTag: "",
    ...over,
  }) as Client;

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./book-pacing-load");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  vi.setSystemTime(NOW);
  for (const t of [
    "ad_budgets",
    "fb_daily_metrics",
    "google_daily_metrics",
    "meta_ad_accounts",
    "google_ad_accounts",
    "sync_runs",
  ]) {
    await harness.db.execute(sql`DELETE FROM ${sql.raw(t)}`);
  }
});

/** A live Meta pipe: an active account and a recent successful reconciliation. */
async function livePipe(clientId: string, platform: "meta" | "google" = "meta") {
  if (platform === "meta") {
    await harness.db.execute(sql`
      INSERT INTO meta_ad_accounts (client_id, ad_account_id, status)
      VALUES (${clientId}, 'act_1', 'active')
    `);
  } else {
    await harness.db.execute(sql`
      INSERT INTO google_ad_accounts (client_id, customer_id, status)
      VALUES (${clientId}, '123', 'active')
    `);
  }
  await harness.db.execute(sql`
    INSERT INTO sync_runs (client_id, kind, status, started_at)
    VALUES (${clientId}, ${`${platform}_daily`}, 'success', ${new Date(
      NOW.getTime() - 3_600_000,
    ).toISOString()})
  `);
}

async function budget(clientId: string, amount: number, platform = "meta") {
  await harness.db.execute(sql`
    INSERT INTO ad_budgets (client_id, platform, effective_from, monthly_amount)
    VALUES (${clientId}, ${platform}, '2026-08', ${amount})
  `);
}

/** £100/day across Aug 1–9, plus a partial £8 today. */
async function metaSpend(clientId: string) {
  for (let d = 1; d <= 9; d++) {
    await harness.db.execute(sql`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend)
      VALUES (${clientId}, ${`2026-08-${String(d).padStart(2, "0")}`}, 'campaign', 'c1', 100)
    `);
  }
  await harness.db.execute(sql`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend)
    VALUES (${clientId}, '2026-08-10', 'campaign', 'c1', 8)
  `);
}

describe("assembling the book", () => {
  it("🔴 runs, and reads today apart from the complete days", async () => {
    await livePipe(CLIENT_A);
    await budget(CLIENT_A, 3100);
    await metaSpend(CLIENT_A);

    const { pacing, error } = await mod.loadBookPacing([client(CLIENT_A, "Acme")]);
    expect(error).toBeNull();

    const row = pacing.rows[0];
    expect(row.committed).toBe(3100);
    // Everything, today's partial £8 included.
    expect(row.spentToDate).toBe(908);
    // The verdict comes from the nine COMPLETE days, so it is on pace.
    expect(row.status).toBe("on_pace");
    expect(row.spendTrusted).toBe(true);
    expect(pacing.byCurrency[0]).toMatchObject({ currency: "GBP", clients: 1 });
  });

  it("🔴 charges spend only against the platforms that were budgeted", async () => {
    /*
     * A client with a Meta budget who also runs Google would otherwise have
     * their Google spend counted against a Meta-only commitment and read as
     * overspending — a wrong answer built from two correct numbers.
     */
    await livePipe(CLIENT_A);
    await budget(CLIENT_A, 3100);
    await metaSpend(CLIENT_A);
    await harness.db.execute(sql`
      INSERT INTO google_daily_metrics (client_id, date, google_campaign_id, spend)
      VALUES (${CLIENT_A}, '2026-08-05', 'g1', 5000)
    `);

    const { pacing } = await mod.loadBookPacing([client(CLIENT_A, "Acme")]);
    expect(pacing.rows[0].spentToDate).toBe(908);
    expect(pacing.rows[0].platforms).toEqual(["meta"]);
  });

  it("🔴 withholds the verdict when the pipe cannot be trusted", async () => {
    /*
     * No account and no sync: spend reads as zero, which is indistinguishable
     * from an account that stopped delivering. It must not be reported as an
     * underspend.
     */
    await budget(CLIENT_A, 3100);

    const { pacing } = await mod.loadBookPacing([client(CLIENT_A, "Acme")]);
    expect(pacing.rows[0].spendTrusted).toBe(false);
    expect(pacing.needsAttention).toEqual([]);
    expect(pacing.untrusted).toBe(1);
    // And it contributes to no total, rather than deflating the book.
    expect(pacing.byCurrency).toEqual([]);
  });

  it("reports a genuine underspend on a healthy pipe", async () => {
    await livePipe(CLIENT_A);
    await budget(CLIENT_A, 3100);
    await harness.db.execute(sql`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend)
      VALUES (${CLIENT_A}, '2026-08-05', 'campaign', 'c1', 200)
    `);

    const { pacing } = await mod.loadBookPacing([client(CLIENT_A, "Acme")]);
    expect(pacing.rows[0].status).toBe("under");
    expect(pacing.needsAttention.map((r) => r.name)).toEqual(["Acme"]);
  });

  it("counts a client with no agreement as excluded, not as zero", async () => {
    await livePipe(CLIENT_A);
    await metaSpend(CLIENT_A);

    const { pacing } = await mod.loadBookPacing([client(CLIENT_A, "Acme")]);
    expect(pacing.rows).toEqual([]);
    expect(pacing.withoutBudget).toBe(1);
  });

  it("keeps one client's spend and budget off another's row", async () => {
    await livePipe(CLIENT_A);
    await livePipe(CLIENT_B);
    await budget(CLIENT_A, 3100);
    await budget(CLIENT_B, 500);
    await metaSpend(CLIENT_A);

    const { pacing } = await mod.loadBookPacing([
      client(CLIENT_A, "Acme"),
      client(CLIENT_B, "Beta"),
    ]);
    const byName = new Map(pacing.rows.map((r) => [r.name, r]));
    expect(byName.get("Acme")!.spentToDate).toBe(908);
    expect(byName.get("Beta")!.spentToDate).toBe(0);
    expect(byName.get("Beta")!.committed).toBe(500);
  });

  it("returns an empty book for no clients without querying", async () => {
    const { pacing, error } = await mod.loadBookPacing([]);
    expect(pacing.rows).toEqual([]);
    expect(error).toBeNull();
  });
});
