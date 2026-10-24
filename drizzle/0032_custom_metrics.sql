-- An agency's own metrics: Settings -> Metrics.
--
-- Two kinds, both usable on every board of the agency's clients:
--   rename  - one platform's built-in stat under the agency's own name and
--             description (base_metric names it);
--   formula - built-in stats combined with + - x / and numbers, stored as
--             tokens in `expression` (never as text to evaluate), with its own
--             display format and good/bad direction.
--
-- Board widgets name these as `custom:<id>`. An archived metric leaves the
-- picker but keeps working where it is already used; only an unused metric is
-- deleted. Deleting an agency deletes its metrics.
--
-- 🔴 Apply BEFORE deploying the code that reads it. A missing table only means
-- "no custom metrics" for boards, but Settings -> Metrics cannot save until
-- this runs.
--
-- Safe to re-run (IF NOT EXISTS). Adds a table only; touches no existing data.
-- To undo: DROP TABLE IF EXISTS "custom_metrics";

CREATE TABLE IF NOT EXISTS "custom_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agency_id" uuid NOT NULL REFERENCES "agencies"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "platform" text NOT NULL,
  "base_metric" text,
  "expression" jsonb,
  "label" text NOT NULL,
  "description" text,
  "format" text,
  "polarity" text,
  "archived_at" timestamp with time zone,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "custom_metrics_agency_idx" ON "custom_metrics" ("agency_id");
