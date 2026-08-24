import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";

/**
 * A real Postgres, in-process, for testing the SQL that pure functions cannot
 * reach.
 *
 * The query layer is where this project's hardest correctness rules live —
 * "one creative running in twelve ad sets is ONE row", "a deal must not be
 * multiplied by the number of ads carrying its creative", "campaign-level rows
 * must never contaminate a creative aggregate". None of those are visible to a
 * typechecker and none can be unit-tested, because they are properties of GROUP
 * BY and JOIN cardinality.
 *
 * PGlite is Postgres compiled to WASM, so `PERCENTILE_CONT`, `FILTER`, CTEs,
 * `FULL OUTER JOIN` and array aggregates all behave exactly as they do in
 * production, with no server, no container, and — critically — no connection to
 * anything real.
 *
 * The alternative that was tried first, creating scratch tables on the live
 * database, is why this file exists: temp tables on Neon's POOLED endpoint
 * outlive the session that made them, get handed to the next client, and shadow
 * the real tables. That took production reads down intermittently. Tests never
 * touch a network database again.
 */
export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Only the tables the metrics queries read, in the shape `schema.ts` declares.
 *
 * Hand-written rather than replayed from `drizzle/*.sql` on purpose: the
 * migration files are a historical chain including ALTERs against enums that
 * don't exist yet in a fresh database, and running them in order is slower and
 * more fragile than declaring the end state. Anything that drifts from
 * `schema.ts` shows up as a failing test, which is the point.
 */
/*
 * 🔴 NO BACKTICKS AND NO ${...} BELOW THIS LINE.
 *
 * It is one template literal, so a backtick quoting an identifier ends the
 * string and a dollar-brace becomes an interpolation. Both fail as a PARSE
 * error in an unrelated test file, which reads as anything but "you quoted a
 * function name in a SQL comment". Write identifiers bare.
 */
