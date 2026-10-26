import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0033, run for real against a Postgres that looks like production
 * before it: `clients`, the `creative_type` and `sync_kind` enums and
 * `tiktok_daily_metrics` exist; the three ad-level tables do not.
 *
 * Hand-written migrations are not in drizzle's journal, so nothing else runs
 * this file before it reaches production. What matters there: it can be run
 * twice, it leaves the spend table alone, one ad has one row per day, and
 * removing a client removes its ad-level rows.
 */

const MIGRATION = readFileSync(join(process.cwd(), "drizzle", "0033_tiktok_ad_level.sql"), "utf8");

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TYPE creative_type AS ENUM ('image','video','carousel','unknown');
    CREATE TYPE sync_kind AS ENUM ('meta_daily','tiktok_daily','tiktok_intraday','tiktok_backfill');
    CREATE TABLE clients (
      id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text NOT NULL
    );
    CREATE TABLE tiktok_daily_metrics (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      advertiser_id text NOT NULL DEFAULT '',
      date date NOT NULL,
      tiktok_campaign_id text NOT NULL DEFAULT '',
      spend numeric(14,4) NOT NULL DEFAULT '0'
    );
    INSERT INTO clients (id, name, slug) VALUES ('${A}', 'Acme', 'acme'), ('${B}', 'Bright', 'bright');
    INSERT INTO tiktok_daily_metrics (client_id, advertiser_id, date, tiktok_campaign_id, spend)
      VALUES ('${A}', '700000000000001', '2026-10-01', 'c1', 40);
  `);
});

afterAll(async () => {
  await pg.close();
});

const columns = async (table: string) =>
  (
    await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [table],
    )
  ).rows.map((c) => c.column_name);

describe("0033_tiktok_ad_level.sql", () => {
  it("applies, and applies again without complaint", async () => {
    await pg.exec(MIGRATION);
    await pg.exec(MIGRATION);
    expect(await columns("tiktok_ad_daily_metrics")).toEqual([
      "id", "client_id", "advertiser_id", "date", "tiktok_campaign_id", "campaign_name",
      "tiktok_adgroup_id", "adgroup_name", "tiktok_ad_id", "ad_name", "creative_key", "creative_type",
      "impressions", "clicks", "spend", "conversions", "currency", "raw", "synced_at",
    ]);
    expect(await columns("tiktok_ad_creatives")).toContain("thumb_key");
    expect(await columns("tiktok_creative_assets")).toContain("thumb");
  });

  it("🔴 leaves the spend table exactly as it was", async () => {
    // Its readers sum it with no level filter; ad rows there would double spend.
    expect(await columns("tiktok_daily_metrics")).toEqual([
      "id", "client_id", "advertiser_id", "date", "tiktok_campaign_id", "spend",
    ]);
    const { rows } = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM tiktok_daily_metrics`);
    expect(rows[0].n).toBe(1);
  });

  it("adds the ad-level run kind", async () => {
    const { rows } = await pg.query<{ v: string }>(`SELECT unnest(enum_range(NULL::sync_kind))::text AS v`);
    expect(rows.map((r) => r.v)).toContain("tiktok_adlevel");
  });

  it("keeps one row per ad per day, so a re-pull upserts", async () => {
    const row = `('${A}', '700000000000001', '2026-10-01', '1800000000000001', 12.5)`;
    await pg.exec(`INSERT INTO tiktok_ad_daily_metrics (client_id, advertiser_id, date, tiktok_ad_id, spend) VALUES ${row}`);
    await expect(
      pg.exec(`INSERT INTO tiktok_ad_daily_metrics (client_id, advertiser_id, date, tiktok_ad_id, spend) VALUES ${row}`),
    ).rejects.toThrow(/duplicate key/);
    const { rows } = await pg.query<Record<string, unknown>>(
      `SELECT creative_key, creative_type, impressions FROM tiktok_ad_daily_metrics`,
    );
    expect(rows[0]).toEqual({ creative_key: "", creative_type: "unknown", impressions: 0 });
  });

  it("stores a cover's bytes as they are", async () => {
    await pg.exec(
      `INSERT INTO tiktok_creative_assets (client_id, advertiser_id, asset_key, kind, thumb, thumb_content_type)
       VALUES ('${A}', '700000000000001', 'v:v10033', 'video', '\\xffd8ffe0'::bytea, 'image/jpeg')`,
    );
    const { rows } = await pg.query<{ hex: string }>(
      `SELECT encode(thumb, 'hex') AS hex FROM tiktok_creative_assets WHERE asset_key = 'v:v10033'`,
    );
    expect(rows[0].hex).toBe("ffd8ffe0");
  });

  it("🔴 removes a client's ad-level rows with the client, and nobody else's", async () => {
    await pg.exec(`
      INSERT INTO tiktok_ad_daily_metrics (client_id, advertiser_id, date, tiktok_ad_id) VALUES ('${B}', '700000000000002', '2026-10-01', '1800000000000009');
      INSERT INTO tiktok_ad_creatives (client_id, advertiser_id, tiktok_ad_id) VALUES ('${A}', '700000000000001', '1800000000000001'), ('${B}', '700000000000002', '1800000000000009');
    `);
    await pg.exec(`DELETE FROM clients WHERE id = '${A}'`);
    for (const table of ["tiktok_ad_daily_metrics", "tiktok_ad_creatives", "tiktok_creative_assets"]) {
      const { rows } = await pg.query<{ client_id: string }>(`SELECT DISTINCT client_id FROM ${table}`);
      expect(rows.map((r) => r.client_id).filter((id) => id === A), table).toEqual([]);
    }
    const { rows } = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM tiktok_ad_daily_metrics WHERE client_id = '${B}'`);
    expect(rows[0].n).toBe(1);
  });
});
