import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { BOOTSTRAP_AGENCY_ID } from "./schema";

/**
 * 🔴 The tenancy migration, run against a real Postgres.
 *
 * `drizzle/0023_tenancy.sql` is the one artifact in this change that `db:push`
 * cannot produce and typechecking cannot see. It moves DATA — two NOT NULL
 * columns backfilled onto tables that already hold rows — and it will be run
 * exactly once, by hand, against a database holding the only copy of the
 * `stage_transitions` ledger. An untested migration script is a guess, and this
 * is a bad place to guess.
 *
 * PGlite is Postgres compiled to WASM, so `DO $$`, `ALTER TYPE ... ADD VALUE`,
 * constraint names and index definitions all behave as they will in production.
 * The fixture below is the shape of the database BEFORE the migration —
 * singleton branding, globally-unique ad-account keys, no agency anywhere —
 * because a migration tested against the post-migration schema tests nothing.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "drizzle", "0023_tenancy.sql"),
  "utf8",
);

/**
 * The pre-tenancy schema, cut down to the tables the migration touches.
 *
 * Deliberately the OLD shapes: `agency_settings` keyed on a text `SINGLETON`,
 * `user_role` with only the two original values, and unique indexes on the ad
 * account ids alone. If this fixture drifted toward the new schema the
 * migration would be applied to a database that had already had it applied,
 * and every assertion below would pass for the wrong reason.
 */
const BEFORE = `
CREATE TYPE user_role AS ENUM ('staff', 'client');
CREATE TYPE user_status AS ENUM ('active', 'disabled');
CREATE TYPE agency_mark_mode AS ENUM ('full', 'prepared_by', 'none');

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Los_Angeles'
);
CREATE UNIQUE INDEX clients_slug_key ON clients (slug);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'client',
  status user_status NOT NULL DEFAULT 'active'
);

CREATE TABLE agency_settings (
  id text PRIMARY KEY DEFAULT 'SINGLETON',
  agency_name text,
  agency_mark_mode agency_mark_mode NOT NULL DEFAULT 'prepared_by',
  support_email text,
  logo_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meta_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ad_account_id text NOT NULL
);
CREATE UNIQUE INDEX meta_ad_accounts_account_key ON meta_ad_accounts (ad_account_id);

CREATE TABLE google_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  customer_id text NOT NULL
);
CREATE UNIQUE INDEX google_ad_accounts_customer_key
  ON google_ad_accounts (customer_id);
`;

const SEED = `
INSERT INTO clients (id, name, slug) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Parfaire', 'parfaire'),
  ('22222222-2222-2222-2222-222222222222', 'Second Client', 'second');

INSERT INTO users (id, email, password_hash, role) VALUES
  ('33333333-3333-3333-3333-333333333333', 'ops@example.com', 'x', 'staff'),
  ('44444444-4444-4444-4444-444444444444', 'viewer@example.com', 'x', 'client');

INSERT INTO agency_settings (id, agency_name) VALUES ('SINGLETON', 'Growth Guild');

INSERT INTO meta_ad_accounts (client_id, ad_account_id)
  VALUES ('11111111-1111-1111-1111-111111111111', '9001');
INSERT INTO google_ad_accounts (client_id, customer_id)
  VALUES ('11111111-1111-1111-1111-111111111111', '123-456-7890');
`;

let pg: PGlite;

