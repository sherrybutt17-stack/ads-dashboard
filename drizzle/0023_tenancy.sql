-- ===================================================================
-- Track B Phase 1 — the tenancy foundation
-- ===================================================================
--
-- 🔴 RUN THIS BEFORE `npm run db:push`, not after, and not instead of.
--
-- `db:push` diffs schema.ts against the database and generates its own DDL. It
-- is very good at that and completely incapable of the one thing this change
-- needs: moving DATA. `clients.agency_id` and `users.agency_id` are NOT NULL on
-- tables that already have rows, so push would have to invent a value —
-- it cannot, and will either prompt or fail. This script adds the columns
-- nullable, fills them, and only then tightens the constraint. Afterwards push
-- sees a schema that already matches and leaves these tables alone.
--
-- ── Safe to run more than once ──────────────────────────────────────
--
-- Every statement is guarded, and there is deliberately NO explicit
-- transaction wrapping the file. A half-applied migration you can simply re-run
-- is worth more here than an all-or-nothing one that leaves you reasoning about
-- which half landed — and `ALTER TYPE ... ADD VALUE` has its own rules about
-- transactions that are easier to avoid than to satisfy.
--
-- ── What it does NOT do ─────────────────────────────────────────────
--
-- No existing user's role changes. `staff` still means "sees every row in the
-- database", and every `staffGuard()` call site still checks for it. The new
-- roles are added here only because Postgres requires an enum value to be
-- committed before anything may reference it; the guards move in Phase 2, where
-- the change can be tested against something.

-- -------------------------------------------------------------------
-- 1 · The tenant
-- -------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE agency_status AS ENUM ('active', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS agencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL,
  status      agency_status NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agencies_slug_key ON agencies (slug);

-- The agency every pre-tenancy row is backfilled to. The id is fixed and
-- obviously synthetic so that a row carrying it reads as a migration artifact
-- rather than as a real tenant. `tenancy.test.ts` asserts this literal matches
-- `BOOTSTRAP_AGENCY_ID` in schema.ts — if they ever disagree, every existing
-- client points at an agency row that does not exist.
INSERT INTO agencies (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Growth Guild', 'growth-guild')
ON CONFLICT (id) DO NOTHING;

-- -------------------------------------------------------------------
-- 2 · clients.agency_id  (add nullable → backfill → tighten)
-- -------------------------------------------------------------------

ALTER TABLE clients ADD COLUMN IF NOT EXISTS agency_id uuid;

UPDATE clients
   SET agency_id = '00000000-0000-0000-0000-000000000001'
 WHERE agency_id IS NULL;

ALTER TABLE clients ALTER COLUMN agency_id SET NOT NULL;

-- `restrict`, not `cascade`: deleting an agency must not silently take its
-- clients, and with them the stage_transitions ledger — the one dataset in this
-- system that no API can rebuild.
DO $$ BEGIN
  ALTER TABLE clients
    ADD CONSTRAINT clients_agency_id_fk
    FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS clients_agency_idx ON clients (agency_id);

-- -------------------------------------------------------------------
-- 3 · users.agency_id
-- -------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS agency_id uuid;

UPDATE users
   SET agency_id = '00000000-0000-0000-0000-000000000001'
 WHERE agency_id IS NULL;

ALTER TABLE users ALTER COLUMN agency_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_agency_id_fk
    FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -------------------------------------------------------------------
-- 4 · The role enum
-- -------------------------------------------------------------------
--
-- `staff` is kept alongside the new values, not replaced. See the header.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'superadmin';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'agency';

-- -------------------------------------------------------------------
-- 5 · agency_settings: singleton → one row per agency
-- -------------------------------------------------------------------
--
-- The old primary key was `id text DEFAULT 'SINGLETON'`, which is the shape a
-- single-tenant tool takes and exactly the shape that cannot be shared.

ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS agency_id uuid;

UPDATE agency_settings
   SET agency_id = '00000000-0000-0000-0000-000000000001'
 WHERE agency_id IS NULL;

-- Guarded rather than assumed: if the table was empty, there is nothing to
-- re-key and the branding row is created on first read by `getAgencySettings`.
DO $$ BEGIN
  ALTER TABLE agency_settings DROP CONSTRAINT IF EXISTS agency_settings_pkey;
  ALTER TABLE agency_settings ALTER COLUMN agency_id SET NOT NULL;
  ALTER TABLE agency_settings ADD PRIMARY KEY (agency_id);
EXCEPTION WHEN invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agency_settings
    ADD CONSTRAINT agency_settings_agency_id_fk
    FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Branding is reproducible from a logo file, so `id` has nothing left to carry.
ALTER TABLE agency_settings DROP COLUMN IF EXISTS id;

-- -------------------------------------------------------------------
-- 6 · Un-squat the ad-account keys
-- -------------------------------------------------------------------
--
-- These were UNIQUE on the account id ALONE, across every tenant. Two
-- consequences, both live today:
--
--   · a squat — the first agency to type an id owns it forever, and the
--     legitimate owner has no route to their own account that does not go
--     through us;
--   · a disclosure oracle — "already attached to a different client" confirms,
--     to anyone who can type an id, that some other tenant holds that account.
--
-- `tiktok_ad_accounts` was already keyed (client_id, advertiser_id) and is the
-- model. Double-counting within one agency is still prevented, by an
-- agency-scoped check in the accounts modules that can answer helpfully without
-- answering across a tenant boundary.

DROP INDEX IF EXISTS meta_ad_accounts_account_key;
CREATE UNIQUE INDEX IF NOT EXISTS meta_ad_accounts_account_key
  ON meta_ad_accounts (client_id, ad_account_id);

DROP INDEX IF EXISTS google_ad_accounts_customer_key;
CREATE UNIQUE INDEX IF NOT EXISTS google_ad_accounts_customer_key
  ON google_ad_accounts (client_id, customer_id);

-- ghl_installations.location_id stays globally unique on purpose. It is the
-- routing key for inbound webhooks — the payload carries a location id and
-- nothing else — so scoping it requires first deciding what happens when two
-- agencies claim the same sub-account and an event arrives. That travels with
-- `claimInstallation`, which today accepts any (installationId, clientId) pair
-- with no authorization at all, so scoping the index alone would move the leak
-- rather than close it. Both land together in Phase 2.

-- -------------------------------------------------------------------
-- 7 · Email verification
-- -------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- Existing logins are stamped verified. They were created by hand, by someone
-- who already knew the person — a stronger proof than an email round-trip, and
-- re-demanding it would lock out every current user the moment self-serve
-- sign-up ships.
UPDATE users
   SET email_verified_at = now()
 WHERE email_verified_at IS NULL;

CREATE INDEX IF NOT EXISTS users_agency_idx ON users (agency_id);
