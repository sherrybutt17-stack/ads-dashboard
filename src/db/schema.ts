import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  numeric,
  boolean,
  jsonb,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */

/**
 * The seven canonical funnel stages. Fixed across all clients — every
 * client's own GHL stage names are mapped onto these via `pipelineStages`,
 * which is what lets one metrics engine serve every tenant.
 */
export const canonicalStageEnum = pgEnum("canonical_stage", [
  "new_lead",
  "contacted",
  "appointment_booked",
  "showed",
  "no_show",
  "closed_won",
  "lost",
]);

export const CANONICAL_STAGES = canonicalStageEnum.enumValues;
export type CanonicalStage = (typeof CANONICAL_STAGES)[number];

/** Display order + labels for the funnel. `no_show` and `lost` are exits. */
export const STAGE_LABELS: Record<CanonicalStage, string> = {
  new_lead: "New Lead",
  contacted: "Contacted",
  appointment_booked: "Appointment Booked",
  showed: "Showed",
  no_show: "No Show",
  closed_won: "Closed / Won",
  lost: "Lost",
};

/** The happy path, in order. Drop-off between consecutive pairs is the funnel. */
export const FUNNEL_PATH: CanonicalStage[] = [
  "new_lead",
  "contacted",
  "appointment_booked",
  "showed",
  "closed_won",
];

export const clientStatusEnum = pgEnum("client_status", [
  "active",
  "paused",
  "archived",
]);

export const opportunityStatusEnum = pgEnum("opportunity_status", [
  "open",
  "won",
  "lost",
  "abandoned",
]);

export const transitionSourceEnum = pgEnum("transition_source", [
  "webhook",
  "backfill_snapshot",
  "manual",
]);

export const webhookStatusEnum = pgEnum("webhook_status", [
  "pending",
  "processed",
  "failed",
  "ignored",
]);

export const syncKindEnum = pgEnum("sync_kind", [
  "meta_daily",
  "meta_reach",
  "meta_backfill",
  "ghl_backfill",
  "google_daily",
  "google_backfill",
]);

export const syncStatusEnum = pgEnum("sync_status", [
  "running",
  "success",
  "failed",
]);

export const insightLevelEnum = pgEnum("insight_level", ["account", "campaign"]);

/** Dashboard user roles. `staff` sees everything; `client` is scoped to the
 *  specific clients granted via `user_clients`. */
export const userRoleEnum = pgEnum("user_role", ["staff", "client"]);
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);

export const ghlAuthMethodEnum = pgEnum("ghl_auth_method", ["pit", "oauth"]);

export const metaAccountStatusEnum = pgEnum("meta_account_status", [
  "active",
  "paused",
  "removed",
]);

/**
 * Which leads count as paid, and therefore divide into ad spend.
 *
 * This is the difference between an honest cost-per-lead and a flattering one.
 * A GHL pipeline receives leads from everywhere — organic, referral, walk-in —
 * but only Facebook spend is in the numerator. Counting all of them understates
 * true paid CPL by however large the non-paid share is.
 *
 *   all         — every lead entering the pipeline (optimistic CPL)
 *   attributed  — only leads carrying a Meta campaign id from UTMs
 *   tagged      — only leads carrying the configured GHL tag
 *   either      — attributed OR tagged (default; most robust)
 *
 * `either` is the default because each signal alone has a real blind spot:
 * UTMs miss native Instant Form leads entirely, and tagging depends on someone
 * or some automation applying it.
 */
export const paidLeadFilterEnum = pgEnum("paid_lead_filter", [
  "all",
  "attributed",
  "tagged",
  "either",
]);

