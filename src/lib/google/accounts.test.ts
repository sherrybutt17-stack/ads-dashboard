import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * Attaching a Google Ads customer account to a client.
 *
 * ── Why this exists separately from the Meta test ─────────────────────
 *
 * Because "the Google module mirrors the Meta module" is the assumption that
 * keeps producing bugs here. The two are near-copies, which means a fix applied
 * to one and not the other looks identical at a glance and behaves differently
 * — and the established habit in this codebase is that a non-Meta client is the
 * one nobody seeds, so the divergence survives.
 *
 * The dead-primary-promotion bug was exactly that: found by a Meta test,
 * present verbatim in this file, and invisible until a Google-only client was
 * seeded. So this file seeds one.
 *
 * Google also has one rule Meta does not: it must NOT clobber a display
 * currency Meta already set, because a client running both platforms buckets
 * its days by whichever was connected first.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

const googleCalls: { token: string; loginCustomerId?: string | null; customerId: string }[] = [];
let customerResponse: Record<string, unknown> = {};

vi.mock("./client", () => ({
  GoogleAdsClient: class {
    constructor(
      private readonly token: string,
      private readonly loginCustomerId?: string | null,
    ) {}
    async getCustomer(customerId: string) {
      googleCalls.push({
        token: this.token,
        loginCustomerId: this.loginCustomerId,
        customerId,
      });
      return { descriptiveName: "Acme Google", ...customerResponse };
    }
  },
  normalizeCustomerId: (raw: string) => raw.replace(/\D/g, ""),
}));

let mod: typeof import("./accounts");

const BOOTSTRAP = "00000000-0000-0000-0000-000000000001";
const OTHER_AGENCY = "bbbbbbbb-0000-4000-8000-00000000000b";
const CLIENT_A1 = "11111111-1111-1111-1111-111111111111";
const CLIENT_A2 = "22222222-2222-2222-2222-222222222222";
const CLIENT_B1 = "33333333-3333-3333-3333-333333333333";

const env = {
  key: process.env.ENCRYPTION_KEY,
  token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
};

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const clientRow = async (id: string) =>
  (
    await run(
      `SELECT meta_currency, meta_timezone, timezone FROM clients WHERE id = '${id}'`,
    )
  ).rows[0];

beforeAll(async () => {
  harness = await createTestDb();
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.GOOGLE_ADS_REFRESH_TOKEN = "shared-mcc-refresh-token";
  mod = await import("./accounts");
});

afterAll(async () => {
  await harness.close();
  if (env.key === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = env.key;
  if (env.token === undefined) delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
  else process.env.GOOGLE_ADS_REFRESH_TOKEN = env.token;
});

beforeEach(async () => {
  googleCalls.length = 0;
  customerResponse = { currencyCode: "USD", timeZone: "America/Los_Angeles" };
  await run(`TRUNCATE google_ad_accounts, clients RESTART IDENTITY CASCADE`);
  for (const [id, slug, agency] of [
    [CLIENT_A1, "acme", BOOTSTRAP],
    [CLIENT_A2, "acme-two", BOOTSTRAP],
    [CLIENT_B1, "rival", OTHER_AGENCY],
  ]) {
    await run(
      `INSERT INTO clients (id, name, slug, agency_id) VALUES ('${id}', '${slug}', '${slug}', '${agency}')`,
    );
  }
});

describe("addGoogleAccount — tenancy", () => {
  it("normalizes a dashed customer id and attaches it", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "123-456-7890");

    const [account] = await mod.listGoogleAccounts(CLIENT_A1);
    // Google shows customer ids dashed and the API wants them bare; storing the
    // display form would break every join against the metrics table.
    expect(account.customerId).toBe("1234567890");
    expect(account.isPrimary).toBe(true);
  });

  it("🔴 refuses an agency with no Google connection, before any API call", async () => {
    /*
     * Google is the worse of the two platforms to get wrong: every agency
     * riding one MCC refresh token means one tenant's abuse suspends API access
     * for all of them, with no per-tenant remedy short of rotating a credential
     * the whole platform depends on.
     */
    await expect(mod.addGoogleAccount(CLIENT_B1, "1234567890")).rejects.toThrow(
      /no Google Ads connection of its own/i,
    );
    expect(googleCalls).toHaveLength(0);
  });

  it("lets a non-bootstrap agency attach with its own refresh token", async () => {
    await mod.addGoogleAccount(CLIENT_B1, "1234567890", "their-own-refresh");

    expect(googleCalls[0].token).toBe("their-own-refresh");
    expect(await mod.activeGoogleAccounts(CLIENT_B1)).toHaveLength(1);
  });

  it("verifies through the same manager id the sync will use", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1234567890", undefined, "999-888-7777");

    // A wrong manager id must fail at connect time; otherwise the account
    // attaches cleanly and then reports zero spend forever.
    expect(googleCalls[0].loginCustomerId).toBe("999-888-7777");
  });

  it("refuses an unknown client rather than defaulting a tenant", async () => {
    await expect(
      mod.addGoogleAccount("00000000-0000-4000-8000-000000000000", "1234567890"),
    ).rejects.toThrow(/unknown client/i);
  });
});

