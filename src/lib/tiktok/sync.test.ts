import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Client } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * The TikTok ingest run.
 *
 * ── What is genuinely different here ──────────────────────────────────
 *
 * The bookkeeping mirrors Meta and Google, and is asserted for the same reason
 * — a sync that marks another platform's work done produces a green health
 * check over a dead pipe. But TikTok carries two things the others do not:
 *
 *  1. **`stat_time_day` is not a date.** It arrives as `"2026-07-01 00:00:00"`.
 *     Postgres accepts that into a `date` column and drops the time, so the
 *     stored value looks right — but as a UNIQUE-KEY value the untruncated and
 *     truncated forms are two different strings, so one day would upsert into
 *     two rows and double that day's spend. `dayof.test.ts` covers the
 *     truncation; only a real insert covers the consequence.
 *
 *  2. **A missing token is a normal end state, not a bug.** TikTok invalidates
 *     a token when the authorising user loses access, so the account has to
 *     carry a "re-authorise" message rather than the sync reporting zero spend
 *     — zero spend and no access look identical on a dashboard.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let insightRows: unknown[] = [];
let insightsError: Error | null = null;
const calls: { advertiser: string; since: string; until: string }[] = [];

vi.mock("./client", async (importOriginal) => {
  // `dayOf` and `num` stay REAL — the truncation is the thing under test.
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    TiktokClient: class {
      constructor(readonly token: string) {}
      async getDailyInsights(advertiserId: string, since: string, until: string) {
        calls.push({ advertiser: advertiserId, since, until });
        if (insightsError) throw insightsError;
        return insightRows;
      }
    },
  };
});

const ACC_1 = "cccccccc-0000-4000-8000-000000000001";
const ACC_2 = "cccccccc-0000-4000-8000-000000000002";
let activeAccounts: Record<string, unknown>[] = [];

vi.mock("./accounts", () => ({
  activeTiktokAccounts: async () => activeAccounts,
}));

let mod: typeof import("./sync");
let encrypt: (s: string) => string;

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
  (await run(`SELECT kind, status, rows_written, error FROM sync_runs ORDER BY started_at`)).rows;

const accountRows = async () =>
  (
    await run(
      `SELECT advertiser_id, last_error, last_synced_at FROM tiktok_ad_accounts ORDER BY advertiser_id`,
    )
  ).rows;

const stamps = async () =>
  (
    await run(
      `SELECT last_synced_at, last_tiktok_reconciled_at, last_meta_reconciled_at,
              last_google_reconciled_at
         FROM clients WHERE id = '${CLIENT_ID}'`,
    )
  ).rows[0];

/** A TikTok insights row, in the nested shape their API returns. */
const insight = (over: { day?: string; campaign?: string; spend?: string } = {}) => ({
  dimensions: {
    stat_time_day: over.day ?? "2026-07-20 00:00:00",
    campaign_id: over.campaign ?? "tcamp_1",
  },
  metrics: {
    campaign_name: "TikTok — Prospecting",
    impressions: "4000",
    clicks: "120",
    spend: over.spend ?? "75.40",
    conversion: "6",
  },
});

/** Seed an advertiser row and make it the active one. */
async function seedAccount(id: string, advertiserId: string, token: string | null) {
  await run(
    `INSERT INTO tiktok_ad_accounts (id, client_id, advertiser_id, currency, status, access_token_encrypted)
     VALUES ('${id}', '${CLIENT_ID}', '${advertiserId}', 'USD', 'active',
             ${token === null ? "NULL" : `'${encrypt(token)}'`})`,
  );
  return {
    id,
    clientId: CLIENT_ID,
    advertiserId,
    currency: "USD",
    status: "active",
    accessTokenEncrypted: token === null ? null : encrypt(token),
  };
}

beforeAll(async () => {
  harness = await createTestDb();
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  ({ encrypt } = await import("@/lib/crypto"));
  mod = await import("./sync");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  calls.length = 0;
  insightRows = [insight()];
  insightsError = null;
  await run(
    `TRUNCATE sync_runs, tiktok_daily_metrics, tiktok_ad_accounts, clients RESTART IDENTITY CASCADE`,
  );
  await run(
    `INSERT INTO clients (id, name, slug, agency_id, timezone) VALUES ('${CLIENT_ID}', 'Acme', 'acme', '${AGENCY}', '${TZ}')`,
  );
  activeAccounts = [await seedAccount(ACC_1, "adv_1", "tok-1")];
});