/* ------------------------------------------------------------------ *
 * clients
 * ------------------------------------------------------------------ */

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),

    /**
     * IANA timezone. ALL date bucketing — funnel windows, daily rows, month
     * boundaries — happens in this timezone, never the server's. Meta also
     * buckets its day in the ad account's timezone, so these should agree;
     * `metaTimezone` below records what Meta actually reports so a mismatch
     * is visible rather than silently skewing every daily number.
     */
    timezone: text("timezone").notNull().default("America/Los_Angeles"),

    // --- GoHighLevel ---
    ghlLocationId: text("ghl_location_id"),
    /**
     * Private Integration Token, encrypted at rest (see lib/crypto.ts).
     *
     * Only used when `ghlAuthMethod` is `pit`. With OAuth the token lives on
     * `ghlInstallations` instead, because it expires and must be refreshed.
     */
    ghlTokenEncrypted: text("ghl_token_encrypted"),
    /**
     * Which credential to use for REST calls. `oauth` is preferred — it comes
     * with app-level webhooks and needs no per-client GHL setup.
     */
    ghlAuthMethod: ghlAuthMethodEnum("ghl_auth_method").notNull().default("pit"),
    /** Cached from the verification call, shown back during onboarding. */
    ghlLocationName: text("ghl_location_name"),

    // --- Meta ---
    // Ad accounts live in their own table (metaAdAccounts) — a client can hold
    // several, summed into one dashboard. These two are a DISPLAY cache derived
    // from the primary account: the currency to format figures in, and the
    // timezone to bucket days by. They are not the source of truth for which
    // accounts exist.
    metaCurrency: text("meta_currency"),
    metaTimezone: text("meta_timezone"),

    /**
     * Unguessable per-client path segment for the GHL webhook URL. Routes the
     * event to the right tenant without parsing GHL's loosely-shaped workflow
     * payload, and doubles as the shared secret — GHL workflow webhooks may
     * carry no signature header at all.
     */
    webhookToken: text("webhook_token").notNull(),

    status: clientStatusEnum("status").notNull().default("active"),

    // --- Which leads count as paid (see paidLeadFilterEnum) ---
    paidLeadFilter: paidLeadFilterEnum("paid_lead_filter")
      .notNull()
      .default("either"),
    /** GHL tag marking a lead as Facebook-sourced. Compared case-insensitively. */
    paidLeadTag: text("paid_lead_tag").notNull().default("facebook-lead"),

    // --- Liveness markers, powering the health checklist ---
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** Proves the webhook pipe has ever actually worked. */
    firstWebhookAt: timestamp("first_webhook_at", { withTimezone: true }),
    lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("clients_slug_key").on(t.slug),
    uniqueIndex("clients_webhook_token_key").on(t.webhookToken),
  ],
);

/* ------------------------------------------------------------------ *
 * metaAdAccounts — a client can hold several
 * ------------------------------------------------------------------ */

/**
 * One row per Facebook ad account attached to a client.
 *
 * A single client (e.g. a practice running separate accounts for two
 * locations) can have several, and the dashboard sums spend and metrics across
 * all of them. Modelled as its own table rather than columns on `clients`
 * precisely so the count is unbounded.
 *
 * `adAccountId` is globally unique: an ad account belongs to exactly one
 * client. Sharing one account across two clients would double-count its spend,
 * so the constraint forbids it outright.
 */
export const metaAdAccounts = pgTable(
  "meta_ad_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /** Stored WITHOUT the `act_` prefix; normalized on write. */
    adAccountId: text("ad_account_id").notNull(),

    /** Per-account token override, for an account in a different Business
     *  Manager than the default system user token can reach. */
    tokenEncrypted: text("token_encrypted"),

    accountName: text("account_name"),
    currency: text("currency"),
    timezone: text("timezone"),

    /**
     * The primary account supplies the client's display currency and the
     * timezone its days are bucketed in. The first account added becomes
     * primary; it matters when a client's accounts disagree on either.
     */
    isPrimary: boolean("is_primary").notNull().default(false),

    status: metaAccountStatusEnum("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_ad_accounts_account_key").on(t.adAccountId),
    index("meta_ad_accounts_client_idx").on(t.clientId),
  ],
);

/* ------------------------------------------------------------------ *
 * googleAdAccounts — a client can hold several
 * ------------------------------------------------------------------ */

/**
 * One row per Google Ads customer account attached to a client — the direct
 * mirror of `metaAdAccounts`.
 *
 * Auth is agency-level: a single developer token + one OAuth refresh token
 * (both env vars) authorize every account linked to our Manager (MCC) account,
 * so no per-client token is normally stored. `refreshTokenEncrypted` exists only
 * for the edge case of an account not under our MCC.
 *
 * `customerId` is stored digits-only (no dashes) and is globally unique — an ad
 * account belongs to exactly one client, so its spend can't be double-counted.
 */
export const googleAdAccounts = pgTable(
  "google_ad_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /** Google Ads customer id, digits only (dashes stripped on write). */
    customerId: text("customer_id").notNull(),

    /** Optional per-account OAuth refresh token override, for an account not
     *  reachable under the agency MCC. Normally null. */
    refreshTokenEncrypted: text("refresh_token_encrypted"),

    accountName: text("account_name"),
    currency: text("currency"),
    timezone: text("timezone"),

    isPrimary: boolean("is_primary").notNull().default(false),
    status: metaAccountStatusEnum("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("google_ad_accounts_customer_key").on(t.customerId),
    index("google_ad_accounts_client_idx").on(t.clientId),
  ],
);