describe("addGoogleAccount — clash detection", () => {
  it("names the conflicting client within the agency", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1234567890");

    await expect(mod.addGoogleAccount(CLIENT_A2, "1234567890")).rejects.toThrow(
      /already attached to acme\b/i,
    );
  });

  it("🔴 is silent about the same customer id in another agency", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1234567890");

    await mod.addGoogleAccount(CLIENT_B1, "1234567890", "their-own-refresh");

    expect(await mod.activeGoogleAccounts(CLIENT_B1)).toHaveLength(1);
    expect(await mod.activeGoogleAccounts(CLIENT_A1)).toHaveLength(1);
  });

  it("re-adding to the same client updates instead of throwing", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1234567890");
    customerResponse = { currencyCode: "USD", timeZone: "America/Denver" };

    await mod.addGoogleAccount(CLIENT_A1, "1234567890");

    const accounts = await mod.listGoogleAccounts(CLIENT_A1);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].timezone).toBe("America/Denver");
  });
});

describe("addGoogleAccount — display currency", () => {
  it("sets the client's currency and timezone when nothing has", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1234567890");

    expect(await clientRow(CLIENT_A1)).toMatchObject({
      meta_currency: "USD",
      timezone: "America/Los_Angeles",
    });
  });

  it("🔴 does not clobber a currency Meta already set", async () => {
    await run(
      `UPDATE clients SET meta_currency = 'CAD', meta_timezone = 'America/Toronto', timezone = 'America/Toronto' WHERE id = '${CLIENT_A1}'`,
    );

    await mod.addGoogleAccount(CLIENT_A1, "1234567890");

    /*
     * A client running both platforms buckets its days in ONE timezone, and it
     * has to be the one already in use — re-basing it because a second platform
     * was connected would silently shift every historical daily row relative to
     * the numbers the client already saw.
     */
    expect(await clientRow(CLIENT_A1)).toMatchObject({
      meta_currency: "CAD",
      timezone: "America/Toronto",
    });
  });
});

describe("removeGoogleAccount", () => {
  it("🔴 refuses to remove another client's account", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1234567890");
    const [account] = await mod.listGoogleAccounts(CLIENT_A1);

    await expect(mod.removeGoogleAccount(CLIENT_A2, account.id)).rejects.toThrow(
      /not found/i,
    );
    expect(await mod.activeGoogleAccounts(CLIENT_A1)).toHaveLength(1);
  });

  it("marks removed rather than deleting", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1234567890");
    const [account] = await mod.listGoogleAccounts(CLIENT_A1);

    await mod.removeGoogleAccount(CLIENT_A1, account.id);

    expect(await mod.activeGoogleAccounts(CLIENT_A1)).toHaveLength(0);
    expect(await mod.listGoogleAccounts(CLIENT_A1, { includeRemoved: true })).toHaveLength(1);
  });

  it("🔴 promotes another active account when the primary is removed", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1111111111");
    await mod.addGoogleAccount(CLIENT_A1, "2222222222");

    const primary = (await mod.listGoogleAccounts(CLIENT_A1)).find((a) => a.isPrimary)!;
    await mod.removeGoogleAccount(CLIENT_A1, primary.id);

    /*
     * This branch was dead: the update set `isPrimary: false` and then branched
     * on the RETURNING row's flag, which is the post-update value. A client
     * removing their first Google account was left with no primary at all.
     */
    const remaining = await mod.activeGoogleAccounts(CLIENT_A1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].isPrimary).toBe(true);
  });

  it("promotes the oldest remaining account, deterministically", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1111111111");
    await mod.addGoogleAccount(CLIENT_A1, "2222222222");
    await mod.addGoogleAccount(CLIENT_A1, "3333333333");
    // Make the ordering unambiguous rather than relying on insert timing.
    await run(
      `UPDATE google_ad_accounts SET created_at = now() - interval '2 days' WHERE customer_id = '2222222222'`,
    );
    await run(
      `UPDATE google_ad_accounts SET created_at = now() - interval '1 day' WHERE customer_id = '3333333333'`,
    );

    const primary = (await mod.listGoogleAccounts(CLIENT_A1)).find((a) => a.isPrimary)!;
    await mod.removeGoogleAccount(CLIENT_A1, primary.id);

    // Without an ORDER BY the winner is whatever Postgres returns first, which
    // can differ between this test and production.
    const promoted = (await mod.activeGoogleAccounts(CLIENT_A1)).find((a) => a.isPrimary);
    expect(promoted?.customerId).toBe("2222222222");
  });
});

describe("activeGoogleAccountsForDisplay", () => {
  it("degrades to an error string instead of throwing", async () => {
    await mod.addGoogleAccount(CLIENT_A1, "1234567890");
    // A missing column is what this guards against — it took a whole dashboard
    // down for a client with no Google account at all.
    await run(`ALTER TABLE google_ad_accounts DROP COLUMN login_customer_id`);

    const res = await mod.activeGoogleAccountsForDisplay(CLIENT_A1);

    expect(res.accounts).toEqual([]);
    expect(res.error).toBeTruthy();

    await run(`ALTER TABLE google_ad_accounts ADD COLUMN login_customer_id text`);
  });
});
