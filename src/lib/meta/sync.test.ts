import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Client } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * The ingest run: what gets written, and what the sync_runs row says afterwards.
 *
 * ── Why the bookkeeping matters as much as the numbers ────────────────
 *
 * Almost everything here exists to stop the dashboard LYING about its own
 * freshness. `sync_runs` and the two timestamps on `clients` are what the health
 * checklist reads, and every rule below was written because some combination of
 * them could report a healthy pipe that was not:
 *
 *   · a failed run that still stamped `lastSyncedAt` reads as "synced 2m ago"
 *   · an intraday refresh logged as `meta_daily` lets a page view mask a dead
 *     cron, or fake a red for a pipe that was never broken
 *   · an intraday refresh counted as a reconcile makes a dashboard someone
 *     keeps open look permanently current while never being trued up against
 *     Meta's 28-day restatements
 *   · a run killed at the route's timeout leaves `running` forever, so health
 *     shows "in progress" instead of the failure it actually was
 *
 * None of those are visible as errors. They are all a green badge over a stale
 * number, which is precisely the failure this product replaced.
 *
 * The Meta API is mocked at `./accounts`, the seam where an account becomes a
 * client — so the orchestration, the upserts and the bookkeeping all run for
 * real against Postgres.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

/** What the fake Meta returns, and what it was asked. */
let insightRows: Record<string, unknown>[] = [];
let reachRows: { campaignId: string; reach: number; frequency: number }[] = [];
let breakdownError: Error | null = null;
let dailyError: Error | null = null;
const calls: { method: string; account: string; since?: string; until?: string }[] = [];

const ACC_1 = "cccccccc-0000-4000-8000-000000000001";
const ACC_2 = "cccccccc-0000-4000-8000-000000000002";
const ACCOUNTS = [
  { id: ACC_1, adAccountId: "111", currency: "USD", isPrimary: true, status: "active" },
  { id: ACC_2, adAccountId: "222", currency: "USD", isPrimary: false, status: "active" },
];
let activeAccounts = [ACCOUNTS[0]];

vi.mock("./accounts", () => ({
  activeAdAccounts: async () => activeAccounts,
  metaClientForAccount: (account: { adAccountId: string }) => ({
    async getDailyInsights(acct: string, since: string, until: string) {
      calls.push({ method: "daily", account: acct, since, until });
      if (dailyError) throw dailyError;
      return insightRows.map((r) => ({ ...r, account_id: account.adAccountId }));
    },
    async getPeriodReach(acct: string, since: string, until: string) {
      calls.push({ method: "reach", account: acct, since, until });
      return reachRows;
    },
    async getBreakdownInsights(acct: string) {
      calls.push({ method: "breakdown", account: acct });
      if (breakdownError) throw breakdownError;
      return [];
    },
    async getAds() {
      return [];
    },
    async getVideoLengths() {
      return new Map();
    },
  }),
}));

let mod: typeof import("./sync");

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const AGENCY = "aaaaaaaa-0000-4000-8000-00000000000a";
const TZ = "America/Los_Angeles";

const client = (over: Partial<Client> = {}): Client =>
  ({
    id: CLIENT_ID,
    agencyId: AGENCY,
    slug: "acme",
    name: "Acme",
    timezone: TZ,
    lastSyncedAt: null,
    ...over,
  }) as Client;

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const runs = async () =>
  (
    await run(
      `SELECT kind, status, rows_written, error, meta FROM sync_runs ORDER BY started_at`,
    )
  ).rows;

const clientStamps = async () =>
  (
    await run(
      `SELECT last_synced_at, last_meta_reconciled_at FROM clients WHERE id = '${CLIENT_ID}'`,
    )
  ).rows[0];

/** One day of insights, shaped the way the API sends it. */
const insight = (over: Record<string, unknown> = {}) => ({
  date_start: "2026-07-20",
  campaign_id: "camp_1",
  campaign_name: "Prospecting",
  account_currency: "USD",
  impressions: "1000",
  clicks: "50",
  spend: "123.45",
  reach: "800",
  actions: [{ action_type: "lead", value: "9" }],
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
  insightRows = [insight()];
  reachRows = [];
  breakdownError = null;
  dailyError = null;
  activeAccounts = [ACCOUNTS[0]];
  await run(
    `TRUNCATE sync_runs, fb_daily_metrics, fb_period_reach, fb_breakdown_metrics, clients RESTART IDENTITY CASCADE`,
  );
  await run(
    `INSERT INTO clients (id, name, slug, agency_id, timezone) VALUES ('${CLIENT_ID}', 'Acme', 'acme', '${AGENCY}', '${TZ}')`,
  );
});