const DDL = `
CREATE TYPE canonical_stage AS ENUM (
  'new_lead','contacted','appointment_booked','showed','no_show','closed_won','lost',
  'disqualified'
);
CREATE TYPE insight_level  AS ENUM ('account','campaign','adset','ad');
CREATE TYPE creative_type  AS ENUM ('image','video','carousel','unknown');
CREATE TYPE delivery_ranking AS ENUM (
  'above_average','average','below_average_35','below_average_20','below_average_10','unknown'
);
CREATE TYPE breakdown_key AS ENUM ('age','gender','region','placement','device');

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  status text NOT NULL DEFAULT 'active',
  agency_id uuid,
  webhook_token text,
  ghl_location_id text,
  ghl_location_name text,
  ghl_token_encrypted text,
  ghl_auth_method text NOT NULL DEFAULT 'pit',
  meta_currency text,
  meta_timezone text,
  paid_lead_filter text NOT NULL DEFAULT 'all',
  paid_lead_tag text NOT NULL DEFAULT 'facebook-lead',
  last_synced_at timestamptz,
  last_meta_reconciled_at timestamptz,
  last_google_reconciled_at timestamptz,
  last_tiktok_reconciled_at timestamptz,
  last_pacing_alert_at timestamptz,
  last_pacing_alert_status text,
  alert_webhook_encrypted text,
  alerts_enabled boolean NOT NULL DEFAULT false,
  first_webhook_at timestamptz,
  last_webhook_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clients_slug_key UNIQUE (slug),
  CONSTRAINT clients_webhook_token_key UNIQUE (webhook_token)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'client',
  name text,
  status text NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)
);

/*
 * 🔴 The cascades are declared, unlike most client_id columns in this file.
 *
 * Elsewhere the tenant key is a bare uuid because the read queries under test
 * never delete anything, so a foreign key would only add setup cost. Here the
 * cascade IS the behaviour: orphaned grants would attach to whatever uuid the
 * database reissued, and removeClient relies on the delete propagating.
 * Omitting them made this harness LESS strict than production -- which a
 * column-level drift check cannot see, since constraints are not columns.
 */
CREATE TABLE user_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT user_clients_key UNIQUE (user_id, client_id)
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  ghl_contact_id text NOT NULL,
  first_name text, last_name text, email text, phone text, source text,
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text,
  meta_campaign_id text, meta_adset_id text, meta_ad_id text,
  tiktok_campaign_id text,
  fbclid text, gclid text, ttclid text,
  google_campaign_id text, facebook_lead_id text,
  tags text[],
  raw_attribution jsonb,
  attribution_fetched_at timestamptz,
  ghl_created_at timestamptz,
  first_call_at timestamptz,
  first_touch_at timestamptz,
  alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_client_ghl_key UNIQUE (client_id, ghl_contact_id)
);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid,
  webhook_token text,
  event_type text,
  received_at timestamptz NOT NULL DEFAULT now(),
  headers jsonb,
  payload jsonb,
  status text,
  error text,
  processed_at timestamptz
);

CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  ghl_opportunity_id text NOT NULL,
  contact_id uuid REFERENCES contacts(id),
  ghl_contact_id text,
  ghl_pipeline_id text,
  name text,
  current_stage_id uuid,
  current_stage_ghl_id text,
  status text,
  monetary_value numeric(14,2),
  ghl_created_at timestamptz,
  last_stage_change_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunities_client_ghl_key UNIQUE (client_id, ghl_opportunity_id)
);

CREATE TABLE pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  ghl_pipeline_id text NOT NULL,
  ghl_stage_id text NOT NULL,
  ghl_stage_name text,
  ghl_pipeline_name text,
  canonical_stage canonical_stage,
  display_order integer NOT NULL DEFAULT 0,
  discovered_from_webhook boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stages_client_stage_key UNIQUE (client_id, ghl_stage_id)
);
CREATE TABLE stage_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  contact_id uuid REFERENCES contacts(id),
  from_stage_id uuid REFERENCES pipeline_stages(id),
  to_stage_id uuid REFERENCES pipeline_stages(id),
  from_stage_ghl_id text,
  /*
   * 🔴 DEFAULTED, where production is a bare NOT NULL.
   *
   * Every write in the app supplies both -- ghl/process.ts and ghl/backfill.ts
   * are the only two, and each builds the dedupe key out of the opportunity id,
   * the incoming GHL stage id and the change time. The read-query tests predate
   * these columns and insert neither, so the defaults are what let one harness
   * serve both without seven files of churn over values they never assert on.
   *
   * What the defaults preserve is the part that matters: the UNIQUE index is
   * real, so a test supplying a colliding key collides, and gen_random_uuid
   * keeps rows that supply nothing from colliding with each other. What is lost
   * is only "an insert that FORGETS the key fails" -- which no production call
   * site can do, since both name it explicitly.
   */
  to_stage_ghl_id text NOT NULL DEFAULT '',
  dedupe_key text NOT NULL DEFAULT gen_random_uuid()::text,
  webhook_event_id uuid,
  from_canonical canonical_stage,
  to_canonical canonical_stage,
  changed_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'webhook',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_transitions_dedupe_key UNIQUE (dedupe_key)
);


CREATE TABLE fb_daily_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  meta_ad_account_id text NOT NULL DEFAULT '',
  date date NOT NULL,
  level insight_level NOT NULL DEFAULT 'campaign',
  meta_campaign_id text NOT NULL DEFAULT '',
  campaign_name text,
  meta_adset_id text NOT NULL DEFAULT '',
  adset_name text,
  meta_ad_id text NOT NULL DEFAULT '',
  ad_name text,
  creative_key text NOT NULL DEFAULT '',
  creative_type creative_type NOT NULL DEFAULT 'unknown',
  reach integer NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  clicks_all integer NOT NULL DEFAULT 0,
  link_clicks integer NOT NULL DEFAULT 0,
  inline_link_clicks integer NOT NULL DEFAULT 0,
  spend numeric(14,4) NOT NULL DEFAULT '0',
  leads_total integer NOT NULL DEFAULT 0,
  leads_pixel integer NOT NULL DEFAULT 0,
  leads_onsite integer NOT NULL DEFAULT 0,
  video_3s_views integer NOT NULL DEFAULT 0,
  video_plays integer NOT NULL DEFAULT 0,
  thru_plays integer NOT NULL DEFAULT 0,
  video_p25 integer NOT NULL DEFAULT 0,
  video_p50 integer NOT NULL DEFAULT 0,
  video_p75 integer NOT NULL DEFAULT 0,
  video_p95 integer NOT NULL DEFAULT 0,
  video_p100 integer NOT NULL DEFAULT 0,
  landing_page_views integer NOT NULL DEFAULT 0,
  outbound_clicks integer NOT NULL DEFAULT 0,
  quality_ranking delivery_ranking,
  engagement_rate_ranking delivery_ranking,
  conversion_rate_ranking delivery_ranking,
  currency text,
  is_provisional boolean NOT NULL DEFAULT true,
  synced_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb,
  -- The ON CONFLICT target of the daily upsert in meta/sync.ts. Without a
  -- matching constraint Postgres rejects the statement outright, so the sync
  -- cannot be exercised here at all.
  CONSTRAINT fb_daily_metrics_key UNIQUE (
    client_id, meta_ad_account_id, date, level,
    meta_campaign_id, meta_adset_id, meta_ad_id
  )
);

CREATE TABLE client_branding (
  client_id uuid PRIMARY KEY,
  display_name text,
  brand_color text,
  report_contact_line text,
  logo_wordmark bytea,
  logo_wordmark_type text,
  logo_square bytea,
  logo_square_type text,
  logo_version integer NOT NULL DEFAULT 0,
  brand_color_applies_to_dashboard boolean NOT NULL DEFAULT true,
  client_editable boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TYPE layout_audience AS ENUM ('staff','client');

CREATE TABLE dashboard_layouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  audience layout_audience NOT NULL,
  sections jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  locked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT dashboard_layouts_client_audience_key UNIQUE (client_id, audience)
);

CREATE TABLE share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  token_hash text NOT NULL,
  label text,
  range_start date NOT NULL,
  range_end date NOT NULL,
  platform text NOT NULL DEFAULT 'meta',
  password_hash text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  CONSTRAINT share_links_token_hash_key UNIQUE (token_hash)
);

CREATE TABLE fb_period_reach (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  meta_ad_account_id text NOT NULL DEFAULT '',
  period_start date NOT NULL,
  period_end date NOT NULL,
  meta_campaign_id text NOT NULL DEFAULT '',
  reach integer NOT NULL DEFAULT 0,
  frequency numeric(10,4),
  synced_at timestamptz NOT NULL DEFAULT now(),
  -- Reach is NOT additive, so it is cached per period rather than derived from
  -- the daily rows. Its own key, matching the upsert.
  CONSTRAINT fb_period_reach_key UNIQUE (
    client_id, meta_ad_account_id, period_start, period_end, meta_campaign_id
  )
);

CREATE TABLE fb_breakdown_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  meta_ad_account_id text NOT NULL DEFAULT '',
  date_start date NOT NULL,
  date_end date NOT NULL,
  level insight_level NOT NULL DEFAULT 'account',
  meta_campaign_id text NOT NULL DEFAULT '',
  breakdown_key breakdown_key NOT NULL,
  segment_value text NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks_all integer NOT NULL DEFAULT 0,
  link_clicks integer NOT NULL DEFAULT 0,
  spend numeric(14,4) NOT NULL DEFAULT '0',
  leads_total integer NOT NULL DEFAULT 0,
  reach integer NOT NULL DEFAULT 0,
  is_provisional boolean NOT NULL DEFAULT true,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fb_breakdown_metrics_key UNIQUE (client_id, meta_ad_account_id, date_start, date_end, level, meta_campaign_id, breakdown_key, segment_value)
);

CREATE TABLE meta_ad_creatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  meta_ad_account_id text NOT NULL DEFAULT '',
  meta_ad_id text NOT NULL,
  ad_name text,
  meta_adset_id text,
  meta_campaign_id text,
  meta_creative_id text,
  creative_key text NOT NULL DEFAULT '',
  creative_type creative_type NOT NULL DEFAULT 'unknown',
  image_hash text, video_id text,
  video_length_seconds numeric(8,2),
  title text, body text, call_to_action_type text, link_url text,
  thumbnail_url text, status text, learning_stage text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meta_ad_creatives_key UNIQUE (client_id, meta_ad_id),
  raw jsonb
);

CREATE TYPE meta_account_status AS ENUM ('active','paused','removed');

CREATE TABLE google_daily_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  customer_id text NOT NULL DEFAULT '',
  date date NOT NULL,
  google_campaign_id text NOT NULL DEFAULT '',
  campaign_name text,
  impressions bigint NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  spend numeric(14,4) NOT NULL DEFAULT '0',
  conversions numeric(14,2) NOT NULL DEFAULT '0',
  currency text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb,
  CONSTRAINT google_daily_metrics_key UNIQUE (client_id, customer_id, date, google_campaign_id)
);

CREATE TABLE google_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  customer_id text NOT NULL,
  descriptive_name text,
  account_name text,
  currency text,
  timezone text,
  is_primary boolean NOT NULL DEFAULT false,
  is_manager boolean NOT NULL DEFAULT false,
  login_customer_id text,
  refresh_token_encrypted text,
  status meta_account_status NOT NULL DEFAULT 'active',
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Scoped to the client, matching addGoogleAccount's ON CONFLICT target.
  CONSTRAINT google_ad_accounts_customer_key UNIQUE (client_id, customer_id)
);

/*
 * No level column, deliberately — the real table has none either. TikTok's
 * reporting is pulled at campaign level only, so there is no ad-level row to
 * exclude the way fb_daily_metrics needs to.
 *
 * is_primary is likewise absent from tiktok_ad_accounts: a TikTok connect never
 * overwrites the client's display currency or bucketing timezone, so nothing
 * here needs to be nominated as the one that defines them.
 */
CREATE TABLE tiktok_daily_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  advertiser_id text NOT NULL DEFAULT '',
  date date NOT NULL,
  tiktok_campaign_id text NOT NULL DEFAULT '',
  campaign_name text,
  impressions bigint NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  spend numeric(14,4) NOT NULL DEFAULT '0',
  conversions numeric(14,2) NOT NULL DEFAULT '0',
  currency text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb,
  CONSTRAINT tiktok_daily_metrics_key UNIQUE (client_id, advertiser_id, date, tiktok_campaign_id)
);

CREATE TABLE tiktok_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  advertiser_id text NOT NULL,
  advertiser_name text,
  access_token_encrypted text,
  currency text,
  timezone text,
  status text NOT NULL DEFAULT 'active',
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tiktok_ad_accounts_key UNIQUE (client_id, advertiser_id)
);

CREATE TYPE summary_framing AS ENUM ('summary','wins','issues','recommendations');

CREATE TABLE report_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'meta',
  range_start date NOT NULL,
  range_end date NOT NULL,
  framing summary_framing NOT NULL,
  headline text NOT NULL,
  body text NOT NULL,
  verification jsonb,
  generated_by text,
  model text,
  published_headline text,
  published_body text,
  published_at timestamptz,
  published_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT report_summaries_period_key
    UNIQUE (client_id, platform, range_start, range_end, framing)
);

CREATE TABLE monthly_commentary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'meta',
  month text NOT NULL,
  did text NOT NULL DEFAULT '',
  commitments jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_did text,
  published_commitments jsonb,
  published_outcomes jsonb,
  published_at timestamptz,
  published_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT monthly_commentary_month_key
    UNIQUE (client_id, platform, month)
);

CREATE TABLE meta_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  ad_account_id text NOT NULL,
  account_name text,
  currency text,
  timezone text,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  token_encrypted text,
  token_expires_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Scoped to the client, NOT the account id alone. addAdAccount names both
  -- columns as its ON CONFLICT target, and Postgres rejects a target with no
  -- matching constraint -- so without this the re-add path fails here exactly
  -- as it would in production.
  CONSTRAINT meta_ad_accounts_account_key UNIQUE (client_id, ad_account_id)
);

CREATE TABLE sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid,
  kind text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows_written integer,
  error text,
  meta jsonb
);

CREATE TABLE ad_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'meta',
  effective_from text NOT NULL,
  monthly_amount numeric(14,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT ad_budgets_effective_key
    UNIQUE (client_id, platform, effective_from)
);

CREATE TYPE agency_mark_mode AS ENUM ('full','prepared_by','none');

CREATE TABLE agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agencies_slug_key UNIQUE (slug)
);

CREATE TABLE agency_settings (
  agency_id uuid PRIMARY KEY,
  agency_name text,
  agency_mark_mode agency_mark_mode NOT NULL DEFAULT 'prepared_by',
  support_email text,
  logo_wordmark bytea,
  logo_wordmark_type text,
  logo_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'meta',
  enabled boolean NOT NULL DEFAULT false,
  cadence text NOT NULL DEFAULT 'monthly',
  send_hour integer NOT NULL DEFAULT 8,
  recipients text[] NOT NULL DEFAULT '{}',
  last_sent_period text,
  last_sent_at timestamptz,
  last_error text,
  link_ttl_days integer NOT NULL DEFAULT 30,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT report_schedules_client_platform_key UNIQUE (client_id, platform)
);

CREATE TABLE report_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'meta',
  period_key text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  recipients text[] NOT NULL DEFAULT '{}',
  share_link_id uuid,
  status text NOT NULL DEFAULT 'sending',
  provider_id text,
  error text,
  skipped_periods text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- 🔴 PARTIAL, exactly as schema.ts declares it. The predicate is the whole
-- retry story: a claim blocks a second send of the same period, but a FAILED
-- row stops blocking so the next run can try again. Modelled as a plain unique
-- index it would still satisfy a column-set drift check while behaving the
-- opposite way — one provider blip would lose that period forever.
CREATE UNIQUE INDEX report_sends_period_key
  ON report_sends (client_id, platform, period_key)
  WHERE status <> 'failed';

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  target_type text,
  target_id text,
  -- ON DELETE SET NULL, as in the schema: removing a client must not take the
  -- record of what was done to it.
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  -- Nullable, and the null case is load-bearing: it means platform-level with
  -- no tenant, which no agency may read.
  agency_id uuid,
  ip text,
  user_agent text,
  metadata jsonb
);

CREATE TABLE ghl_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL,
  company_id text,
  user_type text,
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  expires_at timestamptz NOT NULL,
  scopes text,
  location_name text,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at timestamptz,
  uninstalled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ghl_installations_location_key UNIQUE (location_id)
);
`;

