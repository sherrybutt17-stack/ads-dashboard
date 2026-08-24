-- ===================================================================
-- Track B — an audit trail an agency can actually read
-- ===================================================================
--
-- `audit_log` was written when there was one tenant, so it records WHAT
-- happened and to WHICH client, and never needed to say whose. Post-0023 that
-- is the reason `/audit` is superadmin-only: there is no predicate that shows
-- an agency its own entries without showing it everyone's, and an audit trail
-- that leaks across tenants is worse than one nobody can read.
--
-- This adds the column, fills what can be filled, and indexes the read.
--
-- ── Why nullable, permanently ───────────────────────────────────────
--
-- Not every event has a tenant, and the ones that don't are the interesting
-- ones: a failed login for an address that matches no account, a sign-up
-- rate-limit that fires before any agency exists, a cron run that belongs to
-- the platform. NULL is a real value here meaning "no tenant" — those rows stay
-- superadmin-only, which is correct, and a NOT NULL column would have forced
-- each of them to be attributed to somebody.
--
-- ── Safe to run more than once ──────────────────────────────────────
--
-- Guarded throughout, and no explicit transaction, for the same reasons set out
-- at the top of `0023_tenancy.sql`. Run 0023 first: this script reads
-- `clients.agency_id`, which 0023 creates.

-- -------------------------------------------------------------------
-- 1 · The column
-- -------------------------------------------------------------------

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS agency_id uuid;

DO $$ BEGIN
  ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_agency_id_fk
    FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ON DELETE SET NULL, deliberately, where the rest of the schema cascades.
-- Deleting a tenant must not delete the record of what was done to it — an
-- audit trail that disappears with its subject is not evidence of anything. The
-- rows survive, unattributed, visible to superadmins.

-- -------------------------------------------------------------------
-- 2 · Backfill what is knowable
-- -------------------------------------------------------------------

-- Every entry that names a client inherits that client's agency. This is the
-- overwhelming majority of them: account attaches, syncs, stage remaps,
-- branding, reports.
UPDATE audit_log a
   SET agency_id = c.agency_id
  FROM clients c
 WHERE c.id = a.client_id
   AND a.agency_id IS NULL;

-- Entries with no client stay NULL. Historical auth events are the notable
-- case: `audit_log` has never stored a user id, so "who logged in" is not
-- recoverable from the row, and guessing a tenant from the email in `metadata`
-- would attribute a failed login to whichever agency happens to own that
-- address today. New auth events carry their agency from the session — see
-- `lib/audit.ts`. Old ones remain platform-level, which is honest.

-- -------------------------------------------------------------------
-- 3 · The read path
-- -------------------------------------------------------------------

-- The scoped listing is "this agency, newest first, limit N", so the index
-- carries the sort. Without `at DESC` in the index Postgres filters by tenant
-- and then sorts the whole matching set on every page load.
CREATE INDEX IF NOT EXISTS audit_log_agency_at_idx
  ON audit_log (agency_id, at DESC);
