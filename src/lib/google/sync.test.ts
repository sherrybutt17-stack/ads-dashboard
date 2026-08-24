import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Client } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * The Google ingest run.
 *
 * ── Why this is not just "the Meta test again" ────────────────────────
 *
 * Because the two are near-copies, and that is precisely where this codebase
 * keeps producing bugs: a rule applied to one and not the other looks identical
 * at a glance. The dead primary-promotion bug lived in both account modules and
 * was only found once a Google-only client was seeded.
 *
 * The most important assertions here are the ones about what Google
 * DELIBERATELY does differently. It must not stamp `clients.lastSyncedAt` —
 * that marker belongs to Meta and drives the "Meta data fresh" health check, so
 * a Google sync writing it would report a healthy Meta pipe for a client with
 * no Meta data at all. "Make it consistent with Meta" is the obvious-looking
 * change that breaks it, which is why it is pinned rather than left to the
 * comment.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let metricRows: Record<string, unknown>[] = [];
let dailyError: Error | null = null;
const calls: { customer: string; since: string; until: string }[] = [];

const ACC_1 = "cccccccc-0000-4000-8000-000000000001";
const ACC_2 = "cccccccc-0000-4000-8000-000000000002";
const ACCOUNTS = [
  { id: ACC_1, customerId: "1111111111", currency: "USD", status: "active" },
  { id: ACC_2, customerId: "2222222222", currency: "USD", status: "active" },
];
let activeAccounts = [ACCOUNTS[0]];

vi.mock("./accounts", () => ({
  activeGoogleAccounts: async () => activeAccounts,
  googleClientForAccount: () => ({
    async getDailyMetrics(customerId: string, since: string, until: string) {
      calls.push({ customer: customerId, since, until });
      if (dailyError) throw dailyError;
      return metricRows;
    },
  }),
}));

let mod: typeof import("./sync");

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const AGENCY = "aaaaaaaa-0000-4000-8000-00000000000a";
const TZ = "America/Los_Angeles";

const client = (over: Partial<Client> = {}): Client =>
  ({ id: CLIENT_ID, agencyId: AGENCY, slug: "acme", name: "Acme", timezone: TZ, ...over }) as Client;

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const runs = async () =>
  (await run(`SELECT kind, status, rows_written, error, meta FROM sync_runs ORDER BY started_at`)).rows;

const clientStamps = async () =>
  (
    await run(
      `SELECT last_synced_at, last_google_reconciled_at, last_meta_reconciled_at
         FROM clients WHERE id = '${CLIENT_ID}'`,
    )
  ).rows[0];

const metric = (over: Record<string, unknown> = {}) => ({
  dateKey: "2026-07-20",
  campaignId: "gcamp_1",
  campaignName: "Search — Brand",
  impressions: 900,
  clicks: 44,
  spend: 88.5,
  conversions: 3,
  ...over,
});

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./sync");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  calls.length = 0;
  metricRows = [metric()];
  dailyError = null;
  activeAccounts = [ACCOUNTS[0]];
  await run(
    `TRUNCATE sync_runs, google_daily_metrics, google_ad_accounts, clients RESTART IDENTITY CASCADE`,
  );
  await run(
    `INSERT INTO clients (id, name, slug, agency_id, timezone) VALUES ('${CLIENT_ID}', 'Acme', 'acme', '${AGENCY}', '${TZ}')`,
  );
});

describe("syncClientGoogleMetrics — the platforms stay separate", () => {
  it("🔴 never stamps clients.lastSyncedAt, which is Meta's marker", async () => {
    await mod.syncClientGoogleMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      isReconcile: true,
    });

    /*
     * A Google sync writing this would make "Meta data fresh" pass for a client
     * with no Meta account at all — a green check over a pipe that does not
     * exist. Google's own freshness lives on `google_ad_accounts.last_synced_at`.
     */
    const stamps = await clientStamps();
    expect(stamps.last_synced_at).toBeNull();
    expect(stamps.last_meta_reconciled_at).toBeNull();
    expect(stamps.last_google_reconciled_at).not.toBeNull();
  });

  it("logs under its own sync kinds", async () => {
    await mod.syncClientGoogleMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    await mod.syncClientGoogleMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      intraday: true,
    });
    // Never `meta_*`: the two crons must not be able to mark each other's work
    // done in the health checks.
    expect((await runs()).map((r) => r.kind)).toEqual(["google_daily", "google_intraday"]);
  });
});