/* ------------------------------------------------------------------ *
 * The run record
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — bookkeeping", () => {
  it("records a successful run with what it wrote", async () => {
    const res = await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
    });

    expect(res.rowsWritten).toBe(1);
    const [r] = await runs();
    expect(r).toMatchObject({ kind: "meta_daily", status: "success", rows_written: 1 });
    expect(r.meta).toMatchObject({ since: "2026-07-20", until: "2026-07-20", accounts: 1 });
  });

  it("🔴 logs an intraday refresh under its own kind", async () => {
    /*
     * Health reads only the full-sync kind. An intraday run races the page
     * response and can be killed with the invocation — letting it write
     * `meta_daily` meant a page view could mask a dead cron ("synced 2m ago")
     * or fake a red for a pipe that was never broken.
     */
    await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      intraday: true,
    });
    expect((await runs())[0].kind).toBe("meta_intraday");
  });

  it("🔴 marks the run failed and rethrows when the client has no ad account", async () => {
    activeAccounts = [];

    await expect(
      mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" }),
    ).rejects.toThrow(/no Meta ad account/i);

    // A sync that silently no-ops is exactly the failure that left six blocks
    // of the old spreadsheet empty.
    const [r] = await runs();
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/no Meta ad account/i);
  });

  it("🔴 records the API's own message, then rethrows", async () => {
    dailyError = new Error("Meta says: (#17) User request limit reached");

    await expect(
      mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" }),
    ).rejects.toThrow(/#17/);

    // The message has to survive onto the run row: "sync failed" tells the
    // operator nothing, while a throttling code tells them to wait and a token
    // error tells them to reconnect.
    const [r] = await runs();
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/User request limit reached/);
  });
});

