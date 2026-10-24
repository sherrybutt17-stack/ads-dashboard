import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0032, run for real against a Postgres that looks like production
 * before it: `agencies` exists, `custom_metrics` does not.
 *
 * Hand-written migrations are not in drizzle's journal, so nothing else runs
 * this file before it reaches production. What matters there: it can be run
 * twice, a new row has sensible defaults, an agency can have many metrics, and
 * removing an agency removes its metrics.
 */

const MIGRATION = readFileSync(join(process.cwd(), "drizzle", "0032_custom_metrics.sql"), "utf8");

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TABLE agencies (
      id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text NOT NULL
    );
    INSERT INTO agencies (id, name, slug) VALUES ('${A}', 'Acme', 'acme'), ('${B}', 'Bright', 'bright');
  `);
});

afterAll(async () => {
  await pg.close();
});

describe("0032_custom_metrics.sql", () => {
  it("applies, and applies again without complaint", async () => {
    await pg.exec(MIGRATION);
    await pg.exec(MIGRATION);
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'custom_metrics' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      "id",
      "agency_id",
      "kind",
      "platform",
      "base_metric",
      "expression",
      "label",
      "description",
      "format",
      "polarity",
      "archived_at",
      "created_by",
      "updated_by",
      "created_at",
      "updated_at",
    ]);
  });

  it("gives a new metric an id and leaves it live", async () => {
    await pg.exec(
      `INSERT INTO custom_metrics (agency_id, kind, platform, base_metric, label)
       VALUES ('${A}', 'rename', 'meta', 'fb_onsite_leads', 'Form leads')`,
    );
    const { rows } = await pg.query<Record<string, unknown>>(
      `SELECT id IS NOT NULL AS has_id, archived_at, expression FROM custom_metrics WHERE agency_id = '${A}'`,
    );
    expect(rows[0]).toEqual({ has_id: true, archived_at: null, expression: null });
  });

  it("lets an agency have many metrics, and stores a formula's tokens as they are", async () => {
    const tokens = JSON.stringify([{ t: "stat", id: "spend" }, { t: "op", v: "/" }, { t: "stat", id: "appointments" }]);
    await pg.exec(
      `INSERT INTO custom_metrics (agency_id, kind, platform, expression, label, format, polarity)
       VALUES ('${A}', 'formula', 'any', '${tokens}'::jsonb, 'Cost per booked call', 'currency', 'lower-better')`,
    );
    const { rows } = await pg.query<{ expression: unknown }>(
      `SELECT expression FROM custom_metrics WHERE agency_id = '${A}' AND kind = 'formula'`,
    );
    expect(rows[0].expression).toEqual(JSON.parse(tokens));
  });

  it("refuses a metric for an agency that does not exist", async () => {
    await expect(
      pg.exec(
        `INSERT INTO custom_metrics (agency_id, kind, platform, label)
         VALUES ('cccccccc-0000-0000-0000-000000000003', 'rename', 'meta', 'Orphan')`,
      ),
    ).rejects.toThrow();
  });

  it("removes an agency's metrics with the agency, and no one else's", async () => {
    await pg.exec(`INSERT INTO custom_metrics (agency_id, kind, platform, label) VALUES ('${B}', 'rename', 'google', 'Calls')`);
    await pg.exec(`DELETE FROM agencies WHERE id = '${A}'`);
    const { rows } = await pg.query<{ agency_id: string }>(`SELECT agency_id FROM custom_metrics`);
    expect(rows.map((r) => r.agency_id)).toEqual([B]);
  });
});
