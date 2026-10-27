import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { COUNT_UNTRIMMED_SQL, headersToStore, trimStoredPlatformHeaders } from "./webhook-headers";

describe("headersToStore", () => {
  it("drops Vercel's own headers and keeps what diagnoses a sender", () => {
    const kept = headersToStore(
      new Headers({
        "X-Vercel-Oidc-Token": "eyJ.token.sig",
        "x-vercel-sc-headers": "{}",
        "x-vercel-id": "iad1::abc",
        "x-ghl-signature": "ed25519-sig",
        "x-wh-signature": "rsa-sig",
        "x-forwarded-for": "203.0.113.9",
        "content-type": "application/json",
        "user-agent": "GHL",
        "accept-encoding": "gzip",
      }),
    );
    expect(kept).toEqual({
      "x-ghl-signature": "ed25519-sig",
      "x-wh-signature": "rsa-sig",
      "x-forwarded-for": "203.0.113.9",
      "content-type": "application/json",
      "user-agent": "GHL",
    });
  });
});

describe("the clean-up of stored events (PGlite)", () => {
  let h: { db: TestDb; close: () => Promise<void> };
  const client = () => h.db.$client;
  const query = (text: string, params?: unknown[]) =>
    client().query<Record<string, unknown>>(text, params) as Promise<{ rows: Record<string, unknown>[] }>;

  const OLD = '{"x-vercel-oidc-token":"eyJ.token.sig","x-vercel-id":"iad1::abc","x-ghl-signature":"sig","user-agent":"GHL","__signature":"valid"}';

  beforeAll(async () => {
    h = await createTestDb();
    await client().exec(`
      INSERT INTO webhook_events (event_type, headers, payload, status)
      SELECT 'OpportunityStageUpdate', '${OLD}'::jsonb, jsonb_build_object('n', g), 'processed'
        FROM generate_series(1, 2500) AS g;
      INSERT INTO webhook_events (event_type, headers, payload, status) VALUES
        ('INSTALL', '{"x-ghl-signature":"sig","__signature":"valid"}'::jsonb, '{"type":"INSTALL"}'::jsonb, 'processed'),
        ('none', NULL, '{}'::jsonb, 'ignored'),
        ('odd', '["x-vercel-id"]'::jsonb, '{}'::jsonb, 'ignored');`);
  });
  afterAll(() => h.close());

  it("trims every batch, and only the Vercel keys", async () => {
    expect((await query(COUNT_UNTRIMMED_SQL)).rows[0].n).toBe(2500);
    const seen: number[] = [];
    expect(await trimStoredPlatformHeaders(query, (n) => seen.push(n))).toBe(2500);
    expect(seen.length).toBeGreaterThanOrEqual(3); // crossed batch boundaries
    expect((await query(COUNT_UNTRIMMED_SQL)).rows[0].n).toBe(0);

    const { rows } = await query(
      `SELECT headers, payload->>'n' AS n FROM webhook_events WHERE event_type = 'OpportunityStageUpdate' ORDER BY (payload->>'n')::int LIMIT 1`,
    );
    expect(rows[0]).toEqual({
      headers: { "x-ghl-signature": "sig", "user-agent": "GHL", __signature: "valid" },
      n: "1",
    });
  });

  it("leaves untouched what it should, and changes nothing on a second run", async () => {
    const rest = await query(`SELECT event_type, headers FROM webhook_events WHERE event_type IN ('INSTALL','none','odd') ORDER BY event_type`);
    expect(rest.rows).toEqual([
      { event_type: "INSTALL", headers: { "x-ghl-signature": "sig", __signature: "valid" } },
      { event_type: "none", headers: null },
      { event_type: "odd", headers: ["x-vercel-id"] },
    ]);
    expect(await trimStoredPlatformHeaders(query)).toBe(0);
    // The install flow's read still finds every signed event.
    const signed = await query(`SELECT count(*)::int AS n FROM webhook_events WHERE headers->>'__signature' = 'valid'`);
    expect(signed.rows[0].n).toBe(2501);
  });

  it("gives the space back with the script's VACUUM, data intact", async () => {
    await client().exec("VACUUM (FULL, ANALYZE) webhook_events");
    const after = await query(`SELECT count(*)::int AS n, count(DISTINCT payload)::int AS payloads FROM webhook_events`);
    // 2,500 distinct + the INSTALL one + `{}` shared by the last two.
    expect(after.rows[0]).toEqual({ n: 2503, payloads: 2502 });
  });
});
