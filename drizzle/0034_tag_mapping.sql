-- Count a client's leads from GoHighLevel TAGS instead of pipeline stages.
--
-- Most of Reflexion Digital's leads never get a pipeline card, so the
-- dashboard, which counts a lead only when a card enters a New-lead stage,
-- showed IQ Laser Vision 19 leads out of 977 new contacts in 30 days. A client
-- switched to tags counts every tagged contact instead, and maps tags such as
-- "booked" or "location denied" onto funnel steps.
--
--   clients.crm_mapping_mode        'pipeline' (default, unchanged behaviour) | 'tags'
--   clients.tag_lead_every_contact  tags mode: every new contact counts as a lead
--   clients.tag_mapping_allowed     offer the switch for this one client (testing)
--   agencies.tag_mapping_enabled    offer the switch for every client of the agency
--   tag_stage_mappings              which tag means which funnel step, per client
--   contact_tag_history             when each tag was first seen on each contact
--   opportunities.from_tags         the one stand-in "opportunity" per tagged lead
--   transition_source 'tag'         the funnel rows built from tags
--
-- The tag rows live in the same two tables as pipeline rows so every number on
-- every screen follows from one place. Readers pick pipeline rows or tag rows
-- by the client's mode, so a pipeline client sees nothing new, and switching a
-- client back to pipeline restores its old numbers exactly: no pipeline row is
-- touched.
--
-- 🔴 Apply BEFORE deploying the code that reads it. The new code reads
-- clients.crm_mapping_mode in every funnel query, so without this migration the
-- dashboard cannot load.
--
-- Safe to re-run (IF NOT EXISTS throughout). Changes no existing row except the
-- two UPDATEs at the bottom, which only switch the OPTION on (the mode stays
-- 'pipeline' until someone saves "Map by tag" for a client).
--
-- Not wrapped in a transaction: ALTER TYPE ... ADD VALUE has its own rules
-- about transactions, and a half-applied file can simply be run again.
--
-- To undo, in THIS order — the previous code reads the ledger with no mode
-- filter, so tag rows still present when it is deployed count every tag lead
-- a second time:
--   1. While this code is still live, remove the tag rows:
--        UPDATE "clients" SET "crm_mapping_mode" = 'pipeline' WHERE "crm_mapping_mode"::text = 'tags';
--        DELETE FROM "stage_transitions" WHERE "source"::text = 'tag';
--        DELETE FROM "opportunities" WHERE "from_tags";
--   2. Deploy the previous code.
--   3. Drop what this file added:
--        DROP TABLE IF EXISTS "contact_tag_history", "tag_stage_mappings";
--        ALTER TABLE "opportunities" DROP COLUMN IF EXISTS "from_tags";
--        ALTER TABLE "clients" DROP COLUMN IF EXISTS "crm_mapping_mode",
--          DROP COLUMN IF EXISTS "tag_lead_every_contact", DROP COLUMN IF EXISTS "tag_mapping_allowed";
--        ALTER TABLE "agencies" DROP COLUMN IF EXISTS "tag_mapping_enabled";
--        DROP TYPE IF EXISTS "crm_mapping_mode";
--      (an enum value cannot be dropped; an unused 'tag' is harmless)

-- 🔴 Give way rather than wait. The ALTERs take exclusive locks on agencies,
-- clients and opportunities in that order, while a live stage-change webhook
-- locks an opportunity and then checks its client. Left to wait, the two can
-- deadlock and Postgres may abort the WEBHOOK, losing that stage move. Under
-- the 1s deadlock check, this gives up first instead: nothing is applied, and
-- running the file again is safe.
SET lock_timeout = '500ms';

ALTER TYPE "public"."transition_source" ADD VALUE IF NOT EXISTS 'tag';

DO $$ BEGIN
  CREATE TYPE "public"."crm_mapping_mode" AS ENUM ('pipeline', 'tags');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "agencies"
  ADD COLUMN IF NOT EXISTS "tag_mapping_enabled" boolean NOT NULL DEFAULT false;

ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "crm_mapping_mode" "crm_mapping_mode" NOT NULL DEFAULT 'pipeline',
  ADD COLUMN IF NOT EXISTS "tag_lead_every_contact" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "tag_mapping_allowed" boolean NOT NULL DEFAULT false;

ALTER TABLE "opportunities"
  ADD COLUMN IF NOT EXISTS "from_tags" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "tag_stage_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "tag" text NOT NULL,
  "canonical_stage" "canonical_stage" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tag_stage_mappings_client_tag_key" UNIQUE ("client_id", "tag")
);

CREATE TABLE IF NOT EXISTS "contact_tag_history" (
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "tag" text NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "exact" boolean DEFAULT false NOT NULL,
  CONSTRAINT "contact_tag_history_pkey" PRIMARY KEY ("contact_id", "tag")
);

CREATE INDEX IF NOT EXISTS "contact_tag_history_client_tag_idx"
  ON "contact_tag_history" ("client_id", "tag");

CREATE INDEX IF NOT EXISTS "opportunities_client_from_tags_idx"
  ON "opportunities" ("client_id") WHERE "from_tags";

-- Offer the option to Reflexion Digital's clients, and to the two "abdul" test
-- clients so it can be tried first. Nothing changes for them until "Map by
-- tag" is saved for a client.
UPDATE "agencies" SET "tag_mapping_enabled" = true
 WHERE lower(trim("name")) = 'reflexion digital' AND NOT "tag_mapping_enabled";

UPDATE "clients" SET "tag_mapping_allowed" = true
 WHERE "slug" IN ('abdul', 'abdul-rehman') AND NOT "tag_mapping_allowed";
