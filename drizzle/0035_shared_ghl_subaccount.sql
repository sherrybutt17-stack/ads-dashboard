-- One GoHighLevel sub-account feeding several clients ("Share this sub-account").
--
-- Some sub-accounts hold more than one business's leads: Aloha LASER Vision's
-- also holds Aloha Laser Aesthetic's. A Growth Guild superadmin can now let the
-- client that holds the app connection (the HOLDER) share its sub-account with
-- up to four other clients of the same agency (MEMBERS). The users pick the GHL
-- tag that marks each client's leads, and each person counts on ONE dashboard.
--
-- Every member keeps a full copy of the sub-account's leads, written by a
-- database mirror from the holder's rows, so every screen still reads by
-- client_id. Two flags decide what counts:
--
--   clients.ghl_share_installation_id  the share (= ghl_installations row) this client is in; NULL = not sharing
--   clients.ghl_share_tags             normalised GHL tags that mark this client's leads
--   clients.ghl_share_gets_untagged    takes leads with no client's tag (at most one per share; none = No one)
--   clients.ghl_share_since            when this client joined the share
--   clients.ghl_share_keep_removed     HOLDER row: a lead stays with its client after its tag is removed
--   clients.ghl_share_version          HOLDER row: bumped by every rules, membership or archive change (409 check)
--   clients.ghl_share_split_version    HOLDER row: the version the last completed full split ran on
--   contacts/opportunities.share_installation_id, share_counted
--                                      NULL = not shared, counts as today; false = not this client's (or not
--                                      split yet); true = this client's
--   contacts.share_reason              tag | first_tag | both_tags | kept | no_tag | unread (validated in code)
--
-- Clients that don't share keep NULL everywhere, so their numbers are identical:
-- every reader treats NULL as counted (src/lib/metrics/ledger.ts).
--
-- 🔴 Apply BEFORE deploying the code that reads it. The new code reads these
-- columns in every funnel query, so without this migration no dashboard loads.
--
-- Safe to re-run (IF NOT EXISTS throughout). Changes no existing row.
--
-- To undo, in THIS order — the previous code ignores share_counted, so copies
-- left behind would make every former member count the whole sub-account:
--   1. While this code is still live, stop every share (scripts/unshare-all.ts):
--      members' copies are deleted and holders go back to NULL.
--   2. Deploy the previous code.
--   3. Drop what this file added:
--        DROP INDEX IF EXISTS "clients_ghl_share_idx", "clients_ghl_share_one_untagged_key",
--          "contacts_share_idx", "contacts_share_one_counted_key", "opportunities_share_one_counted_key",
--          "opportunities_share_excluded_idx", "opportunities_share_contact_idx";
--        ALTER TABLE "opportunities" DROP COLUMN IF EXISTS "share_installation_id", DROP COLUMN IF EXISTS "share_counted";
--        ALTER TABLE "contacts" DROP COLUMN IF EXISTS "share_installation_id", DROP COLUMN IF EXISTS "share_counted",
--          DROP COLUMN IF EXISTS "share_reason";
--        ALTER TABLE "clients" DROP COLUMN IF EXISTS "ghl_share_installation_id", DROP COLUMN IF EXISTS "ghl_share_tags",
--          DROP COLUMN IF EXISTS "ghl_share_gets_untagged", DROP COLUMN IF EXISTS "ghl_share_since",
--          DROP COLUMN IF EXISTS "ghl_share_keep_removed", DROP COLUMN IF EXISTS "ghl_share_version",
--          DROP COLUMN IF EXISTS "ghl_share_split_version";

-- 🔴 Give way rather than wait, as in 0034: a live stage-change webhook locks an
-- opportunity and then reads its client, while these ALTERs lock clients,
-- contacts and opportunities. This gives up first instead of risking a deadlock
-- that could abort the webhook; nothing is applied, and running again is safe.
SET lock_timeout = '500ms';

ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "ghl_share_installation_id" uuid REFERENCES "ghl_installations"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "ghl_share_tags" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "ghl_share_gets_untagged" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ghl_share_since" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "ghl_share_keep_removed" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "ghl_share_version" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ghl_share_split_version" integer NOT NULL DEFAULT 0;

ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "share_installation_id" uuid,
  ADD COLUMN IF NOT EXISTS "share_counted" boolean,
  ADD COLUMN IF NOT EXISTS "share_reason" text;

ALTER TABLE "opportunities"
  ADD COLUMN IF NOT EXISTS "share_installation_id" uuid,
  ADD COLUMN IF NOT EXISTS "share_counted" boolean;

CREATE INDEX IF NOT EXISTS "clients_ghl_share_idx"
  ON "clients" ("ghl_share_installation_id") WHERE "ghl_share_installation_id" IS NOT NULL;

-- At most one client per share takes the leads that carry no client's tag.
CREATE UNIQUE INDEX IF NOT EXISTS "clients_ghl_share_one_untagged_key"
  ON "clients" ("ghl_share_installation_id") WHERE "ghl_share_gets_untagged";

CREATE INDEX IF NOT EXISTS "contacts_share_idx"
  ON "contacts" ("share_installation_id", "ghl_contact_id") WHERE "share_installation_id" IS NOT NULL;

-- 🔴 The guarantee: one person counts on at most one dashboard of a share, and
-- so does each card (stand-ins 'tag:<contact>' included). The database refuses
-- a second counted copy, whatever the code does.
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_share_one_counted_key"
  ON "contacts" ("share_installation_id", "ghl_contact_id") WHERE "share_counted";

CREATE UNIQUE INDEX IF NOT EXISTS "opportunities_share_one_counted_key"
  ON "opportunities" ("share_installation_id", "ghl_opportunity_id") WHERE "share_counted";

-- Serves FUNNEL_TRANSITIONS' anti-join. Empty for clients that don't share.
CREATE INDEX IF NOT EXISTS "opportunities_share_excluded_idx"
  ON "opportunities" ("id") WHERE "share_counted" = false;

CREATE INDEX IF NOT EXISTS "opportunities_share_contact_idx"
  ON "opportunities" ("share_installation_id", "ghl_contact_id") WHERE "share_installation_id" IS NOT NULL;