/* ------------------------------------------------------------------ *
 * ghlInstallations — OAuth app installs
 * ------------------------------------------------------------------ */

/**
 * One row per sub-account that has installed the marketplace app.
 *
 * Deliberately NOT a column on `clients`, for two reasons:
 *
 *  1. An install can arrive BEFORE anyone creates the client record — someone
 *     installs the app from GHL's side and the callback fires. Storing it
 *     separately lets that install land and wait, surfacing in the UI as
 *     "unclaimed", instead of being dropped.
 *  2. Access tokens expire (~24h) and refresh tokens are single-use, so this
 *     row is written on a completely different cadence to client config.
 *
 * Agency-level installs produce one row per sub-account, discriminated by
 * `locationId` — which is also how incoming webhooks are routed to a tenant.
 */
export const ghlInstallations = pgTable(
  "ghl_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** GHL sub-account id. The routing key for every inbound webhook. */
    locationId: text("location_id").notNull(),
    /** Agency id, present on agency-level installs. */
    companyId: text("company_id"),
    /** `Location` | `Company` — Company means a bulk agency install. */
    userType: text("user_type"),

    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
    /** Access tokens live ~24h; we refresh on a margin before this. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    scopes: text("scopes"),

    locationName: text("location_name"),

    /** Null until an operator claims this install for a client. */
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),

    installedAt: timestamp("installed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    /** Set when GHL reports the app was uninstalled. Kept, not deleted. */
    uninstalledAt: timestamp("uninstalled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ghl_installations_location_key").on(t.locationId),
    index("ghl_installations_client_idx").on(t.clientId),
  ],
);

/* ------------------------------------------------------------------ *
 * pipelineStages — the multi-tenant translation layer
 * ------------------------------------------------------------------ */

/**
 * Maps one client's GHL stage UUIDs to our canonical stages.
 *
 * This table exists because the GHL opportunity webhook sends ONLY a stage id
 * — no stage name — and every client names and orders their pipeline stages
 * differently. Without it, funnel logic would have to be hardcoded per client.
 *
 * `canonicalStage` is nullable: a stage the operator has not yet mapped (or has
 * deliberately marked as unused) stays null. Transitions into an unmapped stage
 * are still recorded — we never drop an event — and surface on the health
 * checklist for mapping.
 */
export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    ghlPipelineId: text("ghl_pipeline_id").notNull(),
    /** UUID format — unlike GHL's other ids, which are 20-char base62. */
    ghlStageId: text("ghl_stage_id").notNull(),
    ghlStageName: text("ghl_stage_name"),
    ghlPipelineName: text("ghl_pipeline_name"),

    canonicalStage: canonicalStageEnum("canonical_stage"),
    displayOrder: integer("display_order").notNull().default(0),

    /** True when discovered from an incoming webhook rather than the GHL
     *  pipeline list — i.e. the client added a stage after onboarding. */
    discoveredFromWebhook: boolean("discovered_from_webhook")
      .notNull()
      .default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("pipeline_stages_client_stage_key").on(t.clientId, t.ghlStageId),
    index("pipeline_stages_client_canonical_idx").on(t.clientId, t.canonicalStage),
  ],
);

/* ------------------------------------------------------------------ *
 * contacts
 * ------------------------------------------------------------------ */

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    ghlContactId: text("ghl_contact_id").notNull(),

    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    source: text("source"),

    // --- Attribution (fetched from GET /contacts/{id}; webhooks carry none) ---
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),

    /** Meta numeric campaign id, from attributionSource.campaignId. */
    metaCampaignId: text("meta_campaign_id"),
    metaAdsetId: text("meta_adset_id"),
    metaAdId: text("meta_ad_id"),
    fbclid: text("fbclid"),
    /** Google Click ID, from attributionSource.gclid — the Google analog of fbclid. */
    gclid: text("gclid"),
    /** Google Ads numeric campaign id, when derivable from UTMs on the ad URL. */
    googleCampaignId: text("google_campaign_id"),
    /** For native Instant Form leads, which bypass UTMs entirely. */
    facebookLeadId: text("facebook_lead_id"),

    /**
     * GHL tags, lowercased on write.
     *
     * The fallback path for identifying paid leads when UTM attribution is
     * unavailable — most importantly for native Instant Form leads, which
     * carry no UTMs at all regardless of how the ads are configured.
     */
    tags: text("tags").array(),

    rawAttribution: jsonb("raw_attribution"),
    attributionFetchedAt: timestamp("attribution_fetched_at", {
      withTimezone: true,
    }),

    ghlCreatedAt: timestamp("ghl_created_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("contacts_client_ghl_key").on(t.clientId, t.ghlContactId),
    index("contacts_client_campaign_idx").on(t.clientId, t.metaCampaignId),
    index("contacts_client_created_idx").on(t.clientId, t.ghlCreatedAt),
  ],
);

