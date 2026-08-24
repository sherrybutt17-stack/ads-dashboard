import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  CLIENT_A,
  CLIENT_B,
  type TestDb,
} from "@/lib/metrics/__testdb__/harness";

/**
 * Removing a client, against a real Postgres.
 *
 * ── What removal is actually for ──────────────────────────────────────
 *
 * It is not a delete. `stage_transitions` is the append-only system of record
 * and GHL exposes no history API, so the ledger is kept and everything else is
 * DISCONNECTED — the point being to stop touching the client's systems and to
 * stop holding their credentials.
 *
 * That makes an omission here quiet and consequential in a specific way: a
 * platform the removal forgets keeps a live access token on a client we have
 * been asked to let go of, and keeps a connection that surfaces read as active.
 * Nothing errors. The removal reports success.
 *
 * 🔴 TikTok was exactly that omission — the module was written when Meta and
 * Google were the only platforms and never mentioned TikTok at all.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

const uninstalled: string[] = [];
vi.mock("@/lib/ghl/oauth", () => ({
  markUninstalledForClient: async (id: string) => {
    uninstalled.push(id);
  },
}));

let mod: typeof import("./client-removal");

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

/** A client with all three ad platforms connected, tokens and all. */
async function connectEverything(clientId: string, tag: string) {
  await run(
    `INSERT INTO meta_ad_accounts (client_id, ad_account_id, token_encrypted, is_primary, status)
     VALUES ('${clientId}', 'act_${tag}', 'meta-token-${tag}', true, 'active')`,
  );
  await run(
    `INSERT INTO google_ad_accounts (client_id, customer_id, refresh_token_encrypted, is_primary, status)
     VALUES ('${clientId}', '111-${tag}', 'google-token-${tag}', true, 'active')`,
  );
  await run(
    `INSERT INTO tiktok_ad_accounts (client_id, advertiser_id, access_token_encrypted, status)
     VALUES ('${clientId}', '700${tag}', 'tiktok-token-${tag}', 'active')`,
  );
}

const accounts = async (table: string, clientId: string) =>
  (
    await run(
      `SELECT status, ${table === "tiktok_ad_accounts" ? "access_token_encrypted" : table === "meta_ad_accounts" ? "token_encrypted" : "refresh_token_encrypted"} AS token
         FROM ${table} WHERE client_id = '${clientId}'`,
    )
  ).rows;

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./client-removal");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(
    `TRUNCATE clients, meta_ad_accounts, google_ad_accounts, tiktok_ad_accounts,
              users, user_clients RESTART IDENTITY CASCADE`,
  );
  uninstalled.length = 0;
  for (const [id, slug] of [
    [CLIENT_A, "parfaire"],
    [CLIENT_B, "other"],
  ] as const) {
    await run(
      `INSERT INTO clients (id, name, slug, ghl_location_id, ghl_token_encrypted, status)
       VALUES ('${id}', '${slug}', '${slug}', 'loc-${slug}', 'ghl-token-${slug}', 'active')`,
    );
  }
});