/**
 * The schema, booted once per worker and then cloned.
 *
 * ── Why this is not just `PGlite.create()` ───────────────────────────────
 *
 * 37 test files call `createTestDb`, each in a `beforeAll`. A cold PGlite boot
 * measures ~1600ms because it runs `initdb`; restoring a pre-built data
 * directory measures ~270ms because it does not. Multiplied across the suite
 * that is the difference between the PGlite files dominating the run and barely
 * registering — and, more to the point, between a suite that intermittently
 * fails and one that does not.
 *
 * It had already been papered over twice: the hook timeout went 5s → 10s → 60s,
 * and the comment in `vitest.config.ts` still says "four test files boot
 * PGlite" from when that was true. Under CPU contention 60s was reached again,
 * so the third bump would have been the wrong move.
 *
 * The snapshot is cached on disk, keyed by a hash of the DDL, so the cold boot
 * is paid once for the whole machine rather than once per worker or once per
 * file — and not at all on a repeat run. It is also held in module state, so a
 * worker reads the file once.
 *
 * 🔴 Every caller still gets its OWN database, restored from the snapshot — not
 * a shared handle. Files `ALTER` and `DROP` tables to test degradation paths,
 * and sharing one instance would make those bleed across files. Verified: two
 * instances loaded from one snapshot do not see each other's writes.
 */
