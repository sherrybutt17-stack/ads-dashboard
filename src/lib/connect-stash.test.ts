import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * The half-finished connect flow, against a real Postgres.
 *
 * This holds a **live ad-account credential** between consent and the account
 * picker, so its rules are security rules rather than conveniences: scoped to
 * one client, scoped to one provider, encrypted at rest, and gone within
 * fifteen minutes whether or not anyone comes back to finish.
 *
 * It replaces a per-provider `Map` in module scope. That version could not work
 * on Vercel — the OAuth callback and the picker are different route handlers,
 * so different serverless functions — and the failure surfaced as "that sign-in
 * has expired", indistinguishable from a genuine timeout. The last test in this
 * file is the one that would have caught it.
 */

let harness: { db: TestDb; close: () => Promise<void> };
vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

process.env.ENCRYPTION_KEY = "d".repeat(64);
const mod = await import("./connect-stash");

beforeAll(async () => {
  harness = await createTestDb();
  for (const [id, slug] of [
    [CLIENT_A, "acme"],
    [CLIENT_B, "other"],
  ] as const) {
    await harness.db.execute(
      sql.raw(`INSERT INTO clients (id, name, slug) VALUES ('${id}', '${slug}', '${slug}')`),
    );
  }
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.execute(sql.raw("DELETE FROM connect_stash"));
});

async function rows<T>(q: string): Promise<T[]> {
  const res = (await harness.db.execute(sql.raw(q))) as unknown as { rows: T[] };
  return res.rows;
}