/* ------------------------------------------------------------------ *
 * opportunities — current state only
 * ------------------------------------------------------------------ */

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    ghlOpportunityId: text("ghl_opportunity_id").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    ghlContactId: text("ghl_contact_id"),

    name: text("name"),
    ghlPipelineId: text("ghl_pipeline_id"),

    /** FK to our mapped stage; null when the stage is not yet mapped. */
    currentStageId: uuid("current_stage_id").references(() => pipelineStages.id, {
      onDelete: "set null",
    }),
    /** Raw GHL stage id, always populated even when unmapped. This is what the
     *  transition diff compares against, so it must never be lossy. */
    currentStageGhlId: text("current_stage_ghl_id"),

    status: opportunityStatusEnum("status"),
    monetaryValue: numeric("monetary_value", { precision: 14, scale: 2 }),

    ghlCreatedAt: timestamp("ghl_created_at", { withTimezone: true }),
    /** Authoritative timestamp of the most recent stage change, re-read from
     *  the REST API because the webhook payload carries no event time. */
    lastStageChangeAt: timestamp("last_stage_change_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("opportunities_client_ghl_key").on(t.clientId, t.ghlOpportunityId),
    index("opportunities_client_stage_idx").on(t.clientId, t.currentStageId),
  ],
);

/* ------------------------------------------------------------------ *
 * stageTransitions — THE APPEND-ONLY LEDGER
 * ------------------------------------------------------------------ */

/**
 * The irreplaceable table.
 *
 * GoHighLevel has NO stage-transition history API — verified against their
 * published v2 and v3 OpenAPI specs. All that can ever be read back is
 * `lastStageChangeAt`, a single prior data point per opportunity. Therefore
 * funnel history cannot be backfilled; it can only be accumulated forward, and
 * this app is the system of record.
 *
 * Nothing in here may ever be updated or deleted. Every funnel number the
 * dashboard reports is derived from these rows.
 */
export const stageTransitions = pgTable(
  "stage_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),

    fromStageId: uuid("from_stage_id").references(() => pipelineStages.id, {
      onDelete: "set null",
    }),
    toStageId: uuid("to_stage_id").references(() => pipelineStages.id, {
      onDelete: "set null",
    }),

    /** Raw GHL ids, retained so an unmapped stage can be reconciled later
     *  without losing the event. */
    fromStageGhlId: text("from_stage_ghl_id"),
    toStageGhlId: text("to_stage_ghl_id").notNull(),

    fromCanonical: canonicalStageEnum("from_canonical"),
    toCanonical: canonicalStageEnum("to_canonical"),

    /** Authoritative event time, in UTC. Resolved in priority order:
     *  1. `lastStageChangeAt` re-read from the GHL REST API
     *  2. webhook envelope timestamp
     *  3. our receipt time */
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),

    source: transitionSourceEnum("source").notNull().default("webhook"),

    /**
     * `${opportunityId}:${toStageGhlId}:${changedAt.toISOString()}`
     *
     * GHL retries webhooks ~12x with jitter — delivery is at-least-once and
     * unordered. This unique constraint is what makes reprocessing safe: a
     * redelivered event collapses into the existing row instead of inflating
     * every funnel count downstream.
     */
    dedupeKey: text("dedupe_key").notNull(),

    webhookEventId: uuid("webhook_event_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("stage_transitions_dedupe_key").on(t.dedupeKey),
    // The hot path: "distinct opportunities entering stage X between two dates".
    index("stage_transitions_client_canonical_changed_idx").on(
      t.clientId,
      t.toCanonical,
      t.changedAt,
    ),
    index("stage_transitions_opportunity_idx").on(t.opportunityId, t.changedAt),
  ],
);

/* ------------------------------------------------------------------ *
 * webhookEvents — raw log, for replay
 * ------------------------------------------------------------------ */

