import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * Attaching a Facebook ad account to a client.
 *
 * ── Why this module is worth a database test ──────────────────────────
 *
 * It is the ad-platform twin of `ghl/oauth.ts`: the place where an external
 * account becomes *someone's*. Both had the same shape of leak and both were
 * fixed the same way, so the same things need proving here.
 *
 * Three rules carry real weight, and none of them is visible to a typechecker:
 *
 *  1. **The clash check is scoped to the caller's own agency.** Unscoped, it
 *     was a disclosure oracle — type an ad account id and the error named a
 *     stranger's client.
 *  2. **The shared system-user token serves the bootstrap agency only.** Any
 *     other agency attaching an account without its own credential must be
 *     refused BEFORE a request goes out, or the connect wizard becomes "report
 *     on a stranger's spend by guessing their account id".
 *  3. **The ON CONFLICT target must match the unique index**, which is now
 *     `(client_id, ad_account_id)`. This one compiles perfectly either way and
 *     fails only against a real Postgres — which is precisely why the harness
 *     carries the constraint.
 *
 * The Meta API itself is stubbed. What is being tested is who is allowed to
 * ask, and what gets written down when they are.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

/**
 * The stub records the token it was constructed with, so a test can assert not
 * just "this was refused" but "no request was made with our shared credential".
 */
const metaCalls: { token: string; accountId: string }[] = [];
let metaResponse: Record<string, unknown> = {};
let metaError: Error | null = null;

vi.mock("./client", () => ({
  MetaClient: class {
    constructor(private readonly token: string) {}
    async getAdAccount(accountId: string) {
      metaCalls.push({ token: this.token, accountId });
      if (metaError) throw metaError;
      return { id: `act_${accountId}`, name: "Acme Aesthetics", ...metaResponse };
    }
    static normalizeAccountId(id: string) {
      return `act_${id}`;
    }
  },
}));

let mod: typeof import("./accounts");

/** The one agency allowed to ride the shared system-user token. */
const BOOTSTRAP = "00000000-0000-0000-0000-000000000001";
const OTHER_AGENCY = "bbbbbbbb-0000-4000-8000-00000000000b";

const CLIENT_A1 = "11111111-1111-1111-1111-111111111111";
const CLIENT_A2 = "22222222-2222-2222-2222-222222222222";
const CLIENT_B1 = "33333333-3333-3333-3333-333333333333";

const env = {
  key: process.env.ENCRYPTION_KEY,
  token: process.env.META_SYSTEM_USER_TOKEN,
};

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const accountsFor = async (clientId: string) =>
  (
    await run(
      `SELECT ad_account_id, account_name, currency, timezone, is_primary,
              status, token_encrypted, token_expires_at
         FROM meta_ad_accounts WHERE client_id = '${clientId}'
        ORDER BY ad_account_id`,
    )
  ).rows;

const clientRow = async (id: string) =>
  (
    await run(
      `SELECT meta_currency, meta_timezone, timezone FROM clients WHERE id = '${id}'`,
    )
  ).rows[0];

beforeAll(async () => {
  harness = await createTestDb();
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.META_SYSTEM_USER_TOKEN = "shared-system-user-token";
  mod = await import("./accounts");
});

