import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { clientBranding } from "./schema";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * `bytea`, which drizzle-orm 0.45 does not ship, has to survive BOTH drivers
 * this app supports — and they disagree about what they hand back.
 *
 * `node-postgres` decodes to a Node `Buffer`. The Neon serverless driver returns
 * the raw wire format: a `\x`-prefixed hex string. A custom type written against
 * only one of them fails silently rather than loudly — the value still arrives,
 * it is simply the literal text "\x89504e470d0a1a0a…", which then gets written
 * into an `<img>` and every logo renders broken with no error anywhere.
 *
 * These tests pin both shapes.
 */

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("bytea fromDriver — the two driver shapes", () => {
  /*
   * Reach the decoder the app actually uses — the built column on the real
   * table, not a fresh `bytea()` builder. `mapFromDriverValue` only exists once
   * the column is built, so testing the builder would have silently tested
   * nothing.
   */
  const decode = (v: unknown): Buffer =>
    (clientBranding.logoWordmark as unknown as {
      mapFromDriverValue: (x: unknown) => Buffer;
    }).mapFromDriverValue(v);

  it("passes a node-postgres Buffer through untouched", () => {
    const out = decode(PNG_HEADER);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(PNG_HEADER)).toBe(true);
  });

  it("decodes the Neon driver's \\x hex string back to the same bytes", () => {
    const wire = "\\x" + PNG_HEADER.toString("hex");
    const out = decode(wire);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(PNG_HEADER)).toBe(true);
  });

  it("produces IDENTICAL bytes from both shapes", () => {
    // The failure this prevents: an app that works on one driver and serves
    // corrupt images on the other, with nothing in the logs either way.
    const fromBuffer = decode(PNG_HEADER);
    const fromWire = decode("\\x" + PNG_HEADER.toString("hex"));
    expect(fromBuffer.equals(fromWire)).toBe(true);
  });
});

describe("bytea round trip through a real Postgres", () => {
  let harness: { db: TestDb; close: () => Promise<void> };

  beforeAll(async () => {
    harness = await createTestDb();
  });
  afterAll(async () => {
    await harness?.close();
  });

  it("stores and returns a binary payload byte-for-byte", async () => {
    // Deliberately includes 0x00 and high bytes — the values that break a
    // implementation treating this as text.
    const payload = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe, 0x7f, 0x80, 0x0d, 0x0a,
    ]);
    const id = "55555555-5555-5555-5555-555555555555";

    await harness.db.execute(
      sql`INSERT INTO client_branding (client_id, logo_wordmark, logo_wordmark_type)
          VALUES (${id}, ${payload}, 'image/png')`,
    );

    const res = await harness.db.execute<{ logo_wordmark: unknown }>(
      sql`SELECT logo_wordmark FROM client_branding WHERE client_id = ${id}`,
    );
    const raw = (res as { rows: Array<{ logo_wordmark: unknown }> }).rows[0]
      .logo_wordmark;

    const out = (clientBranding.logoWordmark as unknown as {
      mapFromDriverValue: (x: unknown) => Buffer;
    }).mapFromDriverValue(raw);

    expect(out.length).toBe(payload.length);
    expect(out.equals(payload)).toBe(true);
  });
});
