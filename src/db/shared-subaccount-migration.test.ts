import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0035, run for real against a Postgres shaped like production before
 * it. Hand-written migrations are not in drizzle's journal, so nothing else runs
 * this file before it reaches production. What matters there: it runs twice
 * without complaint, changes no existing row (every client stays unshared, so
 * every number stays identical), and the database itself refuses a person
 * counted twice in one share.
 */

const MIGRATION = readFileSync(join(process.cwd(), "drizzle", "0035_shared_ghl_subaccount.sql"), "utf8");

const SHARE = "11111111-0000-0000-0000-000000000001";

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TABLE clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text NOT NULL UNIQUE
    );
    CREATE TABLE ghl_installations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id text NOT NULL UNIQUE,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL
    );
    CREATE TABLE contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      ghl_contact_id text NOT NULL,
      CONSTRAINT contacts_client_ghl_key UNIQUE (client_id, ghl_contact_id)
    );
    CREATE TABLE opportunities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      ghl_opportunity_id text NOT NULL,
      ghl_contact_id text,
      CONSTRAINT opportunities_client_ghl_key UNIQUE (client_id, ghl_opportunity_id)
    );
    INSERT INTO clients (name, slug) VALUES ('Aloha LASER Vision', 'aloha-vision'), ('Aloha Laser Aesthetic', 'aloha-aesthetic');
    INSERT INTO ghl_installations (id, location_id, client_id)
      SELECT '${SHARE}', 'loc-aloha', id FROM clients WHERE slug = 'aloha-vision';
    INSERT INTO contacts (client_id, ghl_contact_id) SELECT id, 'g1' FROM clients;
    INSERT INTO opportunities (client_id, ghl_opportunity_id, ghl_contact_id) SELECT id, 'o1', 'g1' FROM clients;
  `);
});

afterAll(async () => {
  await pg.close();
});

describe("0035_shared_ghl_subaccount.sql", () => {
  it("applies, and applies again without complaint", async () => {
    await pg.exec(MIGRATION);
    await pg.exec(MIGRATION);
    const { rows } = await pg.query<{ col: string }>(
      `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
        WHERE column_name LIKE 'ghl_share_%' OR column_name LIKE 'share_%' ORDER BY 1`,
    );
    expect(rows.map((r) => r.col)).toEqual([
      "clients.ghl_share_gets_untagged",
      "clients.ghl_share_installation_id",
      "clients.ghl_share_keep_removed",
      "clients.ghl_share_since",
      "clients.ghl_share_split_version",
      "clients.ghl_share_tags",
      "clients.ghl_share_version",
      "contacts.share_counted",
      "contacts.share_installation_id",
      "contacts.share_reason",
      "opportunities.share_counted",
      "opportunities.share_installation_id",
    ]);
  });

  it("leaves every existing client unshared and every row counted", async () => {
    const clients = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM clients
        WHERE ghl_share_installation_id IS NOT NULL OR ghl_share_gets_untagged OR cardinality(ghl_share_tags) > 0
           OR NOT ghl_share_keep_removed OR ghl_share_version <> 0 OR ghl_share_split_version <> 0`,
    );
    expect(clients.rows[0].n).toBe(0);
    const rows = await pg.query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM contacts WHERE share_installation_id IS NOT NULL OR share_counted IS NOT NULL OR share_reason IS NOT NULL)
            + (SELECT COUNT(*) FROM opportunities WHERE share_installation_id IS NOT NULL OR share_counted IS NOT NULL) AS n`,
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it("🔴 refuses a second counted copy of one person, or one card, in a share", async () => {
    await pg.exec(`
      UPDATE contacts SET share_installation_id = '${SHARE}', share_counted = false;
      UPDATE opportunities SET share_installation_id = '${SHARE}', share_counted = false;
      UPDATE contacts SET share_counted = true WHERE client_id = (SELECT id FROM clients WHERE slug = 'aloha-vision');
      UPDATE opportunities SET share_counted = true WHERE client_id = (SELECT id FROM clients WHERE slug = 'aloha-vision');
    `);
    await expect(
      pg.exec(`UPDATE contacts SET share_counted = true WHERE client_id = (SELECT id FROM clients WHERE slug = 'aloha-aesthetic')`),
    ).rejects.toThrow(/contacts_share_one_counted_key/);
    await expect(
      pg.exec(`UPDATE opportunities SET share_counted = true WHERE client_id = (SELECT id FROM clients WHERE slug = 'aloha-aesthetic')`),
    ).rejects.toThrow(/opportunities_share_one_counted_key/);
    // Losers first, then the winner, in one transaction: the swap goes through.
    await pg.exec(`
      BEGIN;
      UPDATE contacts SET share_counted = false WHERE client_id = (SELECT id FROM clients WHERE slug = 'aloha-vision');
      UPDATE contacts SET share_counted = true WHERE client_id = (SELECT id FROM clients WHERE slug = 'aloha-aesthetic');
      COMMIT;
    `);
  });

  it("lets at most one client of a share take the untagged leads", async () => {
    await pg.exec(`UPDATE clients SET ghl_share_installation_id = '${SHARE}'`);
    await pg.exec(`UPDATE clients SET ghl_share_gets_untagged = true WHERE slug = 'aloha-vision'`);
    await expect(
      pg.exec(`UPDATE clients SET ghl_share_gets_untagged = true WHERE slug = 'aloha-aesthetic'`),
    ).rejects.toThrow(/clients_ghl_share_one_untagged_key/);
  });

  it("drops the share from its clients when the installation row goes", async () => {
    await pg.exec(`DELETE FROM ghl_installations WHERE id = '${SHARE}'`);
    const { rows } = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM clients WHERE ghl_share_installation_id IS NOT NULL`,
    );
    expect(rows[0].n).toBe(0);
  });
});