afterAll(async () => {
  await harness.close();
  if (env.key === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = env.key;
  if (env.token === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
  else process.env.META_SYSTEM_USER_TOKEN = env.token;
});

beforeEach(async () => {
  metaCalls.length = 0;
  metaResponse = { currency: "USD", timezone_name: "America/Los_Angeles" };
  metaError = null;
  await run(`TRUNCATE meta_ad_accounts, clients RESTART IDENTITY CASCADE`);
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

/* ------------------------------------------------------------------ *
 * Who may attach, and on whose credential
 * ------------------------------------------------------------------ */

describe("addAdAccount — tenancy", () => {
  it("attaches an account and echoes back what Meta actually said", async () => {
    const res = await mod.addAdAccount(CLIENT_A1, "act_123456");

    // The `act_` prefix is stripped on write — every downstream query joins on
    // the bare id, so storing it twice would silently split a client's spend.
    expect((await accountsFor(CLIENT_A1))[0]).toMatchObject({
      ad_account_id: "123456",
      account_name: "Acme Aesthetics",
      currency: "USD",
      is_primary: true,
      status: "active",
    });
    expect(res.currencyMismatch).toBeUndefined();
  });

  it("🔴 refuses an agency that has no credential of its own, before calling Meta", async () => {
    await expect(mod.addAdAccount(CLIENT_B1, "123456")).rejects.toThrow(
      /no Facebook connection of its own/i,
    );

    /*
     * The assertion that matters is this one. A refusal that still made the
     * request would mean our system-user token had already been pointed at an
     * account id supplied by another tenant — the response would just be
     * discarded. The check has to happen before the network, not after.
     */
    expect(metaCalls).toHaveLength(0);
    expect(await accountsFor(CLIENT_B1)).toHaveLength(0);
  });

  it("lets any agency attach an account using its own token", async () => {
    await mod.addAdAccount(CLIENT_B1, "123456", "their-own-token");

    expect(metaCalls[0].token).toBe("their-own-token");
    expect(await accountsFor(CLIENT_B1)).toHaveLength(1);
  });

  it("uses the shared token only for the bootstrap agency", async () => {
    await mod.addAdAccount(CLIENT_A1, "123456");
    expect(metaCalls[0].token).toBe("shared-system-user-token");
  });

  it("refuses a client id that does not exist rather than defaulting a tenant", async () => {
    await expect(
      mod.addAdAccount("00000000-0000-4000-8000-000000000000", "123456"),
    ).rejects.toThrow(/unknown client/i);
    expect(metaCalls).toHaveLength(0);
  });

  it("requires a non-empty account id once the act_ prefix is stripped", async () => {
    await expect(mod.addAdAccount(CLIENT_A1, "act_")).rejects.toThrow(/required/i);
  });
});

/* ------------------------------------------------------------------ *
 * The clash check — a warning within a tenant, silence across one
 * ------------------------------------------------------------------ */

describe("addAdAccount — clash detection", () => {
  it("names the conflicting client when it is one of the agency's own", async () => {
    await mod.addAdAccount(CLIENT_A1, "123456");

    // Same account on two clients of one agency double-counts its spend in the
    // roll-up, so a named message beats a raw constraint violation.
    await expect(mod.addAdAccount(CLIENT_A2, "123456")).rejects.toThrow(
      /already attached to acme\b/i,
    );
  });

  it("🔴 says nothing when the same account id sits in another agency", async () => {
    await mod.addAdAccount(CLIENT_A1, "123456");

    // Different tenant, same account id: allowed, and the other tenant is not
    // mentioned, because the error message WAS the disclosure. Unscoped, this
    // told a stranger which client of ours holds a given ad account.
    const res = await mod.addAdAccount(CLIENT_B1, "123456", "their-own-token");

    expect(res.account.adAccountId).toBe("123456");
    expect(await accountsFor(CLIENT_B1)).toHaveLength(1);
    // And the first agency's row is untouched.
    expect(await accountsFor(CLIENT_A1)).toHaveLength(1);
  });

  it("🔴 re-adding the same account to the same client updates instead of throwing", async () => {
    await mod.addAdAccount(CLIENT_A1, "123456", "first-token");

    metaResponse = { currency: "USD", timezone_name: "America/New_York" };
    await mod.addAdAccount(CLIENT_A1, "123456", "second-token");

    /*
     * The ON CONFLICT target has to name (client_id, ad_account_id) — the same
     * columns as the unique index. Naming the old single column compiles and
     * then fails at runtime on every re-add, which is a re-connect flow nobody
     * exercises until a client's token expires.
     */
    const rows = await accountsFor(CLIENT_A1);
    expect(rows).toHaveLength(1);
    expect(rows[0].timezone).toBe("America/New_York");
  });

  it("does not treat a removed account as a free slot in another agency", async () => {
    await mod.addAdAccount(CLIENT_A1, "123456");
    const [row] = (await run(
      `SELECT id::text AS id FROM meta_ad_accounts WHERE client_id = '${CLIENT_A1}'`,
    )).rows;
    await mod.removeAdAccount(CLIENT_A1, row.id as string);

    // A removed row is kept so its metrics stay attributable, and the clash
    // check does not exclude it — re-attaching it to a SIBLING client would
    // still double-count the history already pulled under it.
    await expect(mod.addAdAccount(CLIENT_A2, "123456")).rejects.toThrow(
      /already attached/i,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Primary account — currency, timezone, and the mismatch warnings
 * ------------------------------------------------------------------ */

describe("addAdAccount — primary and mismatches", () => {
  it("the first account becomes primary and sets the client's bucketing timezone", async () => {
    await mod.addAdAccount(CLIENT_A1, "123456");

    /*
     * Meta buckets its day in the ad account's timezone and offers no
     * alternative, so the account is the authority and the client adopts it.
     * Getting this wrong shifts every daily row by up to a day.
     */
    expect(await clientRow(CLIENT_A1)).toMatchObject({
      meta_currency: "USD",
      meta_timezone: "America/Los_Angeles",
      timezone: "America/Los_Angeles",
    });
  });

  it("warns on a currency mismatch but still attaches", async () => {
    await mod.addAdAccount(CLIENT_A1, "111");
    metaResponse = { currency: "CAD", timezone_name: "America/Los_Angeles" };

    const res = await mod.addAdAccount(CLIENT_A1, "222");

    // Mixed currencies cannot be summed, so the UI has to be able to say so —
    // but refusing the attach would leave the operator unable to record an
    // account that genuinely exists.
    expect(res.currencyMismatch).toEqual({ primary: "USD", thisAccount: "CAD" });
    expect(await accountsFor(CLIENT_A1)).toHaveLength(2);
    // The second account does not steal primary, so the display currency holds.
    expect(await clientRow(CLIENT_A1)).toMatchObject({ meta_currency: "USD" });
  });

  it("warns on a timezone mismatch, which makes 'a day' ambiguous", async () => {
    await mod.addAdAccount(CLIENT_A1, "111");
    metaResponse = { currency: "USD", timezone_name: "America/New_York" };

    const res = await mod.addAdAccount(CLIENT_A1, "222");

    expect(res.timezoneMismatch).toEqual({
      primary: "America/Los_Angeles",
      thisAccount: "America/New_York",
    });
  });
});

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

describe("addAdAccount — token storage", () => {
  it("stores an override encrypted, never in the clear", async () => {
    await mod.addAdAccount(CLIENT_A1, "123456", "sekrit-token");

    const [row] = await accountsFor(CLIENT_A1);
    expect(row.token_encrypted).not.toContain("sekrit-token");
    const { decrypt } = await import("@/lib/crypto");
    expect(decrypt(row.token_encrypted as string)).toBe("sekrit-token");
  });

  it("🔴 clears the expiry when the token is cleared", async () => {
    const expires = new Date("2026-10-01T00:00:00Z");
    await mod.addAdAccount(CLIENT_A1, "123456", "short-lived", expires);
    expect((await accountsFor(CLIENT_A1))[0].token_expires_at).not.toBeNull();

    // Re-added without a token: it now rides the shared credential, and a
    // leftover expiry would have the health checklist warn about the expiry of
    // a token that is no longer there.
    await mod.addAdAccount(CLIENT_A1, "123456");

    const [row] = await accountsFor(CLIENT_A1);
    expect(row.token_encrypted).toBeNull();
    expect(row.token_expires_at).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Listing and removal
 * ------------------------------------------------------------------ */

describe("listAdAccounts / activeAdAccounts", () => {
  it("hides removed accounts unless asked for them", async () => {
    await mod.addAdAccount(CLIENT_A1, "111");
    await mod.addAdAccount(CLIENT_A1, "222");
    const rows = await mod.listAdAccounts(CLIENT_A1);
    await mod.removeAdAccount(CLIENT_A1, rows[1].id);

    expect(await mod.listAdAccounts(CLIENT_A1)).toHaveLength(1);
    expect(await mod.listAdAccounts(CLIENT_A1, { includeRemoved: true })).toHaveLength(2);
    expect(await mod.activeAdAccounts(CLIENT_A1)).toHaveLength(1);
  });

  it("never returns another client's accounts", async () => {
    await mod.addAdAccount(CLIENT_A1, "111");
    await mod.addAdAccount(CLIENT_A2, "222");

    expect((await mod.listAdAccounts(CLIENT_A1)).map((a) => a.adAccountId)).toEqual(["111"]);
  });
});

describe("removeAdAccount", () => {
  it("🔴 refuses to remove an account belonging to another client", async () => {
    await mod.addAdAccount(CLIENT_A1, "111");
    const [account] = await mod.listAdAccounts(CLIENT_A1);

    // Same agency, wrong client — the id alone is not the permission. Without
    // the client_id in the WHERE, any operator could detach any account by id.
    await expect(mod.removeAdAccount(CLIENT_A2, account.id)).rejects.toThrow(
      /not found/i,
    );
    expect(await mod.activeAdAccounts(CLIENT_A1)).toHaveLength(1);
  });

  it("marks removed rather than deleting, so history keeps its owner", async () => {
    await mod.addAdAccount(CLIENT_A1, "111");
    const [account] = await mod.listAdAccounts(CLIENT_A1);

    await mod.removeAdAccount(CLIENT_A1, account.id);

    // `fb_daily_metrics` rows already pulled under this account stay joinable;
    // a hard delete would drop historical totals with no trace.
    const rows = await accountsFor(CLIENT_A1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("removed");
    expect(rows[0].is_primary).toBe(false);
  });

  it("promotes another active account when the primary is removed", async () => {
    await mod.addAdAccount(CLIENT_A1, "111");
    metaResponse = { currency: "CAD", timezone_name: "America/Toronto" };
    await mod.addAdAccount(CLIENT_A1, "222");

    const accounts = await mod.listAdAccounts(CLIENT_A1);
    const primary = accounts.find((a) => a.isPrimary)!;
    await mod.removeAdAccount(CLIENT_A1, primary.id);

    // Without promotion the client keeps a display currency and timezone
    // inherited from an account it no longer has.
    const remaining = await mod.activeAdAccounts(CLIENT_A1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].isPrimary).toBe(true);
    expect(await clientRow(CLIENT_A1)).toMatchObject({
      meta_currency: "CAD",
      timezone: "America/Toronto",
    });
  });

  it("leaves the client's display currency alone when nothing remains to promote", async () => {
    await mod.addAdAccount(CLIENT_A1, "111");
    const [account] = await mod.listAdAccounts(CLIENT_A1);

    await mod.removeAdAccount(CLIENT_A1, account.id);

    // Blanking it would make the dashboard render bare numbers with no unit,
    // which reads as "free" rather than "disconnected".
    expect(await clientRow(CLIENT_A1)).toMatchObject({ meta_currency: "USD" });
  });
});