/* ------------------------------------------------------------------ *
 * Freshness stamps — the two that health reads
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — freshness stamps", () => {
  it("stamps lastSyncedAt on success", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    expect((await clientStamps()).last_synced_at).not.toBeNull();
  });

  it("🔴 stamps lastMetaReconciledAt ONLY for a real reconciliation", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    /*
     * The intraday path calls this same function with since = until = today. If
     * that counted as a reconcile, a dashboard someone keeps open would look
     * permanently up to date while never being trued up against Meta's 28-day
     * restatements.
     */
    let stamps = await clientStamps();
    expect(stamps.last_synced_at).not.toBeNull();
    expect(stamps.last_meta_reconciled_at).toBeNull();

    await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      isReconcile: true,
    });
    stamps = await clientStamps();
    expect(stamps.last_meta_reconciled_at).not.toBeNull();
  });

  it("🔴 leaves both stamps alone when the run fails", async () => {
    activeAccounts = [];

    await expect(
      mod.syncClientMetrics(client(), {
        since: "2026-07-20",
        until: "2026-07-20",
        isReconcile: true,
      }),
    ).rejects.toThrow();

    // A failed run that looked reconciled would make the overdue gate skip this
    // client until tomorrow — a whole day of drift, invisibly.
    expect(await clientStamps()).toMatchObject({
      last_synced_at: null,
      last_meta_reconciled_at: null,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Multiple ad accounts
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — multi-account", () => {
  it("🔴 accumulates across accounts instead of one overwriting another", async () => {
    activeAccounts = ACCOUNTS;

    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    /*
     * Every row is tagged with its own `meta_ad_account_id`, which is part of
     * the unique key. Without that tag both accounts collapse onto one row and
     * a two-account client reports half its spend.
     */
    const rows = (await run(
      `SELECT meta_ad_account_id, spend FROM fb_daily_metrics ORDER BY meta_ad_account_id`,
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.meta_ad_account_id)).toEqual(["111", "222"]);
  });

  it("serialises the accounts rather than firing them together", async () => {
    activeAccounts = ACCOUNTS;
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    // Meta warns that several concurrent insights queries invite throttling,
    // which costs the whole run rather than one request.
    expect(calls.filter((c) => c.method === "daily").map((c) => c.account)).toEqual([
      "111",
      "222",
    ]);
  });

  it("stamps each account's own lastSyncedAt", async () => {
    activeAccounts = ACCOUNTS;
    await run(
      `INSERT INTO meta_ad_accounts (id, client_id, ad_account_id) VALUES
         ('${ACC_1}', '${CLIENT_ID}', '111'),
         ('${ACC_2}', '${CLIENT_ID}', '222')`,
    );
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    const rows = (await run(
      `SELECT ad_account_id FROM meta_ad_accounts WHERE last_synced_at IS NOT NULL ORDER BY ad_account_id`,
    )).rows;
    expect(rows.map((r) => r.ad_account_id)).toEqual(["111", "222"]);
  });
});

/* ------------------------------------------------------------------ *
 * Upserting
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — upsert", () => {
  it("🔴 re-running the same window updates rather than duplicating", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    insightRows = [insight({ spend: "999.99", actions: [{ action_type: "lead", value: "20" }] })];
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    /*
     * The nightly job re-pulls the whole 28-day restatement window every night.
     * If that inserted instead of upserting, a month of spend would multiply by
     * the number of nights it had been running.
     */
    const rows = (await run(`SELECT spend, leads_total FROM fb_daily_metrics`)).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].spend)).toBe(999.99);
    expect(rows[0].leads_total).toBe(20);
  });

  it("🔴 flags rows inside Meta's restatement window as provisional", async () => {
    const today = new Date().toISOString().slice(0, 10);
    insightRows = [insight({ date_start: today }), insight({ date_start: "2020-01-01" })];

    await mod.syncClientMetrics(client(), { since: "2020-01-01", until: today });

    const rows = (await run(
      `SELECT date::text AS d, is_provisional FROM fb_daily_metrics ORDER BY d`,
    )).rows;
    // Old data is final; anything Meta may still restate is marked so the UI
    // can say the number is not settled yet.
    expect(rows[0]).toMatchObject({ d: "2020-01-01", is_provisional: false });
    expect(rows[1]).toMatchObject({ d: today, is_provisional: true });
  });

  it("keeps campaign rows on their own key with empty adset/ad ids", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    // Empty strings above ad level are what stop a campaign row and an ad row
    // colliding on the unique key.
    expect((await run(
      `SELECT level, meta_adset_id, meta_ad_id, quality_ranking FROM fb_daily_metrics`,
    )).rows[0]).toMatchObject({
      level: "campaign",
      meta_adset_id: "",
      meta_ad_id: "",
      // Rankings exist only at ad level; storing Meta's "unknown" above it would
      // read as a real diagnostic rather than a question that does not apply.
      quality_ranking: null,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Reach and breakdowns
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — reach", () => {
  it("is skipped unless asked for", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    expect(calls.some((c) => c.method === "reach")).toBe(false);
  });

  it("🔴 caches period reach separately, because it cannot be summed", async () => {
    reachRows = [{ campaignId: "", reach: 5000, frequency: 1.83 }];

    await mod.syncClientMetrics(client(), {
      since: "2026-07-01",
      until: "2026-07-20",
      includeReach: true,
    });

    /*
     * Reach is deduplicated PEOPLE. Adding 20 daily values overstates a month
     * 2–5×, so the period total has to be its own query against its own row —
     * it can never be derived from the daily table.
     */
    const rows = (await run(
      `SELECT period_start::text AS s, period_end::text AS e, reach, meta_campaign_id
         FROM fb_period_reach`,
    )).rows;
    expect(rows).toEqual([
      { s: "2026-07-01", e: "2026-07-20", reach: 5000, meta_campaign_id: "" },
    ]);
  });
});

describe("syncClientMetrics — breakdowns", () => {
  it("🔴 records a rejected breakdown without failing the whole sync", async () => {
    breakdownError = new Error("(#100) breakdown combination not supported");

    const res = await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      includeBreakdowns: true,
    });

    /*
     * One rejected breakdown must not discard a sync that pulled spend and
     * leads correctly — but it must not vanish either, or that panel silently
     * serves stale data forever. Visible on the run, not fatal to it.
     */
    expect(res.rowsWritten).toBeGreaterThan(0);
    const [r] = await runs();
    expect(r.status).toBe("success");
    expect((r.meta as { breakdownFailures?: string[] }).breakdownFailures?.length)
      .toBeGreaterThan(0);
  });

  it("says nothing about breakdowns when they all succeed", async () => {
    await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      includeBreakdowns: true,
    });
    const [r] = await runs();
    expect((r.meta as { breakdownFailures?: string[] }).breakdownFailures).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * refreshIfStale — the stale-while-revalidate path
 * ------------------------------------------------------------------ */

