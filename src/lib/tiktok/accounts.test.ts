import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * Attaching, listing and detaching a TikTok advertiser.
 *
 * Two things here carry weight beyond their size. The first is the status
 * predicate, which three separate readers restate and which decides whether an
 * advertiser is synced at all. The second is what attaching an advertiser must
 * NOT do: TikTok arrives late, after months of Meta or Google data already
 * bucketed in the client's timezone, so adopting its timezone would move every
 * historical day boundary on the dashboard.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

const advertiser = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    TiktokClient: class {
      getAdvertiser = advertiser;
    },
  };
});

let mod: typeof import("./accounts");

const AGENCY = "aaaaaaaa-0000-4000-8000-00000000000a";
const CLIENT = "11111111-1111-1111-1111-111111111111";

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const rows = async () =>
  (
    await run(
      `SELECT advertiser_id, advertiser_name, status, currency, timezone,
              access_token_encrypted
         FROM tiktok_ad_accounts WHERE client_id = '${CLIENT}'
        ORDER BY advertiser_id`,
    )
  ).rows;

beforeAll(async () => {
  harness = await createTestDb();
  process.env.ENCRYPTION_KEY = "b".repeat(64);
  mod = await import("./accounts");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await run(`TRUNCATE tiktok_ad_accounts, clients, agencies RESTART IDENTITY CASCADE`);
  await run(
    `INSERT INTO agencies (id, name, slug) VALUES ('${AGENCY}', 'GG', 'gg')`,
  );
  await run(
    `INSERT INTO clients (id, name, slug, agency_id, timezone, meta_currency)
     VALUES ('${CLIENT}', 'Acme', 'acme', '${AGENCY}', 'America/Los_Angeles', 'USD')`,
  );
});

const seed = async (advertiserId: string, status = "active") =>
  run(
    `INSERT INTO tiktok_ad_accounts (client_id, advertiser_id, status)
     VALUES ('${CLIENT}', '${advertiserId}', '${status}')`,
  );

/* ------------------------------------------------------------------ *
 * The status predicate
 * ------------------------------------------------------------------ */

describe("🔴 the status predicate agrees across all three readers", () => {
  /*
   * `activeTiktokAccounts` (sync, health, per-client pipe status),
   * `activeTiktokAccountsForDisplay` (the settings list), and the batched SQL
   * in `metrics/pipe-status.ts` (the portfolio panel) all answer "which
   * advertisers does this client have". They must select the same rows, and for
   * a while they did not — this module tested `=== "active"` while the other
   * two tested `<> "removed"`.
   *
   * It was invisible because only two statuses are ever written, which is
   * exactly the condition under which a disagreement survives review and then
   * breaks the day a third appears. So the property is asserted over statuses
   * the app does not write yet.
   */
  const STATUSES = ["active", "paused", "disabled", "under_review", "removed"];

  beforeEach(async () => {
    for (const s of STATUSES) await seed(`adv_${s}`, s);
  });

  it("keeps everything except removed", async () => {
    const kept = (await mod.activeTiktokAccounts(CLIENT)).map((a) => a.status).sort();
    expect(kept).toEqual(STATUSES.filter((s) => s !== "removed").sort());
  });

  it("matches what the settings list shows", async () => {
    // A row the sync ignores but the settings page still lists reads as a
    // connected advertiser that never produces data — the green-over-a-dead-
    // pipe shape this product exists to remove.
    const forSync = (await mod.activeTiktokAccounts(CLIENT))
      .map((a) => a.advertiserId)
      .sort();
    const forDisplay = (await mod.activeTiktokAccountsForDisplay(CLIENT)).accounts
      .map((a) => a.advertiserId)
      .sort();
    expect(forSync).toEqual(forDisplay);
  });

  it("matches the SQL the portfolio panel restates", async () => {
    // The batched reader counts every client in one query, so it cannot call
    // the function and has to restate the rule. A restatement is the thing that
    // drifts, so run both over the same rows.
    const viaFunction = (await mod.activeTiktokAccounts(CLIENT)).length;
    const viaSql = Number(
      (
        await run(
          `SELECT COUNT(*)::int AS n FROM tiktok_ad_accounts
            WHERE client_id = '${CLIENT}' AND status <> 'removed'`,
        )
      ).rows[0].n,
    );
    expect(viaFunction).toBe(viaSql);
  });
});

describe("activeTiktokAccountsForDisplay", () => {
  it("degrades to an empty list rather than taking the page down", async () => {
    /*
     * This table arrives in a migration, and a deploy that lands before its
     * migration would otherwise throw on every dashboard render — over a
     * platform the client may not use at all. The error is returned, not
     * swallowed: an empty list with no explanation is the failure mode this
     * whole product replaces.
     */
    await run(`DROP TABLE tiktok_ad_accounts`);
    const res = await mod.activeTiktokAccountsForDisplay(CLIENT);
    expect(res.accounts).toEqual([]);
    expect(res.error).toBeTruthy();
    await run(`CREATE TABLE tiktok_ad_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL, advertiser_id text NOT NULL, advertiser_name text,
      access_token_encrypted text, currency text, timezone text,
      status text NOT NULL DEFAULT 'active', last_synced_at timestamptz,
      last_error text, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tiktok_ad_accounts_key UNIQUE (client_id, advertiser_id))`);
  });
});

/* ------------------------------------------------------------------ *
 * Attaching
 * ------------------------------------------------------------------ */

