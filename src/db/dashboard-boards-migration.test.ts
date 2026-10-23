import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0030, run for real against a Postgres that looks like production
 * before it: `clients` exists, `dashboard_boards` does not.
 *
 * Hand-written migrations are not in drizzle's journal, so nothing else runs
 * this file before it reaches production. The properties that matter there:
 * it can be run twice (someone will), deleting a client removes its board, and
 * a client cannot end up with two boards.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "drizzle", "0030_dashboard_boards.sql"),
  "utf8",
);

const CLIENT = "aaaaaaaa-0000-0000-0000-000000000001";

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TABLE clients (
      id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text NOT NULL
    );
    INSERT INTO clients (id, name, slug) VALUES ('${CLIENT}', 'Acme', 'acme');
  `);
});

afterAll(async () => {
  await pg.close();
});

describe("0030_dashboard_boards.sql", () => {
  it("applies, and applies again without complaint", async () => {
    await pg.exec(MIGRATION);
    await pg.exec(MIGRATION);
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'dashboard_boards' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "id",
      "client_id",
      "name",
      "widgets",
      "schema_version",
      "locked",
      "updated_at",
      "updated_by",
    ]);
  });

  it("allows one board per client", async () => {
    await pg.exec(`INSERT INTO dashboard_boards (client_id, widgets) VALUES ('${CLIENT}', '[]')`);
    await expect(
      pg.exec(`INSERT INTO dashboard_boards (client_id, widgets) VALUES ('${CLIENT}', '[]')`),
    ).rejects.toThrow();
  });

  it("starts unlocked, at version 1", async () => {
    const r = await pg.query<{ locked: boolean; schema_version: number; name: string }>(
      `SELECT locked, schema_version, name FROM dashboard_boards WHERE client_id = '${CLIENT}'`,
    );
    expect(r.rows[0]).toEqual({ locked: false, schema_version: 1, name: "Board" });
  });

  it("removes the board with its client", async () => {
    await pg.exec(`DELETE FROM clients WHERE id = '${CLIENT}'`);
    const r = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM dashboard_boards`);
    expect(r.rows[0].n).toBe(0);
  });
});