/** Rows as plain objects, for the assertions below. */
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await pg.exec(sql);
  return (res[res.length - 1]?.rows ?? []) as T[];
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(BEFORE);
  await pg.exec(SEED);
  // The migration under test. Run through `exec` rather than statement-split so
  // the `DO $$ … $$` blocks stay intact — splitting on `;` would cut them apart.
  await pg.exec(MIGRATION);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe("0023 tenancy migration", () => {
  it("🔴 uses the same bootstrap id the application code does", async () => {
    /*
     * If these disagree, every backfilled client points at an agency row that
     * does not exist — and the failure surfaces as a foreign key violation on
     * the first write after deploy, not here.
     */
    const [row] = await rows<{ id: string }>("SELECT id FROM agencies");
    expect(row.id).toBe(BOOTSTRAP_AGENCY_ID);
  });

  it("gives every existing client and user a tenant", async () => {
    const [c] = await rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM clients
        WHERE agency_id = '${BOOTSTRAP_AGENCY_ID}'`,
    );
    const [u] = await rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM users
        WHERE agency_id = '${BOOTSTRAP_AGENCY_ID}'`,
    );
    expect(c.n).toBe("2");
    expect(u.n).toBe("2");
  });

  it("🔴 makes a tenant-less client impossible, not merely unusual", async () => {
    // The backfill is only half the job. Without NOT NULL, the next insert that
    // forgets the tenant succeeds and the row is invisible to every scoped
    // query ever written — a silent partial outage rather than an error.
    await expect(
      pg.exec(`INSERT INTO clients (name, slug) VALUES ('No Tenant', 'no-tenant')`),
    ).rejects.toThrow();
  });

  it("refuses to delete an agency out from under its clients", async () => {
    // `restrict`, not `cascade`: a cascade here would take the clients and with
    // them the stage_transitions ledger, which no API can rebuild.
    await expect(
      pg.exec(`DELETE FROM agencies WHERE id = '${BOOTSTRAP_AGENCY_ID}'`),
    ).rejects.toThrow();
  });

  it("re-keys branding from the singleton to the agency, keeping the row", async () => {
    const [row] = await rows<{ agency_id: string; agency_name: string }>(
      "SELECT agency_id, agency_name FROM agency_settings",
    );
    expect(row.agency_id).toBe(BOOTSTRAP_AGENCY_ID);
    // The existing branding survives the re-key. Losing it would be a small
    // thing that nonetheless shows up on the next client-facing report.
    expect(row.agency_name).toBe("Growth Guild");

    const [old] = await rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'agency_settings' AND column_name = 'id'`,
    );
    expect(old.n).toBe("0");

    /*
     * `agency_id` must be the PRIMARY KEY, not merely a filled-in column.
     * `saveAgencySettings` upserts with `onConflictDoUpdate({ target:
     * agencySettings.agencyId })`, which Postgres rejects outright without a
     * unique constraint to conflict on — so a re-key that dropped the old key
     * and forgot the new one would break every branding save.
     */
    const [pk] = await rows<{ col: string }>(
      `SELECT a.attname AS col
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'agency_settings'::regclass AND i.indisprimary`,
    );
    expect(pk?.col).toBe("agency_id");
  });

  it("adds the new roles without disturbing the ones in use", async () => {
    const labels = await rows<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_role' ORDER BY e.enumsortorder`,
    );
    expect(labels.map((r) => r.enumlabel)).toEqual([
      "staff",
      "client",
      "superadmin",
      "agency",
    ]);
    // 🔴 Nobody is re-roled by this migration. Every `staffGuard()` call site
    // still checks for `staff`, and moving the guards is Phase 2's job.
    const [staff] = await rows<{ n: string }>(
      "SELECT count(*)::text AS n FROM users WHERE role = 'staff'",
    );
    expect(staff.n).toBe("1");
  });

  it("🔴 un-squats the ad-account keys", async () => {
    /*
     * The whole point. With a GLOBAL unique on the account id, the first agency
     * to type an id owns it forever and the real owner is locked out — and the
     * rejection message confirms to a stranger that some other tenant holds it.
     * Two clients holding the same account id must now be possible at the
     * database level; preventing it WITHIN one agency is an application check
     * that can answer helpfully without answering across a boundary.
     */
    await pg.exec(
      `INSERT INTO meta_ad_accounts (client_id, ad_account_id)
       VALUES ('22222222-2222-2222-2222-222222222222', '9001')`,
    );
    await pg.exec(
      `INSERT INTO google_ad_accounts (client_id, customer_id)
       VALUES ('22222222-2222-2222-2222-222222222222', '123-456-7890')`,
    );

    const [m] = await rows<{ n: string }>(
      "SELECT count(*)::text AS n FROM meta_ad_accounts WHERE ad_account_id = '9001'",
    );
    expect(m.n).toBe("2");
  });

  it("still stops the SAME client holding one account twice", async () => {
    // The scoping must not throw away the constraint that stops one client's
    // spend being counted twice over.
    await expect(
      pg.exec(
        `INSERT INTO meta_ad_accounts (client_id, ad_account_id)
         VALUES ('11111111-1111-1111-1111-111111111111', '9001')`,
      ),
    ).rejects.toThrow();
  });

  it("🔴 stamps existing logins as verified rather than locking them out", async () => {
    /*
     * Self-serve sign-up refuses a session to an unverified address. Every
     * account that predates it was created by hand, by someone who already knew
     * the person — a stronger proof than an email round-trip — so leaving them
     * null would lock out every current user the moment sign-up ships, with no
     * verification email having ever been sent to them.
     */
    const unverified = await rows<{ n: string }>(
      "SELECT count(*)::text AS n FROM users WHERE email_verified_at IS NULL",
    );
    expect(unverified[0].n).toBe("0");
  });

  it("🔴 can be run a second time without damage", async () => {
    /*
     * This is not tidiness. The script will be run by hand against production,
     * and the realistic failure is that it dies halfway — a lock timeout, a
     * dropped connection — leaving the operator to decide whether re-running is
     * safe. It has to be, or the answer is a restore.
     */
    await expect(pg.exec(MIGRATION)).resolves.toBeDefined();

    const [agencies] = await rows<{ n: string }>(
      "SELECT count(*)::text AS n FROM agencies",
    );
    const [tenanted] = await rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM clients
        WHERE agency_id = '${BOOTSTRAP_AGENCY_ID}'`,
    );
    const [branding] = await rows<{ n: string }>(
      "SELECT count(*)::text AS n FROM agency_settings",
    );
    expect(agencies.n).toBe("1");
    expect(tenanted.n).toBe("2");
    expect(branding.n).toBe("1");
  });
});