let schemaSnapshot: Promise<Blob> | null = null;

/**
 * Where the built snapshot is parked between runs.
 *
 * Keyed by a hash of the DDL, so editing the schema above simply produces a
 * different filename rather than serving a stale database — there is no
 * invalidation step to forget. Stale files from an older DDL are harmless
 * (~4.5MB each) and get cleaned with `node_modules`.
 */
function snapshotPath(): string {
  const hash = createHash("sha256").update(DDL).digest("hex").slice(0, 16);
  return join(
    process.cwd(),
    "node_modules",
    ".cache",
    "pglite-harness",
    `schema-${hash}.tar`,
  );
}

async function buildSnapshot(): Promise<ArrayBuffer> {
  const seed = await PGlite.create();
  await seed.exec(DDL);
  const dump = await seed.dumpDataDir();
  await seed.close();
  return dump.arrayBuffer();
}

function loadSchemaSnapshot(): Promise<Blob> {
  schemaSnapshot ??= (async () => {
    const file = snapshotPath();

    try {
      const cached = readFileSync(file);
      return new Blob([cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength) as ArrayBuffer]);
    } catch {
      // Not built yet (or unreadable) — fall through and build it.
    }

    const bytes = await buildSnapshot();

    /*
     * Written to a worker-unique temp name and RENAMED into place, which is
     * atomic on POSIX. Workers start together and will race to build this;
     * writing directly would let one read a half-written file and fail with a
     * corrupt-database error that looks like anything but a caching problem.
     *
     * A failure to cache is not a failure to test — if the directory is
     * read-only or the disk is full, the snapshot still works in memory for
     * this worker and the only cost is the next one rebuilding it.
     */
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, new Uint8Array(bytes));
      renameSync(tmp, file);
    } catch {
      // Cache is an optimisation, never a requirement.
    }

    return new Blob([bytes]);
  })();
  return schemaSnapshot;
}

