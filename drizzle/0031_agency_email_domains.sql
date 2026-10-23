-- The domain each agency sends its email from: Settings -> Email domain.
--
-- An agency adds its domain, puts the DNS records we show into its DNS, and
-- once Resend says the domain is verified, every email sent for that agency —
-- invites, password resets, scheduled and emailed reports — goes out from it.
-- Until then, and whenever no row exists, mail goes from our own address under
-- the agency's name.
--
-- One row per agency (the key is the agency), one agency per domain. `status`
-- is Resend's own string, plus `recheck`, which the app sets when a send from a
-- verified domain is refused. No secret is stored: DNS is the proof, and the
-- only credential is RESEND_AGENCY_API_KEY in the environment.
--
-- 🔴 Apply BEFORE deploying the code that adds domains. Sending degrades on its
-- own — a missing table reads as "no domain", so mail keeps going from our
-- address — but adding a domain fails until this runs.
--
-- Safe to re-run (IF NOT EXISTS). Adds a table only; touches no existing data.
-- To undo: DROP TABLE IF EXISTS "agency_email_domains";

CREATE TABLE IF NOT EXISTS "agency_email_domains" (
  "agency_id" uuid PRIMARY KEY NOT NULL REFERENCES "agencies"("id") ON DELETE CASCADE,
  "domain" text NOT NULL,
  "resend_domain_id" text NOT NULL,
  "status" text DEFAULT 'not_started' NOT NULL,
  "records" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "from_local" text DEFAULT 'reports' NOT NULL,
  "from_name" text,
  "reply_to" text,
  "last_error" text,
  "verified_at" timestamp with time zone,
  "checked_at" timestamp with time zone,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agency_email_domains_domain_key"
  ON "agency_email_domains" ("domain");