/* ------------------------------------------------------------------ *
 * The date that is not a date
 * ------------------------------------------------------------------ */

describe("syncClientTiktokMetrics — stat_time_day", () => {
  it("both spellings of a day land on one row", async () => {
    insightRows = [
      insight({ day: "2026-07-20 00:00:00", spend: "10.00" }),
      insight({ day: "2026-07-20", spend: "25.00" }),
    ];

    await mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    /*
     * ⚠️ Behaviour worth pinning, but note WHAT enforces it: the column is
     * `date`, and Postgres coerces `"2026-07-20 00:00:00"` to `2026-07-20`
     * BEFORE evaluating the unique index — verified directly. So this converges
     * on one row with or without the truncation in `dayOf`.
     *
     * The module comment claims the two spellings "would produce two rows for
     * one day". Against this column they would not. `dayOf` earns its place for
     * the reason below instead.
     */
    const rows = (await run(`SELECT date::text AS d, spend FROM tiktok_daily_metrics`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].d).toBe("2026-07-20");
    expect(Number(rows[0].spend)).toBe(25);
  });

  it("🔴 a malformed date skips its row instead of killing the whole run", async () => {
    insightRows = [
      insight({ day: "2026-07-20 00:00:00", spend: "10.00" }),
      insight({ day: "not-a-date" }),
      insight({ day: "2026-07-21 00:00:00", spend: "20.00" }),
    ];

    const res = await mod.syncClientTiktokMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-21",
    });

    /*
     * This is what `dayOf` actually protects. An unvalidated value reaches the
     * driver as `invalid input syntax for type date`, which throws out of the
     * insert loop and aborts the run — so ONE unparseable row would discard
     * every row after it in the batch and mark the whole sync failed.
     *
     * Guessing a date instead would be worse than skipping: it would put spend
     * on the wrong side of a month boundary, which is exactly where an operator
     * checks the number.
     */
    expect(res.rowsWritten).toBe(2);
    expect((await runs())[0].status).toBe("success");
    expect(
      (await run(`SELECT date::text AS d FROM tiktok_daily_metrics ORDER BY d`)).rows
        .map((r) => r.d),
    ).toEqual(["2026-07-20", "2026-07-21"]);
  });

  it("skips an empty date too", async () => {
    insightRows = [insight(), insight({ day: "" })];
    const res = await mod.syncClientTiktokMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
    });
    expect(res.rowsWritten).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Tokens — a missing one is a normal end state
 * ------------------------------------------------------------------ */