export async function createTestDb(): Promise<{ db: TestDb; close: () => Promise<void> }> {
  const client = await PGlite.create({ loadDataDir: await loadSchemaSnapshot() });
  /*
   * 🔴 Pinned to UTC, matching how Neon hands out sessions.
   *
   * Without this, `now()::date` and any bare `::date` cast follow the machine's
   * timezone — so a test asserting that a query respects the CLIENT's timezone
   * passes on a laptop set to that timezone and proves nothing. Worse, it also
   * passes for a query that ignores timezones entirely. Found by a mutation
   * that stripped `AT TIME ZONE` from the date arithmetic and survived.
   *
   * Applied per instance, NOT baked into the snapshot: `SET` is session state,
   * and a restored data directory inherits the machine's timezone. Measured —
   * a freshly loaded instance reports `Etc/GMT-5` on this machine without it.
   */
  await client.exec("SET timezone = 'UTC';");
  const db = drizzle(client, { schema });
  return { db, close: () => client.close() };
}

export const CLIENT_A = "11111111-1111-1111-1111-111111111111";
export const CLIENT_B = "22222222-2222-2222-2222-222222222222";
export const CLIENT_C = "33333333-3333-3333-3333-333333333333";
export const CLIENT_D = "44444444-4444-4444-4444-444444444444";
