import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0031, run for real against a Postgres that looks like production
 * before it: `agencies` exists, `agency_email_domains` does not.
 *
 * Hand-written migrations are not in drizzle's journal, so nothing else runs
 * this file before it reaches production. What matters there: it can be run
 * twice, removing an agency removes its domain row, an agency has at most one
 * domain, and no two agencies can hold the same one.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "drizzle", "0031_agency_email_domains.sql"),
  "utf8",
);

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

describe("0031_agency_email_domains.sql", () => {
  it("applies, and applies again without complaint", async () => {
    await pg.exec(MIGRATION);
    await pg.exec(MIGRATION);
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agency_email_domains' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      "agency_id",
      "domain",
      "resend_domain_id",
      "status",
      "records",
      "from_local",
      "from_name",
      "reply_to",
      "last_error",
      "verified_at",
      "checked_at",
      "created_by",
      "created_at",
      "updated_at",
    ]);
  });

  it("defaults a new row to an unchecked domain sending as reports@", async () => {
    await pg.exec(
      `INSERT INTO agency_email_domains (agency_id, domain, resend_domain_id) VALUES ('${A}', 'acme.com', 'rd_a')`,
    );
    const { rows } = await pg.query<Record<string, unknown>>(
      `SELECT status, records, from_local, verified_at FROM agency_email_domains WHERE agency_id = '${A}'`,
    );
    expect(rows[0]).toEqual({ status: "not_started", records: [], from_local: "reports", verified_at: null });
  });

  it("gives an agency one domain, and a domain one agency", async () => {
    await expect(
      pg.exec(`INSERT INTO agency_email_domains (agency_id, domain, resend_domain_id) VALUES ('${A}', 'other.com', 'rd_x')`),
    ).rejects.toThrow();
    await expect(
      pg.exec(`INSERT INTO agency_email_domains (agency_id, domain, resend_domain_id) VALUES ('${B}', 'acme.com', 'rd_y')`),
    ).rejects.toThrow();
  });

  it("removes an agency's domain row with the agency", async () => {
    await pg.exec(`DELETE FROM agencies WHERE id = '${A}'`);
    const { rows } = await pg.query(`SELECT 1 FROM agency_email_domains WHERE agency_id = '${A}'`);
    expect(rows).toHaveLength(0);
  });
});
