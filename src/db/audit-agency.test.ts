import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * 🔴 `drizzle/0024_audit_agency.sql`, run against a real Postgres.
 *
 * Same reasoning as `tenancy.test.ts`: this file will be run once, by hand,
 * against a database holding the only copy of the audit trail, and `db:push`
 * cannot produce it because it moves DATA. What makes it worth its own test is
 * the backfill — a column added and left empty would silently make every
 * historical entry invisible to the agency it concerns, and nothing about that
 * failure looks like a failure. The page would simply be emptier than it should
 * be, which is exactly the class of silent gap this product exists to replace.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "drizzle", "0024_audit_agency.sql"),
  "utf8",
);

const AGENCY_A = "11111111-1111-1111-1111-111111111111";
const AGENCY_B = "22222222-2222-2222-2222-222222222222";
const CLIENT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const CLIENT_B = "bbbbbbbb-0000-0000-0000-000000000001";

/**
 * The schema as it stands AFTER 0023 and BEFORE this migration: `clients` has
 * an agency, `audit_log` does not. A fixture that already had the column would
 * test an already-applied migration and pass for the wrong reason.
 */
const BEFORE = `
CREATE TABLE agencies (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL
);

CREATE TABLE clients (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  name      text NOT NULL,
  slug      text NOT NULL
);

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  action      text NOT NULL,
  target_type text,
  target_id   text,
  client_id   uuid REFERENCES clients(id) ON DELETE SET NULL,
  ip          text,
  user_agent  text,
  metadata    jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at);
CREATE INDEX audit_log_action_idx ON audit_log (action);
CREATE INDEX audit_log_client_idx ON audit_log (client_id);

INSERT INTO agencies (id, name, slug) VALUES
  ('${AGENCY_A}', 'Agency A', 'agency-a'),
  ('${AGENCY_B}', 'Agency B', 'agency-b');

INSERT INTO clients (id, agency_id, name, slug) VALUES
  ('${CLIENT_A}', '${AGENCY_A}', 'Acme', 'acme'),
  ('${CLIENT_B}', '${AGENCY_B}', 'Borden', 'borden');

INSERT INTO audit_log (action, target_type, client_id, metadata) VALUES
  ('meta_account.add', 'meta_account', '${CLIENT_A}', '{}'),
  ('client.update',    'client',       '${CLIENT_A}', '{}'),
  ('google_account.add','google_account','${CLIENT_B}', '{}'),
  -- No client: a failed login for an address matching no account. Stays
  -- untenanted, and that is the assertion, not an oversight.
  ('auth.login_failed', 'session',     NULL,          '{"email":"nobody@example.com"}');
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(BEFORE);
  await pg.exec(MIGRATION);
});

afterAll(async () => {
  await pg.close();
});

async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await pg.query<T>(sql);
  return res.rows;
}

describe("0024_audit_agency", () => {
  it("adds the column", async () => {
    const cols = await rows<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'audit_log' AND column_name = 'agency_id'`,
    );
    expect(cols).toHaveLength(1);
    // Nullable permanently — platform-level events have no tenant.
    expect(cols[0].is_nullable).toBe("YES");
  });

  it("backfills every entry that names a client", async () => {
    const got = await rows<{ action: string; agency_id: string | null }>(
      `SELECT action, agency_id FROM audit_log ORDER BY action`,
    );
    const byAction = Object.fromEntries(got.map((r) => [r.action, r.agency_id]));
    expect(byAction["meta_account.add"]).toBe(AGENCY_A);
    expect(byAction["client.update"]).toBe(AGENCY_A);
    expect(byAction["google_account.add"]).toBe(AGENCY_B);
  });

  it("leaves untenanted entries null rather than guessing", async () => {
    /*
     * The one that matters. `audit_log` has never stored a user id, so the only
     * clue to whose failed login this was is an email in `metadata` — and
     * attributing it to whichever agency owns that address today would file one
     * tenant's security event in another tenant's trail.
     */
    const [row] = await rows<{ agency_id: string | null }>(
      `SELECT agency_id FROM audit_log WHERE action = 'auth.login_failed'`,
    );
    expect(row.agency_id).toBeNull();
  });

  it("indexes the scoped read, sort included", async () => {
    const idx = await rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'audit_log' AND indexname = 'audit_log_agency_at_idx'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/agency_id/);
    // Without DESC in the index the tenant filter still uses it and the sort
    // does not — every page load then sorts the whole matching set.
    expect(idx[0].indexdef).toMatch(/at DESC/i);
  });

  it("keeps the trail when a tenant is deleted", async () => {
    /*
     * `ON DELETE SET NULL`, not cascade. An audit trail that disappears along
     * with its subject is not evidence of anything — the rows survive,
     * unattributed, readable by superadmins.
     */
    await pg.exec(`
      INSERT INTO agencies (id, name, slug)
        VALUES ('33333333-3333-3333-3333-333333333333', 'Doomed', 'doomed');
      INSERT INTO audit_log (action, target_type, agency_id)
        VALUES ('client.archive', 'client', '33333333-3333-3333-3333-333333333333');
      DELETE FROM agencies WHERE id = '33333333-3333-3333-3333-333333333333';
    `);
    const [row] = await rows<{ agency_id: string | null }>(
      `SELECT agency_id FROM audit_log WHERE action = 'client.archive'`,
    );
    expect(row).toBeDefined();
    expect(row.agency_id).toBeNull();
  });

  it("is safe to run twice", async () => {
    // Half-applied migrations get re-run; see the header of 0023.
    await expect(pg.exec(MIGRATION)).resolves.toBeDefined();
    const [{ count }] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE agency_id = '${AGENCY_A}'`,
    );
    expect(count).toBe("2");
  });
});