describe("syncClientTiktokMetrics — access tokens", () => {
  it("🔴 records 're-authorise' instead of reporting zero spend", async () => {
    activeAccounts = [await seedAccount(ACC_2, "adv_2", null)]; // the only one synced

    const res = await mod.syncClientTiktokMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
    });

    /*
     * TikTok invalidates a token when the authorising user loses access. On a
     * dashboard "no access" and "no spend" look identical, so the difference has
     * to be written down somewhere the health check can read it.
     */
    expect(res.rowsWritten).toBe(0);
    expect(calls).toHaveLength(0);
    // By advertiser, not by position: `beforeEach` seeds a working account too,
    // and asserting on [0] would have read that one instead.
    const acct = (await accountRows()).find((a) => a.advertiser_id === "adv_2")!;
    expect(String(acct.last_error)).toMatch(/re-authorise/i);
    // Not a sync failure — the run itself succeeded, it just had nothing to do.
    expect((await runs())[0].status).toBe("success");
  });

  it("🔴 records the API's message on the account, then rethrows", async () => {
    insightsError = new Error("TikTok says: 40105 access token expired");

    await expect(
      mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" }),
    ).rejects.toThrow(/40105/);

    // Both places matter: the account carries the reason for the health panel,
    // and the run carries it for the audit of what went wrong when.
    expect(String((await accountRows())[0].last_error)).toMatch(/40105/);
    expect(String((await runs())[0].error)).toMatch(/40105/);
  });

  it("🔴 clears a stale error once the advertiser syncs again", async () => {
    await run(`UPDATE tiktok_ad_accounts SET last_error = 'something old'`);

    await mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    // A cleared fault must actually clear, or the health panel keeps telling the
    // operator to re-authorise an advertiser that is working.
    const [acct] = await accountRows();
    expect(acct.last_error).toBeNull();
    expect(acct.last_synced_at).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Bookkeeping — the three platforms stay separate
 * ------------------------------------------------------------------ */

describe("syncClientTiktokMetrics — bookkeeping", () => {
  it("logs under its own sync kinds", async () => {
    await mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    await mod.syncClientTiktokMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      intraday: true,
    });
    expect((await runs()).map((r) => r.kind)).toEqual(["tiktok_daily", "tiktok_intraday"]);
  });

  it("🔴 marks only its OWN reconcile column, and only on a reconcile", async () => {
    await mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    expect((await stamps()).last_tiktok_reconciled_at).toBeNull();

    await mod.syncClientTiktokMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      isReconcile: true,
    });

    const s = await stamps();
    expect(s.last_tiktok_reconciled_at).not.toBeNull();
    // The three crons must not be able to mark each other's work done, and
    // `clients.last_synced_at` belongs to Meta's freshness check.
    expect(s.last_meta_reconciled_at).toBeNull();
    expect(s.last_google_reconciled_at).toBeNull();
    expect(s.last_synced_at).toBeNull();
  });

  it("🔴 leaves the reconcile marker alone when the run fails", async () => {
    insightsError = new Error("TikTok is down");
    await expect(
      mod.syncClientTiktokMetrics(client(), {
        since: "2026-07-20",
        until: "2026-07-20",
        isReconcile: true,
      }),
    ).rejects.toThrow();
    expect((await stamps()).last_tiktok_reconciled_at).toBeNull();
  });

  it("fails loudly when no advertiser is configured", async () => {
    activeAccounts = [];
    await expect(
      mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" }),
    ).rejects.toThrow(/no TikTok advertiser/i);
    expect((await runs())[0].status).toBe("failed");
  });
});

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

describe("syncClientTiktokMetrics — rows", () => {
  it("🔴 re-running the window updates rather than duplicating", async () => {
    await mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    insightRows = [insight({ spend: "999.00" })];
    await mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    /*
     * TikTok's click-through attribution reaches 28 days, so a conversion from
     * a day-1 click can land on day 27 and restate that day. The nightly
     * re-pull is what corrects it — inserting instead of upserting would
     * multiply the month instead.
     */
    const rows = (await run(`SELECT spend FROM tiktok_daily_metrics`)).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].spend)).toBe(999);
  });

  it("accumulates across advertisers", async () => {
    activeAccounts = [
      activeAccounts[0],
      await seedAccount(ACC_2, "adv_2", "tok-2"),
    ];

    await mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    expect(
      (await run(`SELECT advertiser_id FROM tiktok_daily_metrics ORDER BY advertiser_id`)).rows
        .map((r) => r.advertiser_id),
    ).toEqual(["adv_1", "adv_2"]);
  });

  it("takes the currency from the advertiser, never from the row", async () => {
    await mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    // Spend is only summable within one currency; the advertiser is the
    // authority, and mixing them silently adds dollars to euros.
    expect((await run(`SELECT currency FROM tiktok_daily_metrics`)).rows[0].currency).toBe("USD");
  });

  it("stores a campaign name only when TikTok sent a string", async () => {
    insightRows = [
      { ...insight(), metrics: { ...insight().metrics, campaign_name: 12345 } },
    ];
    await mod.syncClientTiktokMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    expect((await run(`SELECT campaign_name FROM tiktok_daily_metrics`)).rows[0].campaign_name)
      .toBeNull();
  });
});

describe("TIKTOK_RECONCILE_DAYS", () => {
  it("🔴 covers TikTok's full 28-day attribution window", async () => {
    /*
     * Raised from 7 when the nightly cron was added. 7 was only ever safe
     * because nothing re-pulled at all — a click-through conversion can land 27
     * days later and restate that day, so a 7-day window would freeze every
     * older day at whatever was true when it scrolled out.
     */
    const { META_PROVISIONAL_DAYS } = await import("@/lib/dates");
    expect(mod.TIKTOK_RECONCILE_DAYS).toBe(28);
    expect(mod.TIKTOK_RECONCILE_DAYS).toBe(META_PROVISIONAL_DAYS);
  });
});
