import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";
import type { Client } from "@/db/schema";
import { AD_PLATFORMS } from "@/lib/platforms";

/**
 * The currency a platform's view is priced in, and the time it is dated by.
 *
 * ── The failure this pins ─────────────────────────────────────────────
 *
 * The owner reported that he could not see TikTok stats. The TikTok sync was
 * healthy, with data current to the day before — but the TikTok view read its
 * "last synced" from `clients.last_synced_at`, which only the Meta sync writes.
 * For the one client running TikTok alone that column is NULL, so the header
 * said "Not synced yet", the footer "TikTok last synced: never", and the Board
 * the same: a working pipe presented as one that had never run.
 *
 * Against real Postgres (PGlite), because both facts are read off the advertiser
 * rows, and which rows count is a status predicate.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let currency: typeof import("./currency");
let queries: typeof import("./queries");

const HOUR_AGO = new Date("2026-10-24T11:00:00Z");
const DAYS_AGO = new Date("2026-10-21T11:00:00Z");
const LONG_AGO = new Date("2026-09-01T11:00:00Z");

/** A client the way the Meta columns describe it — both NULL unless given. */
const client = (over: Partial<Client> = {}) =>
  ({ id: CLIENT_A, metaCurrency: null, lastSyncedAt: null, ...over }) as Client;

async function run(q: string) {
  return harness.db.execute(sql.raw(q));
}

const ts = (d: Date | null) => (d ? `'${d.toISOString()}'` : "NULL");

async function advertiser(
  id: string,
  opts: { currency?: string | null; synced?: Date | null; status?: string; clientId?: string } = {},
) {
  await run(
    `INSERT INTO tiktok_ad_accounts (client_id, advertiser_id, currency, status, last_synced_at)
     VALUES ('${opts.clientId ?? CLIENT_A}', '${id}', ${opts.currency ? `'${opts.currency}'` : "NULL"},
             '${opts.status ?? "active"}', ${ts(opts.synced ?? null)})`,
  );
}

beforeAll(async () => {
  harness = await createTestDb();
  currency = await import("./currency");
  queries = await import("./queries");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(`TRUNCATE tiktok_ad_accounts, google_ad_accounts, meta_ad_accounts RESTART IDENTITY CASCADE`);
});

describe("getTiktokAccountSummary", () => {
  it("🔴 reads the sync time and currency off the advertiser rows", async () => {
    await advertiser("7001", { currency: "GBP", synced: HOUR_AGO });
    expect(await queries.getTiktokAccountSummary(CLIENT_A)).toEqual({
      currency: "GBP",
      lastSynced: HOUR_AGO,
    });
  });

  it("dates the client by its most recently synced advertiser", async () => {
    await advertiser("7001", { currency: "GBP", synced: DAYS_AGO });
    await advertiser("7002", { currency: "GBP", synced: HOUR_AGO });
    await advertiser("7003", { currency: "GBP", synced: null });
    expect((await queries.getTiktokAccountSummary(CLIENT_A)).lastSynced).toEqual(HOUR_AGO);
  });

  it("does not let a removed advertiser, or another client's, vouch for this one", async () => {
    await advertiser("7001", { currency: "GBP", synced: LONG_AGO });
    await advertiser("7002", { currency: "EUR", synced: HOUR_AGO, status: "removed" });
    await advertiser("7003", { currency: "CAD", synced: HOUR_AGO, clientId: CLIENT_B });
    expect(await queries.getTiktokAccountSummary(CLIENT_A)).toEqual({
      currency: "GBP",
      lastSynced: LONG_AGO,
    });
  });

  it("reports nothing for a client with no advertiser", async () => {
    expect(await queries.getTiktokAccountSummary(CLIENT_A)).toEqual({
      currency: null,
      lastSynced: null,
    });
  });
});

describe("platformCurrencyAndSync", () => {
  it("🔴 dates and prices a TikTok-only client's view by TikTok", async () => {
    // Meta's columns are NULL here, exactly as for a client Meta never synced.
    await advertiser("7001", { currency: "GBP", synced: HOUR_AGO });
    expect(await currency.platformCurrencyAndSync(client(), "tiktok")).toEqual({
      currency: "GBP",
      syncedAt: HOUR_AGO,
    });
  });

  it("🔴 never borrows Meta's time or currency for TikTok, even when Meta has them", async () => {
    await advertiser("7001", { currency: "GBP", synced: DAYS_AGO });
    const both = client({ metaCurrency: "USD", lastSyncedAt: HOUR_AGO });
    expect(await currency.platformCurrencyAndSync(both, "tiktok")).toEqual({
      currency: "GBP",
      syncedAt: DAYS_AGO,
    });
  });

  it("says TikTok never synced when it never has, rather than borrowing Meta's time", async () => {
    await advertiser("7001", { currency: "GBP", synced: null });
    const both = client({ metaCurrency: "USD", lastSyncedAt: HOUR_AGO });
    expect((await currency.platformCurrencyAndSync(both, "tiktok")).syncedAt).toBeNull();
  });

  it("prices TikTok in Meta's currency, then USD, only when TikTok reported none", async () => {
    await advertiser("7001", { currency: null, synced: HOUR_AGO });
    expect((await currency.platformCurrencyAndSync(client({ metaCurrency: "AUD" }), "tiktok")).currency).toBe(
      "AUD",
    );
    expect((await currency.platformCurrencyAndSync(client(), "tiktok")).currency).toBe("USD");
  });

  it("keeps Meta on the client row and Google on its accounts, as before", async () => {
    await run(
      `INSERT INTO google_ad_accounts (client_id, customer_id, currency, is_primary, last_synced_at)
       VALUES ('${CLIENT_A}', '1234567890', 'CAD', true, ${ts(DAYS_AGO)})`,
    );
    const c = client({ metaCurrency: "USD", lastSyncedAt: HOUR_AGO });
    expect(await currency.platformCurrencyAndSync(c, "meta")).toEqual({ currency: "USD", syncedAt: HOUR_AGO });
    expect(await currency.platformCurrencyAndSync(c, "google")).toEqual({ currency: "CAD", syncedAt: DAYS_AGO });
  });

  it("🔴 the Board prices every platform exactly as the Overview does", async () => {
    // `currency.ts` used to say TikTok kept Meta's currency "so the two screens
    // agree until that gap is fixed in both places". They now share one switch.
    await advertiser("7001", { currency: "GBP", synced: HOUR_AGO });
    await run(
      `INSERT INTO google_ad_accounts (client_id, customer_id, currency, is_primary)
       VALUES ('${CLIENT_A}', '1234567890', 'CAD', true)`,
    );
    const c = client({ metaCurrency: "USD" });
    for (const p of AD_PLATFORMS) {
      expect(await currency.platformCurrency(c, p), p).toBe(
        (await currency.platformCurrencyAndSync(c, p)).currency,
      );
    }
  });
});

describe("wiring", () => {
  // Comments stripped: several of these files explain, in prose, the very
  // read they no longer make.
  const src = (...p: string[]) =>
    readFileSync(join(process.cwd(), ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("🔴 the Overview's loader dates and prices its view through the shared switch", () => {
    expect(src("src", "lib", "metrics", "dashboard.ts")).toContain(
      "platformCurrencyAndSync(client, platform)",
    );
  });

  it("🔴 the Board's header and its documents are not dated from Meta's column", () => {
    for (const file of [
      ["src", "app", "c", "[slug]", "board", "page.tsx"],
      ["src", "components", "board", "BoardDocument.tsx"],
    ]) {
      expect(src(...file), file.join("/")).not.toContain("client.lastSyncedAt");
    }
  });
});