/**
 * ⚠️ Only the gates BEFORE the lock are covered here, and that is a harness
 * limit rather than a choice.
 *
 * `refreshIfStale` opens a transaction to take `pg_try_advisory_xact_lock`, then
 * calls `syncClientMetrics` inside it — and that call writes through the
 * module-level `db`, not the transaction handle. Against Neon that is fine and
 * deliberate: it is a connection POOL, so the lock is held on one connection
 * for the duration while the sync writes on another.
 *
 * PGlite has exactly ONE connection. The inner query queues behind the still-open
 * transaction and neither can proceed — a deadlock, verified directly: a
 * transaction whose callback queries the outer `db` never resolves, while the
 * same transaction using `tx` completes and `pg_try_advisory_xact_lock` itself
 * works fine.
 *
 * So the locked path cannot be exercised in-process, and faking a transaction to
 * force it would assert behaviour that does not match production — worse than
 * not asserting it. What that leaves untested here: that the refresh syncs only
 * TODAY, that it logs as intraday, and that it swallows its own failure. Those
 * need a real pooled Postgres.
 */
describe("refreshIfStale — the gates before the lock", () => {
  it("does nothing for a dashboard synced moments ago", async () => {
    const fresh = client({ lastSyncedAt: new Date(Date.now() - 60_000) });

    expect(await mod.refreshIfStale(fresh)).toBe(false);
    // Ten people opening the same fresh dashboard must not each burn an API
    // call — and must not each wait for one.
    expect(calls).toHaveLength(0);
  });

  it("treats a never-synced client as stale rather than fresh", async () => {
    // `lastSyncedAt` null must not read as "recently synced" — a brand new
    // client would then never pull anything until the first nightly cron.
    activeAccounts = [];
    expect(await mod.refreshIfStale(client({ lastSyncedAt: null }))).toBe(false);
    // Reached the account check, which is the gate after freshness.
    expect(calls).toHaveLength(0);
  });

  it("🔴 does nothing for a client with no ad accounts", async () => {
    activeAccounts = [];
    expect(await mod.refreshIfStale(client({ lastSyncedAt: new Date(0) }))).toBe(false);
    // Short-circuits before taking a lock, so a half-configured client cannot
    // hold one while doing nothing.
    expect((await runs())).toHaveLength(0);
  });

  it("exposes the freshness window as a constant the dashboard shares", () => {
    // The page and this module must agree on what "stale" means, or the page
    // triggers refreshes this function then declines to perform.
    expect(mod.STALE_AFTER_MS).toBe(15 * 60 * 1000);
  });
});

/* ------------------------------------------------------------------ *
 * reapAbandonedSyncRuns
 * ------------------------------------------------------------------ */

describe("reapAbandonedSyncRuns", () => {
  const insertRun = (status: string, minutesAgo: number, id: string) =>
    run(
      `INSERT INTO sync_runs (id, client_id, kind, status, started_at)
       VALUES ('${id}', '${CLIENT_ID}', 'meta_daily', '${status}',
               now() - interval '${minutesAgo} minutes')`,
    );

  it("🔴 fails a run that was killed without recording a terminal status", async () => {
    await insertRun("running", 120, "aaaaaaaa-0000-4000-8000-00000000ff01");

    expect(await mod.reapAbandonedSyncRuns(30)).toBe(1);

    /*
     * A run ends three ways: success, a caught error, or the process being
     * killed. The third writes nothing — a hard timeout at the route's
     * maxDuration runs neither branch — and the row sits in `running` forever,
     * so health reads a stale "in progress" instead of the failure it was.
     */
    const [r] = await runs();
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/abandoned/i);
  });

  it("leaves a run that is still plausibly alive", async () => {
    await insertRun("running", 5, "aaaaaaaa-0000-4000-8000-00000000ff02");
    expect(await mod.reapAbandonedSyncRuns(30)).toBe(0);
    expect((await runs())[0].status).toBe("running");
  });

  it("🔴 never touches a run that already finished", async () => {
    await insertRun("success", 999, "aaaaaaaa-0000-4000-8000-00000000ff03");
    await insertRun("failed", 999, "aaaaaaaa-0000-4000-8000-00000000ff04");

    expect(await mod.reapAbandonedSyncRuns(30)).toBe(0);
    // Rewriting a success as failed would invent an outage that never happened.
    expect((await runs()).map((r) => r.status).sort()).toEqual(["failed", "success"]);
  });
});

/* ------------------------------------------------------------------ *
 * The window constant
 * ------------------------------------------------------------------ */

describe("RECONCILE_DAYS", () => {
  it("🔴 is coupled to Meta's restatement horizon", async () => {
    const { META_PROVISIONAL_DAYS } = await import("@/lib/dates");

    /*
     * These must not drift apart. When the re-pull window was 7 and the
     * provisional window 28, days 8–28 were flagged "still changing" and never
     * re-pulled — frozen at stale values that quietly disagreed with Ads
     * Manager forever.
     */
    expect(mod.RECONCILE_DAYS).toBe(META_PROVISIONAL_DAYS);
  });
});
