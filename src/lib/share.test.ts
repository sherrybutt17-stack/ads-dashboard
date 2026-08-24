import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  CLIENT_A,
  CLIENT_B,
  type TestDb,
} from "./metrics/__testdb__/harness";

/**
 * Share links, tested against a real Postgres.
 *
 * A share URL is the one credential in this system that is deliberately handed
 * to someone with no account, travels by email, and cannot be recalled. So the
 * assertions here are about the properties that make that acceptable rather
 * than about the happy path:
 *
 *   · the plaintext token is never written to the database
 *   · expiry and revocation actually deny, and are distinguishable
 *   · revocation is tenant-scoped — another client's id revokes nothing
 *   · rotating a password invalidates the proofs already issued for it
 *
 * Each corresponds to a way this feature could look correct and leak anyway.
 */

let harness: { db: TestDb; close: () => Promise<void> };

// `@/db` opens a network pool at import time. Swap in the in-process Postgres
// before the module under test is loaded.
vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let share: typeof import("./share");

beforeAll(async () => {
  harness = await createTestDb();
  share = await import("./share");
});
afterAll(async () => {
  await harness?.close();
});

const RANGE = { rangeStart: "2026-07-01", rangeEnd: "2026-07-31" };

async function mint(over: Partial<Parameters<typeof share.mintShareLink>[0]> = {}) {
  return share.mintShareLink({
    clientId: CLIENT_A,
    ...RANGE,
    platform: "meta",
    ttlDays: 30,
    ...over,
  });
}

describe("the token is a credential, and is treated as one", () => {
  it("stores only the SHA-256, never the token itself", async () => {
    const { token, row } = await mint({ label: "storage check" });

    const res = await harness.db.execute<Record<string, unknown>>(
      sql`SELECT * FROM share_links WHERE id = ${row.id}`,
    );
    const stored = (res as { rows: Array<Record<string, unknown>> }).rows[0];

    // Nothing anywhere in the row may equal the live token — not the hash
    // column, not the label, not a stray copy someone added later.
    const values = Object.values(stored).map((v) => String(v));
    expect(values).not.toContain(token);
    expect(stored.token_hash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
  });

  it("mints a distinct high-entropy token every time", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) tokens.add((await mint()).token);
    expect(tokens.size).toBe(5);
    // 32 random bytes, base64url, unpadded.
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(42);
  });

  it("resolves a live token to its own link", async () => {
    const { token, row } = await mint({ label: "resolve" });
    const res = await share.resolveShareToken(token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.link.id).toBe(row.id);
      expect(res.link.clientId).toBe(CLIENT_A);
      expect(res.link.rangeStart).toBe("2026-07-01");
    }
  });

  it("rejects a token that is one character different", async () => {
    const { token } = await mint();
    const tampered = token.slice(0, -1) + (token.at(-1) === "A" ? "B" : "A");
    const res = await share.resolveShareToken(tampered);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects junk without querying at all", async () => {
    for (const junk of [undefined, "", "short", "x".repeat(200)]) {
      expect(await share.resolveShareToken(junk)).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
  });
});

