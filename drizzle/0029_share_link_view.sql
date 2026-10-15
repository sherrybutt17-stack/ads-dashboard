-- Share links remember which sections and headline numbers they show.
--
-- One nullable column, no default, no backfill. NULL means "the standard
-- report", which is exactly what every existing link shows today, so nothing
-- already sent changes. New links store the sender's choice as
-- {"sections": [...], "kpis": [...]}; the app validates it on every read.
--
-- 🔴 Apply BEFORE deploying the code that reads it. Drizzle selects every column
-- the schema declares, so code that knows about `view` run against a table
-- without it fails every share-link read.
--
-- Safe to re-run (IF NOT EXISTS). To undo: ALTER TABLE "share_links" DROP COLUMN "view";
-- (only after rolling the code back, for the same reason as above).

ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "view" jsonb;