/**
 * Every payload is persisted here BEFORE any parsing is attempted, so a bug in
 * the processing logic is recoverable: fix the parser, replay the rows. Without
 * this, a parse bug silently destroys history that cannot be re-fetched.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "cascade",
    }),
    /** Retained even when it matches no client, so misconfigured GHL workflows
     *  are diagnosable rather than invisible. */
    webhookToken: text("webhook_token"),

    eventType: text("event_type"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    headers: jsonb("headers"),
    payload: jsonb("payload").notNull(),

    status: webhookStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("webhook_events_client_received_idx").on(t.clientId, t.receivedAt),
    index("webhook_events_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------------ *
 * fbDailyMetrics
 * ------------------------------------------------------------------ */

/**
 * One row per (client, date, level, campaign). `date` is the day boundary in
 * the AD ACCOUNT's timezone, which is how Meta buckets — not UTC, not ours.
 *
 * Ratios (CTR / CPC / CPM) are deliberately NOT stored. They must be recomputed
 * from summed components at query time, because averaging a ratio across days
 * is arithmetically wrong.
 */
export const fbDailyMetrics = pgTable(
  "fb_daily_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /**
     * Which ad account this row came from, WITHOUT the `act_` prefix.
     *
     * Part of the unique key. Without it, two accounts' account-level rows
     * (level='account', campaignId='') on the same date would collide and the
     * second would overwrite the first — silently discarding half a
     * multi-account client's spend.
     */
    metaAdAccountId: text("meta_ad_account_id").notNull().default(""),

    date: date("date").notNull(),
    level: insightLevelEnum("level").notNull().default("campaign"),
    /** Empty string for account-level rows — NOT null, because Postgres treats
     *  NULLs as distinct and would defeat the unique index below. */
    metaCampaignId: text("meta_campaign_id").notNull().default(""),
    campaignName: text("campaign_name"),

    /** Deduplicated people. NEVER sum across days — see fbPeriodReach. */
    reach: integer("reach").notNull().default(0),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    /** "Clicks (all)" — inflated: includes likes, comments, photo expansions. */
    clicksAll: integer("clicks_all").notNull().default(0),
    /** From actions[action_type=link_click] with the account's unified
     *  attribution setting. This is what matches the Ads Manager column. */
    linkClicks: integer("link_clicks").notNull().default(0),
    /** Meta's `inline_link_clicks` — pinned to a 1-day-click window, so it
     *  reads LOWER than Ads Manager. Stored for reconciliation only. */
    inlineLinkClicks: integer("inline_link_clicks").notNull().default(0),

    spend: numeric("spend", { precision: 14, scale: 4 }).notNull().default("0"),

    /** action_type=lead. Already contains the two below — never sum them. */
    leadsTotal: integer("leads_total").notNull().default(0),
    /** offsite_conversion.fb_pixel_lead */
    leadsPixel: integer("leads_pixel").notNull().default(0),
    /** onsite_conversion.lead_grouped */
    leadsOnsite: integer("leads_onsite").notNull().default(0),

    currency: text("currency"),

    /**
     * True while the row is younger than 28 days. Meta keeps restating spend
     * and conversions as attribution windows fill, so these numbers are not
     * final and the UI should say so.
     */
    isProvisional: boolean("is_provisional").notNull().default(true),

    /** Raw API row, for debugging a reconciliation mismatch. */
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("fb_daily_metrics_key").on(
      t.clientId,
      t.metaAdAccountId,
      t.date,
      t.level,
      t.metaCampaignId,
    ),
    index("fb_daily_metrics_client_date_idx").on(t.clientId, t.date),
  ],
);

/* ------------------------------------------------------------------ *
 * fbPeriodReach — because reach is not additive
 * ------------------------------------------------------------------ */

/**
 * `reach` counts distinct people within the queried window. Someone who saw an
 * ad on ten different days contributes 10 to a naive sum of daily reach, but 1
 * to the true monthly figure — overstating it 2–5x on high-frequency campaigns.
 *
 * So every aggregate period the dashboard displays gets its own query, cached
 * here. `frequency` and `cpp` are derived from reach and inherit the same rule.
 */
export const fbPeriodReach = pgTable(
  "fb_period_reach",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    metaAdAccountId: text("meta_ad_account_id").notNull().default(""),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    metaCampaignId: text("meta_campaign_id").notNull().default(""),

    reach: integer("reach").notNull().default(0),
    frequency: numeric("frequency", { precision: 10, scale: 4 }),

    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("fb_period_reach_key").on(
      t.clientId,
      t.metaAdAccountId,
      t.periodStart,
      t.periodEnd,
      t.metaCampaignId,
    ),
  ],
);

