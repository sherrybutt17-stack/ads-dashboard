import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * The platform the Overview, the report and meeting mode open on, from the
 * client's real account rows.
 *
 * The pure rule is tested in `platforms.test.ts`; this is the read in front of
 * it — which rows count as "has an account" — against real Postgres, because
 * that is a status predicate per table and a tenant predicate per query.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let mod: typeof import("./platform");

async function run(q: string) {
  return harness.db.execute(sql.raw(q));
}

const meta = (status = "active", clientId = CLIENT_A) =>
  run(`INSERT INTO meta_ad_accounts (client_id, ad_account_id, status)
       VALUES ('${clientId}', 'act_${status}_${clientId.slice(0, 4)}', '${status}')`);
const google = (status = "active", clientId = CLIENT_A) =>
  run(`INSERT INTO google_ad_accounts (client_id, customer_id, status)
       VALUES ('${clientId}', '${status}-${clientId.slice(0, 4)}', '${status}')`);
const tiktok = (status = "active", clientId = CLIENT_A) =>
  run(`INSERT INTO tiktok_ad_accounts (client_id, advertiser_id, status)
       VALUES ('${clientId}', '${status}-${clientId.slice(0, 4)}', '${status}')`);

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./platform");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await run(`TRUNCATE meta_ad_accounts, google_ad_accounts, tiktok_ad_accounts RESTART IDENTITY CASCADE`);
});

describe("connectedAdPlatforms", () => {
  it("sees a TikTok-only client as exactly that", async () => {
    await tiktok();
    expect(await mod.connectedAdPlatforms(CLIENT_A)).toEqual({ meta: false, google: false, tiktok: true });
  });

  it("does not count a removed account, on any platform", async () => {
    await meta("removed");
    await google("removed");
    await tiktok("removed");
    expect(await mod.connectedAdPlatforms(CLIENT_A)).toEqual({ meta: false, google: false, tiktok: false });
  });

  it("does not count another client's accounts", async () => {
    await meta("active", CLIENT_B);
    await google("active", CLIENT_B);
    await tiktok("active", CLIENT_B);
    expect(await mod.connectedAdPlatforms(CLIENT_A)).toEqual({ meta: false, google: false, tiktok: false });
  });
});

describe("resolvePagePlatform", () => {
  it("🔴 opens a TikTok-only client's report and deck on TikTok, not on Meta", async () => {
    await tiktok();
    expect(await mod.resolvePagePlatform(CLIENT_A, undefined)).toBe("tiktok");
  });

  it("opens a client with Meta on Meta, as it always did", async () => {
    await meta();
    await tiktok();
    expect(await mod.resolvePagePlatform(CLIENT_A, undefined)).toBe("meta");
  });

  it("opens a client with nothing connected on Meta's empty view", async () => {
    expect(await mod.resolvePagePlatform(CLIENT_A, undefined)).toBe("meta");
  });

  it("🔴 honours a named platform, and reads no account list to do it", async () => {
    // A report link names its platform, and a kept one must keep opening it —
    // here Meta, on a client that has since gone TikTok-only.
    await tiktok();
    const select = vi.spyOn(harness.db, "select");
    expect(await mod.resolvePagePlatform(CLIENT_A, "meta")).toBe("meta");
    expect(select).not.toHaveBeenCalled();
    // The control: without a name it does read them, so the spy is watching.
    expect(await mod.resolvePagePlatform(CLIENT_A, "facebook")).toBe("tiktok");
    expect(select).toHaveBeenCalled();
  });
});
