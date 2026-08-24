-- What the client agreed to spend per month, per platform.
--
-- `effective_from` is a `yyyy-MM` month key meaning "from this month onward,
-- until superseded" — see the note on `adBudgets` in src/db/schema.ts for why a
-- standing agreement is the right shape and a single mutable column on
-- `clients` is not (it would silently restate every past month's target).
--
-- `monthly_amount` is nullable ON PURPOSE. NULL is an explicit "no budget from
-- this month", which is how a client who stops committing to a figure is
-- recorded without deleting the history of what they used to commit to. It is
-- not the same as having no row at all, which means nothing was ever agreed.
--
-- Idempotent, like the rest of the queue. Adds no NOT NULL column to a
-- populated table, so `db:push` handles it too — this file exists for anyone
-- applying migrations in sequence.
CREATE TABLE IF NOT EXISTS "ad_budgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL,
  "platform" text DEFAULT 'meta' NOT NULL,
  "effective_from" text NOT NULL,
  "monthly_amount" numeric(14, 2),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text
);

DO $$ BEGIN
  ALTER TABLE "ad_budgets"
    ADD CONSTRAINT "ad_budgets_client_id_clients_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One agreement per client, per platform, per effective month. The upsert in
-- `src/lib/budgets.ts` targets this index, so editing a budget already on file
-- corrects it rather than stacking a second row that shadows the first.
CREATE UNIQUE INDEX IF NOT EXISTS "ad_budgets_effective_key"
  ON "ad_budgets" ("client_id", "platform", "effective_from");