/* ------------------------------------------------------------------ *
 * googleDailyMetrics — the Google mirror of fbDailyMetrics
 * ------------------------------------------------------------------ */

/**
 * One row per (client, customer, date, campaign). `date` is bucketed in the
 * Google Ads account's timezone, same rule as Meta.
 *
 * Only the metrics that map cleanly to Google are stored — no reach / link
 * clicks / pixel-lead columns (those are Meta-only). Google `conversions` is
 * captured for reference but is NOT the lead source of truth — GHL is, exactly
 * as with Meta. Ratios are recomputed at query time, never stored.
 */
export const googleDailyMetrics = pgTable(
  "google_daily_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /** Google Ads customer id, digits only. Part of the unique key so two
     *  accounts' rows on the same date/campaign cannot collide. */
    customerId: text("customer_id").notNull().default(""),

    date: date("date").notNull(),
    /** Empty string for account-level rows — never null (NULLs defeat the
     *  unique index, exactly as on fbDailyMetrics). */
    googleCampaignId: text("google_campaign_id").notNull().default(""),
    campaignName: text("campaign_name"),

    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    spend: numeric("spend", { precision: 14, scale: 4 }).notNull().default("0"),
    conversions: numeric("conversions", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),

    currency: text("currency"),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("google_daily_metrics_key").on(
      t.clientId,
      t.customerId,
      t.date,
      t.googleCampaignId,
    ),
    index("google_daily_metrics_client_date_idx").on(t.clientId, t.date),
  ],
);

/* ------------------------------------------------------------------ *
 * syncRuns — observability
 * ------------------------------------------------------------------ */

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "cascade",
    }),
    kind: syncKindEnum("kind").notNull(),
    status: syncStatusEnum("status").notNull().default("running"),

    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    rowsWritten: integer("rows_written").notNull().default(0),
    error: text("error"),
    meta: jsonb("meta"),
  },
  (t) => [index("sync_runs_client_started_idx").on(t.clientId, t.startedAt)],
);

/* ------------------------------------------------------------------ *
 * auditLog — security & accountability trail
 * ------------------------------------------------------------------ *
 *
 * Answers "who did what, from where, when" for security-relevant actions:
 * logins (and failures), attaching/detaching ad accounts, token changes, and
 * data-import triggers. `action` is free text (not an enum) so new event types
 * never require a migration. Writes are best-effort and must never break the
 * operation they record.
 */

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** Dotted event name, e.g. "auth.login", "meta_account.add". */
    action: text("action").notNull(),
    /** "session" | "client" | "meta_account" | "google_account" | … */
    targetType: text("target_type"),
    targetId: text("target_id"),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("audit_log_at_idx").on(t.at),
    index("audit_log_action_idx").on(t.action),
    index("audit_log_client_idx").on(t.clientId),
  ],
);

/* ------------------------------------------------------------------ *
 * users — individual logins with roles
 * ------------------------------------------------------------------ *
 *
 * Replaces (and coexists with) the single shared password. A `staff` user sees
 * every client; a `client` user sees only the clients granted to them through
 * `user_clients` (many-to-many, so one login can cover several of a client's
 * brands). Passwords are scrypt-hashed (see `hashPassword` in crypto.ts).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("client"),
    name: text("name"),
    status: userStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

/** Which clients a (client-role) user may see. Ignored for staff. */
export const userClients = pgTable(
  "user_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("user_clients_key").on(t.userId, t.clientId),
    index("user_clients_user_idx").on(t.userId),
  ],
);

/* ------------------------------------------------------------------ *
 * Inferred types
 * ------------------------------------------------------------------ */

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type GhlInstallation = typeof ghlInstallations.$inferSelect;
export type MetaAdAccount = typeof metaAdAccounts.$inferSelect;
export type GoogleAdAccount = typeof googleAdAccounts.$inferSelect;
export type GoogleDailyMetric = typeof googleDailyMetrics.$inferSelect;
export type PipelineStage = typeof pipelineStages.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Opportunity = typeof opportunities.$inferSelect;
export type StageTransition = typeof stageTransitions.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type FbDailyMetric = typeof fbDailyMetrics.$inferSelect;
export type FbPeriodReach = typeof fbPeriodReach.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserClient = typeof userClients.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