describe("syncClientGoogleMetrics — bookkeeping", () => {
  it("records a successful run with what it wrote", async () => {
    const res = await mod.syncClientGoogleMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
    });
    expect(res.rowsWritten).toBe(1);
    expect((await runs())[0]).toMatchObject({ status: "success", rows_written: 1 });
  });

  it("🔴 fails loudly when the client has no Google account", async () => {
    activeAccounts = [];
    await expect(
      mod.syncClientGoogleMetrics(client(), { since: "2026-07-20", until: "2026-07-20" }),
    ).rejects.toThrow(/no Google Ads account/i);
    expect((await runs())[0].status).toBe("failed");
  });

  it("keeps the API's own message on the run row", async () => {
    dailyError = new Error("Google says: PERMISSION_DENIED on customer 1111111111");

    await expect(
      mod.syncClientGoogleMetrics(client(), { since: "2026-07-20", until: "2026-07-20" }),
    ).rejects.toThrow(/PERMISSION_DENIED/);

    // "Sync failed" tells the operator nothing; a permissions error tells them
    // to re-authorise, which is a different action from waiting out a throttle.
    expect(String((await runs())[0].error)).toMatch(/PERMISSION_DENIED/);
  });

  it("🔴 stamps the reconcile marker only for a real reconciliation", async () => {
    await mod.syncClientGoogleMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    expect((await clientStamps()).last_google_reconciled_at).toBeNull();

    await mod.syncClientGoogleMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      isReconcile: true,
    });
    // Otherwise a client viewed all day looks trued up while never being
    // re-pulled against Google's own restatements.
    expect((await clientStamps()).last_google_reconciled_at).not.toBeNull();
  });

  it("🔴 leaves the reconcile marker alone when the run fails", async () => {
    activeAccounts = [];
    await expect(
      mod.syncClientGoogleMetrics(client(), {
        since: "2026-07-20",
        until: "2026-07-20",
        isReconcile: true,
      }),
    ).rejects.toThrow();
    expect((await clientStamps()).last_google_reconciled_at).toBeNull();
  });
});

describe("syncClientGoogleMetrics — accounts and rows", () => {
  it("🔴 accumulates across customers rather than overwriting", async () => {
    activeAccounts = ACCOUNTS;
    await mod.syncClientGoogleMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    // `customer_id` is part of the unique key, so a two-account client reports
    // both rather than half its spend.
    const rows = (await run(
      `SELECT customer_id FROM google_daily_metrics ORDER BY customer_id`,
    )).rows;
    expect(rows.map((r) => r.customer_id)).toEqual(["1111111111", "2222222222"]);
  });

  it("stamps each account's own freshness", async () => {
    activeAccounts = ACCOUNTS;
    await run(
      `INSERT INTO google_ad_accounts (id, client_id, customer_id) VALUES
         ('${ACC_1}', '${CLIENT_ID}', '1111111111'),
         ('${ACC_2}', '${CLIENT_ID}', '2222222222')`,
    );
    await mod.syncClientGoogleMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    expect(
      (await run(
        `SELECT customer_id FROM google_ad_accounts WHERE last_synced_at IS NOT NULL ORDER BY customer_id`,
      )).rows.map((r) => r.customer_id),
    ).toEqual(["1111111111", "2222222222"]);
  });

  it("🔴 re-running the window updates rather than duplicating", async () => {
    await mod.syncClientGoogleMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    metricRows = [metric({ spend: 500.25, clicks: 99 })];
    await mod.syncClientGoogleMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    // The nightly job re-pulls a 28-day window every night; inserting instead of
    // upserting would multiply a month's spend by the number of nights.
    const rows = (await run(`SELECT spend, clicks FROM google_daily_metrics`)).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].spend)).toBe(500.25);
  });

  it("skips a row with no date rather than writing an undated one", async () => {
    metricRows = [metric(), metric({ dateKey: null })];
    const res = await mod.syncClientGoogleMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
    });
    // An undated row cannot be bucketed and would silently never appear in any
    // window the operator picks.
    expect(res.rowsWritten).toBe(1);
  });

  it("records the currency from the account, not from the row", async () => {
    await mod.syncClientGoogleMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    // Spend is only summable within one currency; the account is the authority.
    expect((await run(`SELECT currency FROM google_daily_metrics`)).rows[0].currency).toBe("USD");
  });
});

/**
 * ⚠️ Only the gates before the advisory lock, for the reason set out in
 * `meta/sync.test.ts`: `refreshGoogleIfStale` opens a transaction to take the
 * lock and then calls the sync, which writes through the outer `db`. That is
 * correct against a pooled Neon and deadlocks on PGlite's single connection.
 */
describe("refreshGoogleIfStale — the gates before the lock", () => {
  it("does nothing for a client with no Google accounts", async () => {
    activeAccounts = [];
    expect(await mod.refreshGoogleIfStale(client())).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("🔴 reads freshness from the ACCOUNTS, not from clients.lastSyncedAt", async () => {
    await run(
      `INSERT INTO google_ad_accounts (id, client_id, customer_id, last_synced_at)
       VALUES ('${ACC_1}', '${CLIENT_ID}', '1111111111', now())`,
    );
    // `clients.last_synced_at` is Meta's. A recent Meta sync must not suppress a
    // Google refresh, and a recent Google sync must not suppress Meta's.
    await run(`UPDATE clients SET last_synced_at = NULL WHERE id = '${CLIENT_ID}'`);

    expect(await mod.refreshGoogleIfStale(client())).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("shares one freshness window with the dashboard", () => {
    expect(mod.GOOGLE_STALE_AFTER_MS).toBe(15 * 60 * 1000);
  });

  it("re-pulls the same restatement window as Meta", async () => {
    const { META_PROVISIONAL_DAYS } = await import("@/lib/dates");
    // Both platforms restate for weeks; a shorter window leaves older days
    // frozen at stale values that quietly disagree with the ad platform's UI.
    expect(mod.GOOGLE_RECONCILE_DAYS).toBe(META_PROVISIONAL_DAYS);
  });
});