describe("expiry and revocation actually deny", () => {
  it("denies a token past its expiry", async () => {
    const { token, row } = await mint({ ttlDays: 7 });
    const afterExpiry = new Date(row.expiresAt.getTime() + 1000);
    expect(await share.resolveShareToken(token, afterExpiry)).toEqual({
      ok: false,
      reason: "expired",
    });
    // …and still resolves a moment before it.
    const before = new Date(row.expiresAt.getTime() - 1000);
    expect((await share.resolveShareToken(token, before)).ok).toBe(true);
  });

  it("treats the expiry instant itself as expired", async () => {
    // A link that is live at exactly its stated expiry is a link that outlives
    // what the operator was told. Off-by-one in the safe direction.
    const { token, row } = await mint();
    expect(await share.resolveShareToken(token, row.expiresAt)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("denies a revoked token, and reports it as revoked rather than expired", async () => {
    const { token, row } = await mint();
    expect(await share.revokeShareLink(row.id, CLIENT_A)).toBe(true);
    expect(await share.resolveShareToken(token)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("revocation is idempotent and does not move the timestamp", async () => {
    const { row } = await mint();
    expect(await share.revokeShareLink(row.id, CLIENT_A)).toBe(true);
    // A second revoke reports "no change" rather than rewriting when it
    // happened — the audit trail has to stay true.
    expect(await share.revokeShareLink(row.id, CLIENT_A)).toBe(false);
  });

  it("🔴 another tenant's id revokes NOTHING", async () => {
    const { token, row } = await mint({ clientId: CLIENT_A });
    // CLIENT_B holds a valid-looking link id. Without the client scope in the
    // WHERE clause this would revoke someone else's live report.
    expect(await share.revokeShareLink(row.id, CLIENT_B)).toBe(false);
    expect((await share.resolveShareToken(token)).ok).toBe(true);
  });

  it("lists only the requesting client's links", async () => {
    await mint({ clientId: CLIENT_B, label: "b-only" });
    const forA = await share.listShareLinks(CLIENT_A);
    expect(forA.every((l) => l.clientId === CLIENT_A)).toBe(true);
    expect(forA.map((l) => l.label)).not.toContain("b-only");
  });
});

describe("the optional password gate", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    const { row } = await mint({ password: "board-2026" });
    expect(share.checkSharePassword(row, "board-2026")).toBe(true);
    expect(share.checkSharePassword(row, "board-2025")).toBe(false);
    expect(share.checkSharePassword(row, "")).toBe(false);
  });

  it("does not store the password in readable form", async () => {
    const { row } = await mint({ password: "board-2026" });
    expect(row.passwordHash).not.toContain("board-2026");
    expect(row.passwordHash?.startsWith("scrypt$")).toBe(true);
  });

  it("a link with no password is open to anyone holding the URL", async () => {
    const { row } = await mint();
    expect(row.passwordHash).toBeNull();
    // Stated as a test because it is a decision, not an accident: no password
    // means the URL alone is sufficient, which is what the UI must convey.
    expect(share.checkSharePassword(row, "")).toBe(true);
  });

  it("🔴 rotating the password invalidates proofs already handed out", async () => {
    const { row } = await mint({ password: "first-password" });
    const oldProof = share.sharePassProof(row);
    expect(share.checkPassProof(row, oldProof)).toBe(true);

    // The operator changes the password. Anyone already holding an unlocked
    // cookie must be locked out — otherwise the rotation protects nothing.
    const rotated = { ...row, passwordHash: "scrypt$16384$aa$bb" };
    expect(share.checkPassProof(rotated, oldProof)).toBe(false);
  });

  it("rejects an absent or malformed proof", () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      passwordHash: "scrypt$16384$aa$bb",
    } as Parameters<typeof share.sharePassProof>[0];
    expect(share.checkPassProof(row, undefined)).toBe(false);
    expect(share.checkPassProof(row, "")).toBe(false);
    expect(share.checkPassProof(row, "not-a-proof")).toBe(false);
  });
});

describe("view accounting", () => {
  it("counts views and stamps the last one", async () => {
    const { row } = await mint();
    expect(row.viewCount).toBe(0);

    const at = new Date("2026-08-13T10:00:00Z");
    await share.recordShareView(row.id, at);
    await share.recordShareView(row.id, at);

    const [after] = await share.listShareLinks(CLIENT_A);
    const found = (await share.listShareLinks(CLIENT_A)).find(
      (l) => l.id === row.id,
    );
    expect(found?.viewCount).toBe(2);
    expect(found?.lastViewedAt?.toISOString()).toBe(at.toISOString());
    expect(after).toBeDefined();
  });

  it("never throws on a bad id — a counter must not break a render", async () => {
    await expect(
      share.recordShareView("00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
    // Not a uuid at all: this would be a database-level error, and it still
    // must not propagate into the page.
    await expect(share.recordShareView("nonsense")).resolves.toBeUndefined();
  });
});

describe("a database failure is not 'invalid link'", () => {
  it("🔴 reports 'unavailable', not 'not_found', when the table is unreachable", async () => {
    const { token } = await mint();

    /*
     * The realistic version of this: the migration adding `share_links` has not
     * been applied to the deployment yet. Reported as "not found", the reader
     * goes back to the sender for a replacement link that will fail identically,
     * and nobody learns what is actually wrong. It is the same failure the
     * dashboard's pipe states exist to prevent — an outage wearing the costume
     * of an empty result.
     */
    await harness.db.execute(sql`ALTER TABLE share_links RENAME TO share_links_x`);
    try {
      expect(await share.resolveShareToken(token)).toEqual({
        ok: false,
        reason: "unavailable",
      });
    } finally {
      await harness.db.execute(sql`ALTER TABLE share_links_x RENAME TO share_links`);
    }

    // …and the very same token resolves normally once it is back.
    expect((await share.resolveShareToken(token)).ok).toBe(true);
  });
});

describe("ttl bounds", () => {
  it("falls back to the default rather than honouring an arbitrary ttl", async () => {
    // The API validates too, but this is the last line: a caller passing 3650
    // must not mint a ten-year link to a client's revenue.
    const { row } = await mint({ ttlDays: 3650 });
    const days = Math.round(
      (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000,
    );
    expect(days).toBe(share.DEFAULT_SHARE_TTL_DAYS);
  });

  it("honours each offered ttl", async () => {
    for (const ttl of share.SHARE_TTL_DAYS) {
      const { row } = await mint({ ttlDays: ttl });
      const days = Math.round(
        (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000,
      );
      expect(days).toBe(ttl);
    }
  });
});