describe("disconnecting the ad platforms", () => {
  it("🔴 removes the TikTok connection, not just Meta and Google", async () => {
    await connectEverything(CLIENT_A, "a");
    const result = await mod.removeClient(CLIENT_A);

    for (const table of [
      "meta_ad_accounts",
      "google_ad_accounts",
      "tiktok_ad_accounts",
    ]) {
      expect(await accounts(table, CLIENT_A)).toEqual([
        expect.objectContaining({ status: "removed" }),
      ]);
    }
    expect(result.tiktokAccountsRemoved).toBe(1);
  });

  it("🔴 drops every stored ad-platform credential", async () => {
    /*
     * The GHL token has always been dropped here, and the module's own summary
     * says removal exists so we "stop touching the client's systems". A live
     * OAuth token left on a removed client is the opposite of that: `status =
     * 'removed'` is a soft flag on a row, and any query that forgets the filter
     * is holding usable credentials for a client we were asked to let go of.
     *
     * Costs nothing to re-add: every add path upserts and supplies a fresh
     * token, so re-connecting overwrites what is cleared here.
     */
    await connectEverything(CLIENT_A, "a");
    await mod.removeClient(CLIENT_A);

    for (const table of [
      "meta_ad_accounts",
      "google_ad_accounts",
      "tiktok_ad_accounts",
    ]) {
      const rows = await accounts(table, CLIENT_A);
      expect(rows[0].token).toBeNull();
    }
    const c = await run(
      `SELECT ghl_token_encrypted, status FROM clients WHERE id = '${CLIENT_A}'`,
    );
    expect(c.rows[0]).toMatchObject({ ghl_token_encrypted: null, status: "archived" });
  });

  it("🔴 never touches another client's connections", async () => {
    await connectEverything(CLIENT_A, "a");
    await connectEverything(CLIENT_B, "b");
    await mod.removeClient(CLIENT_A);

    for (const table of [
      "meta_ad_accounts",
      "google_ad_accounts",
      "tiktok_ad_accounts",
    ]) {
      const rows = await accounts(table, CLIENT_B);
      expect(rows[0].status).toBe("active");
      expect(rows[0].token).not.toBeNull();
    }
    expect(uninstalled).toEqual([CLIENT_A]);
  });

  it("counts only what it actually disconnected", async () => {
    // An account already removed must not be counted again, or a second removal
    // reports work it did not do.
    await connectEverything(CLIENT_A, "a");
    await mod.removeClient(CLIENT_A);
    const second = await mod.removeClient(CLIENT_A);
    expect(second).toMatchObject({
      metaAccountsRemoved: 0,
      googleAccountsRemoved: 0,
      tiktokAccountsRemoved: 0,
    });
  });

  it("is safe on a client that never connected anything", async () => {
    const result = await mod.removeClient(CLIENT_A);
    expect(result.metaAccountsRemoved).toBe(0);
    expect(result.tiktokAccountsRemoved).toBe(0);
  });
});

describe("the ledger", () => {
  it("🔴 archives rather than deletes", async () => {
    /*
     * The single most important property of this function. GHL has no
     * stage-history API, so a delete would destroy funnel history that cannot
     * be recovered from anywhere — not from GHL, not from a backup of GHL.
     */
    await mod.removeClient(CLIENT_A);
    const rows = await run(`SELECT status FROM clients WHERE id = '${CLIENT_A}'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe("archived");
  });
});

describe("logins", () => {
  async function login(email: string, role: string, clientIds: string[]) {
    const id = (
      await run(
        `INSERT INTO users (email, password_hash, role) VALUES ('${email}', 'x', '${role}') RETURNING id`,
      )
    ).rows[0].id;
    for (const c of clientIds) {
      await run(
        `INSERT INTO user_clients (user_id, client_id) VALUES ('${id}', '${c}')`,
      );
    }
    return id as string;
  }

  it("🔴 disables a client login left with no dashboards", async () => {
    const only = await login("only@x.test", "client", [CLIENT_A]);
    const result = await mod.removeClient(CLIENT_A);

    const u = await run(`SELECT status FROM users WHERE id = '${only}'`);
    expect(u.rows[0].status).toBe("disabled");
    expect(result.clientLoginsDisabled).toBe(1);
  });

  it("leaves a client login that still has another dashboard", async () => {
    const both = await login("both@x.test", "client", [CLIENT_A, CLIENT_B]);
    await mod.removeClient(CLIENT_A);

    const u = await run(`SELECT status FROM users WHERE id = '${both}'`);
    expect(u.rows[0].status).toBe("active");
    const grants = await run(
      `SELECT client_id::text AS c FROM user_clients WHERE user_id = '${both}'`,
    );
    expect(grants.rows.map((r) => r.c)).toEqual([CLIENT_B]);
  });

  it("🔴 never disables a staff login", async () => {
    /*
     * Staff see every client, so their access is not expressed as grants at
     * all. Disabling one because a client they happened to be granted was
     * removed would lock the agency out of its own dashboard.
     */
    const staff = await login("staff@x.test", "staff", [CLIENT_A]);
    const result = await mod.removeClient(CLIENT_A);

    const u = await run(`SELECT status FROM users WHERE id = '${staff}'`);
    expect(u.rows[0].status).toBe("active");
    expect(result.clientLoginsDisabled).toBe(0);
  });
});
