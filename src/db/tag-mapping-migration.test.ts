import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0034, run for real against a Postgres shaped like production
 * before it. Hand-written migrations are not in drizzle's journal, so nothing
 * else runs this file before it reaches production. What matters there: it runs
 * twice without complaint, switches the OPTION on for exactly Reflexion Digital
 * and the two "abdul" test clients, and changes nobody's numbers — every client
 * stays on pipeline until someone saves "Map by tag".
 */

const MIGRATION = readFileSync(join(process.cwd(), "drizzle", "0034_tag_mapping.sql"), "utf8");

const REFLEXION = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER = "bbbbbbbb-0000-0000-0000-000000000002";

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TYPE canonical_stage AS ENUM ('new_lead','contacted','appointment_booked','showed','no_show','closed_won','lost','disqualified');
    CREATE TYPE transition_source AS ENUM ('webhook','backfill_snapshot','manual');
    CREATE TABLE agencies (id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL);
    CREATE TABLE clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agency_id uuid NOT NULL REFERENCES agencies(id),
      name text NOT NULL,
      slug text NOT NULL UNIQUE
    );
    CREATE TABLE contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      ghl_contact_id text NOT NULL
    );
    CREATE TABLE opportunities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      ghl_opportunity_id text NOT NULL
    );
    CREATE TABLE stage_transitions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL,
      source transition_source NOT NULL DEFAULT 'webhook'
    );
    INSERT INTO agencies (id, name, slug) VALUES
      ('${REFLEXION}', 'Reflexion Digital', 'reflexion-digital'),
      ('${OTHER}', 'Growth Guild', 'growth-guild');
    INSERT INTO clients (agency_id, name, slug) VALUES
      ('${REFLEXION}', 'IQ Laser Vision', 'iq-laser-vision'),
      ('${OTHER}', 'Abdul', 'abdul'),
      ('${OTHER}', 'Abdul Rehman', 'abdul-rehman'),
      ('${OTHER}', 'GG ads', 'gg-ads');
    INSERT INTO opportunities (client_id, ghl_opportunity_id)
      SELECT id, 'o-' || slug FROM clients;
  `);
});

afterAll(async () => {
  await pg.close();
});

describe("0034_tag_mapping.sql", () => {
  it("applies, and applies again without complaint", async () => {
    await pg.exec(MIGRATION);
    await pg.exec(MIGRATION);
    const { rows } = await pg.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::transition_source))::text AS v`,
    );
    expect(rows.map((r) => r.v)).toEqual(["webhook", "backfill_snapshot", "manual", "tag"]);
  });

  it("offers the option to Reflexion Digital and the two abdul clients only", async () => {
    const agencies = await pg.query<{ slug: string; on: boolean }>(
      `SELECT slug, tag_mapping_enabled AS on FROM agencies ORDER BY slug`,
    );
    expect(agencies.rows).toEqual([
      { slug: "growth-guild", on: false },
      { slug: "reflexion-digital", on: true },
    ]);
    const clients = await pg.query<{ slug: string; allowed: boolean }>(
      `SELECT slug, tag_mapping_allowed AS allowed FROM clients ORDER BY slug`,
    );
    expect(clients.rows).toEqual([
      { slug: "abdul", allowed: true },
      { slug: "abdul-rehman", allowed: true },
      { slug: "gg-ads", allowed: false },
      { slug: "iq-laser-vision", allowed: false },
    ]);
  });

  it("leaves every client counted by pipeline, and every opportunity a real one", async () => {
    const modes = await pg.query<{ mode: string; every: boolean }>(
      `SELECT DISTINCT crm_mapping_mode::text AS mode, tag_lead_every_contact AS every FROM clients`,
    );
    expect(modes.rows).toEqual([{ mode: "pipeline", every: false }]);
    const opps = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM opportunities WHERE from_tags`);
    expect(opps.rows[0].n).toBe(0);
  });

  it("keeps one step per tag, and forgets a contact's tags when the contact goes", async () => {
    const { rows } = await pg.query<{ id: string }>(`SELECT id FROM clients WHERE slug = 'abdul'`);
    const client = rows[0].id;
    await pg.exec(`
      INSERT INTO tag_stage_mappings (client_id, tag, canonical_stage) VALUES ('${client}', 'booked', 'appointment_booked');
      INSERT INTO contacts (id, client_id, ghl_contact_id) VALUES ('cccccccc-0000-0000-0000-000000000001', '${client}', 'g1');
      INSERT INTO contact_tag_history (contact_id, client_id, tag, first_seen_at)
        VALUES ('cccccccc-0000-0000-0000-000000000001', '${client}', 'booked', now());
    `);
    await expect(
      pg.exec(`INSERT INTO tag_stage_mappings (client_id, tag, canonical_stage) VALUES ('${client}', 'booked', 'showed')`),
    ).rejects.toThrow();
    await pg.exec(`DELETE FROM contacts WHERE id = 'cccccccc-0000-0000-0000-000000000001'`);
    const left = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM contact_tag_history`);
    expect(left.rows[0].n).toBe(0);
  });
});
