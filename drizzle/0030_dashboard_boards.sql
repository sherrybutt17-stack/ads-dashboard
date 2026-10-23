-- One widget board per client: the Board tab's saved layout.
--
-- A board is a list of widgets (which stat, which chart, where on a 12-column
-- grid), stored as jsonb and validated by the app on every read and write.
-- One row per client: the agency and the client edit the same board, and the
-- agency can lock it so the client cannot.
--
-- Until a board is first saved there is NO row: the app computes a starter
-- layout for each client on the fly, so a stored copy of the defaults never
-- stops tracking them.
--
-- `name` exists only so that more than one board per client later is a new
-- unique index, not a data migration. Nothing reads it yet.
--
-- 🔴 Apply BEFORE deploying the code that writes boards. Reads degrade on their
-- own — a missing table falls back to the starter layout — but every save fails
-- with "the migration for it has not been applied yet" until this runs.
--
-- Safe to re-run (IF NOT EXISTS). Adds a table only; touches no existing data.
-- To undo: DROP TABLE IF EXISTS "dashboard_boards";

CREATE TABLE IF NOT EXISTS "dashboard_boards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "name" text DEFAULT 'Board' NOT NULL,
  "widgets" jsonb NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "locked" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text
);

CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_boards_client_key"
  ON "dashboard_boards" ("client_id");