describe("addTiktokAccount", () => {
  const info = (over: Record<string, unknown> = {}) => ({
    advertiser_name: "Acme TikTok",
    currency: "USD",
    timezone: "America/Los_Angeles",
    ...over,
  });

  it("verifies against the API before storing anything", async () => {
    /*
     * Verify-then-store. An advertiser the grant cannot reach, stored anyway,
     * surfaces later as an account reporting zero spend forever — which on this
     * dashboard is indistinguishable from a paused campaign.
     */
    advertiser.mockResolvedValue(null);
    await expect(mod.addTiktokAccount(CLIENT, "1234567890", "tok")).rejects.toThrow(
      /cannot reach/i,
    );
    expect(await rows()).toHaveLength(0);
  });

  it("stores the grant encrypted, never in the clear", async () => {
    advertiser.mockResolvedValue(info());
    await mod.addTiktokAccount(CLIENT, "1234567890", "secret-grant");
    const [row] = await rows();
    expect(row.access_token_encrypted).toBeTruthy();
    expect(String(row.access_token_encrypted)).not.toContain("secret-grant");
  });

  it("🔴 never adopts the advertiser's timezone onto the client", async () => {
    /*
     * The one thing this must not do. Meta's equivalent DOES write
     * `clients.timezone`, because the first ad account defines how days are
     * bucketed. TikTok arrives late, on top of months of data already bucketed
     * the old way, so re-pointing it here would shift every historical day
     * boundary on the dashboard — for a platform just added as a secondary.
     */
    advertiser.mockResolvedValue(info({ timezone: "Asia/Tokyo" }));
    const res = await mod.addTiktokAccount(CLIENT, "1234567890", "tok");

    const [client] = (
      await run(`SELECT timezone FROM clients WHERE id = '${CLIENT}'`)
    ).rows;
    expect(client.timezone).toBe("America/Los_Angeles");
    // Reported instead, so a real disagreement is a sentence someone reads.
    expect(res.timezoneMismatch).toEqual({
      client: "America/Los_Angeles",
      thisAccount: "Asia/Tokyo",
    });
  });

  it("reports a currency mismatch rather than converting", async () => {
    // Summing GBP spend into a USD total is the kind of wrong number that looks
    // completely plausible.
    advertiser.mockResolvedValue(info({ currency: "GBP" }));
    const res = await mod.addTiktokAccount(CLIENT, "1234567890", "tok");
    expect(res.currencyMismatch).toEqual({ client: "USD", thisAccount: "GBP" });
  });

  it("stays silent when currency and timezone agree", async () => {
    advertiser.mockResolvedValue(info());
    const res = await mod.addTiktokAccount(CLIENT, "1234567890", "tok");
    expect(res.currencyMismatch).toBeUndefined();
    expect(res.timezoneMismatch).toBeUndefined();
  });

  it("re-attaching refreshes the grant instead of duplicating the row", async () => {
    advertiser.mockResolvedValue(info());
    await mod.addTiktokAccount(CLIENT, "1234567890", "first-grant");
    advertiser.mockResolvedValue(info({ advertiser_name: "Renamed" }));
    await mod.addTiktokAccount(CLIENT, "1234567890", "second-grant");

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].advertiser_name).toBe("Renamed");
  });

  it("🔴 re-attaching a removed advertiser brings it back", async () => {
    // Otherwise "remove, then reconnect" — the obvious way to fix a bad grant —
    // leaves a row that looks connected in settings and is skipped by the sync.
    await seed("1234567890", "removed");
    advertiser.mockResolvedValue(info());
    await mod.addTiktokAccount(CLIENT, "1234567890", "tok");
    expect((await rows())[0].status).toBe("active");
  });
});

/* ------------------------------------------------------------------ *
 * Detaching
 * ------------------------------------------------------------------ */

describe("removeTiktokAccount", () => {
  it("🔴 marks removed rather than deleting", async () => {
    /*
     * The metrics already pulled under this advertiser stay in
     * `tiktok_daily_metrics`. Deleting the row would make every historical
     * total silently drop — a change in the past, with no event to explain it.
     */
    await seed("1234567890");
    const [row] = (
      await run(`SELECT id FROM tiktok_ad_accounts WHERE advertiser_id = '1234567890'`)
    ).rows;

    await mod.removeTiktokAccount(CLIENT, String(row.id));
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("removed");
  });

  it("🔴 refuses to detach another client's advertiser", async () => {
    /*
     * The account id arrives from a URL. Without the client in the WHERE this
     * detaches across the tenancy boundary — and it does not error, so nobody
     * finds out until that client's spend quietly stops.
     */
    const OTHER = "22222222-2222-2222-2222-222222222222";
    await run(
      `INSERT INTO clients (id, name, slug, agency_id) VALUES ('${OTHER}', 'Rival', 'rival', '${AGENCY}')`,
    );
    await run(
      `INSERT INTO tiktok_ad_accounts (client_id, advertiser_id) VALUES ('${OTHER}', 'theirs')`,
    );
    const [row] = (
      await run(`SELECT id FROM tiktok_ad_accounts WHERE advertiser_id = 'theirs'`)
    ).rows;

    await expect(mod.removeTiktokAccount(CLIENT, String(row.id))).rejects.toThrow(
      /not found/i,
    );
    const [still] = (
      await run(`SELECT status FROM tiktok_ad_accounts WHERE advertiser_id = 'theirs'`)
    ).rows;
    expect(still.status).toBe("active");
  });

  it("reports a missing account rather than succeeding silently", async () => {
    await expect(
      mod.removeTiktokAccount(CLIENT, "99999999-9999-4999-8999-999999999999"),
    ).rejects.toThrow(/not found/i);
  });
});