describe("the connect stash", () => {
  it("round-trips a credential for the client it was minted for", async () => {
    const id = await mod.putConnectStash("google", CLIENT_A, "refresh-abc");
    expect(await mod.readConnectStash("google", id, CLIENT_A)).toEqual({
      ok: true,
      clientId: CLIENT_A,
      token: "refresh-abc",
      tokenExpiresAt: null,
      payload: null,
    });
  });

  it("carries a credential expiry through, for the providers that have one", async () => {
    const exp = new Date("2026-10-16T00:00:00.000Z");
    const id = await mod.putConnectStash("meta", CLIENT_A, "TOKEN", {
      tokenExpiresAt: exp,
    });
    const found = await mod.readConnectStash("meta", id, CLIENT_A);
    expect(found.ok && found.tokenExpiresAt?.toISOString()).toBe(exp.toISOString());
  });

  it("🔴 refuses a stash minted for a different client", async () => {
    /*
     * The stash id travels through a URL. Without this check an operator who
     * can reach two clients could take a stash minted while connecting one and
     * attach that client's ad accounts — with their live credential — to the
     * other, which is a cross-tenant leak performed entirely through the UI.
     */
    const id = await mod.putConnectStash("google", CLIENT_A, "refresh-abc");
    expect(await mod.readConnectStash("google", id, CLIENT_B)).toEqual({
      ok: false,
      reason: "wrong_client",
    });
    // And the rightful client is unaffected — the guard is on identity, not use.
    expect(await mod.readConnectStash("google", id, CLIENT_A)).toMatchObject({ ok: true });
  });

  it("🔴 refuses a stash redeemed down the other provider's path", async () => {
    /*
     * One table, two providers. A Google refresh token handed to code expecting
     * a Meta access token fails somewhere far from the cause — at a Graph API
     * call, as an auth error that reads like a revoked permission.
     */
    const id = await mod.putConnectStash("google", CLIENT_A, "refresh-abc");
    expect(await mod.readConnectStash("meta", id, CLIENT_A)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("🔴 stores the credential encrypted, never as plaintext in a column", async () => {
    const id = await mod.putConnectStash("meta", CLIENT_A, "SECRET-TOKEN");
    const [row] = await rows<{ token_encrypted: string }>(
      `SELECT token_encrypted FROM connect_stash WHERE id = '${id}'`,
    );
    expect(row.token_encrypted).not.toContain("SECRET-TOKEN");
    // …and is still the real credential on the way back out.
    expect(await mod.readConnectStash("meta", id, CLIENT_A)).toMatchObject({
      token: "SECRET-TOKEN",
    });
  });

  it("carries a provider-specific payload through untouched", async () => {
    /*
     * TikTok's exchange hands back the advertiser ids the grant covers. They
     * are a cross-check rather than the answer — discovery re-queries and wins —
     * but losing them means the picker cannot tell that a grant was narrowed
     * between consent and the pick.
     */
    const id = await mod.putConnectStash("tiktok", CLIENT_A, "grant", {
      payload: { advertiserIds: ["700", "701"] },
    });
    const found = await mod.readConnectStash("tiktok", id, CLIENT_A);
    expect(found.ok && found.payload).toEqual({ advertiserIds: ["700", "701"] });
  });

  it("reads a missing payload as null rather than undefined", async () => {
    const id = await mod.putConnectStash("google", CLIENT_A, "refresh-abc");
    const found = await mod.readConnectStash("google", id, CLIENT_A);
    expect(found.ok && found.payload).toBeNull();
  });

  it("reports an unknown id as expired rather than throwing", async () => {
    expect(await mod.readConnectStash("google", "no-such-stash", CLIENT_A)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("drops a stash once its accounts have been attached", async () => {
    const id = await mod.putConnectStash("google", CLIENT_A, "refresh-abc");
    await mod.dropConnectStash("google", id);
    expect((await mod.readConnectStash("google", id, CLIENT_A)).ok).toBe(false);
    expect(await rows("SELECT id FROM connect_stash")).toHaveLength(0);
  });

  it("🔴 deletes an expired credential rather than merely refusing to serve it", async () => {
    /*
     * The whole justification for holding a live credential is that it cannot
     * outlive the decision it waits on. A row that is reported as expired while
     * still sitting in the table is a credential nobody is watching, for as
     * long as nobody reads the table.
     */
    const id = await mod.putConnectStash("google", CLIENT_A, "refresh-abc");
    await harness.db.execute(
      sql.raw(
        `UPDATE connect_stash SET expires_at = now() - interval '1 minute' WHERE id = '${id}'`,
      ),
    );

    expect(await mod.readConnectStash("google", id, CLIENT_A)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await rows("SELECT id FROM connect_stash")).toHaveLength(0);
  });

  it("prunes on write too, so an abandoned flow cannot wait for a reader", async () => {
    const stale = await mod.putConnectStash("meta", CLIENT_A, "OLD");
    await harness.db.execute(
      sql.raw(
        `UPDATE connect_stash SET expires_at = now() - interval '1 hour' WHERE id = '${stale}'`,
      ),
    );

    await mod.putConnectStash("meta", CLIENT_A, "NEW");
    const left = await rows<{ id: string }>("SELECT id FROM connect_stash");
    expect(left.map((r) => r.id)).not.toContain(stale);
  });

  it("goes with the client it belongs to", async () => {
    // ON DELETE CASCADE. A deleted client must not leave a live credential for
    // an ad account behind it.
    await mod.putConnectStash("google", CLIENT_B, "refresh-abc");
    await harness.db.execute(sql.raw(`DELETE FROM clients WHERE id = '${CLIENT_B}'`));
    expect(await rows("SELECT id FROM connect_stash")).toHaveLength(0);
    await harness.db.execute(
      sql.raw(`INSERT INTO clients (id, name, slug) VALUES ('${CLIENT_B}', 'other', 'other')`),
    );
  });

  it("🔴 is readable from a different module instance — the bug this table exists for", async () => {
    /*
     * The stash used to be a `Map` in module scope. On Vercel the OAuth callback
     * and the account picker are different route handlers, so they run in
     * different serverless functions: the Map that was written was never the Map
     * that got read, and both connect flows reported "that sign-in has expired"
     * on every attempt, at any speed.
     *
     * Resetting the module registry and re-importing is the closest this test
     * can get to a second instance. Against the old implementation it fails;
     * against a table it cannot.
     */
    const id = await mod.putConnectStash("google", CLIENT_A, "refresh-across");

    vi.resetModules();
    const secondInstance = await import("./connect-stash");

    expect(await secondInstance.readConnectStash("google", id, CLIENT_A)).toEqual({
      ok: true,
      clientId: CLIENT_A,
      token: "refresh-across",
      tokenExpiresAt: null,
      payload: null,
    });
  });
});
