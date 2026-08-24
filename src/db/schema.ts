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
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { CANONICAL_STAGES } from "@/lib/stages";

/**
 * `bytea`, which drizzle-orm 0.45's pg-core does not ship.
 *
 * Ten lines rather than a dependency, but it has to be right under BOTH drivers
 * this app supports: `node-postgres` hands back a Node `Buffer`, while the Neon
 * serverless driver returns the wire format — a `\x`-prefixed hex string — so a
 * naive `value as Buffer` silently yields a string on Neon and every logo is
 * served as the literal text "\x89504e47…". `fromDriver` normalises both.
 */
export const bytea = customType<{
  data: Buffer;
  driverData: Buffer | Uint8Array | string;
}>({
  dataType: () => "bytea",
  fromDriver(value) {
    // Neon serverless: the raw wire format, `\x` + hex.
    if (typeof value === "string") {
      return Buffer.from(value.replace(/^\\x/, ""), "hex");
    }
    // node-postgres: already a Buffer. PGlite (tests): a plain Uint8Array, which
    // is NOT a Buffer and lacks its methods — found by the round-trip test, and
    // exactly the kind of near-miss that would otherwise surface as one driver
    // serving corrupt images with nothing in the logs.
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value);
  },
  toDriver(value) {
    return value;
  },
});

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */

/**
 * The canonical funnel stages, built FROM `@/lib/stages` rather than declared
 * here.
 *
 * 🔴 The direction of that dependency is the point. These constants are needed
 * in the browser (the funnel labels its stages, the wizard offers them in
 * dropdowns), and when they lived in this file, one `import { STAGE_LABELS }`
 * in a client component pulled the whole schema — every table and column name,
 * including `ghl_token_encrypted`, `password_hash` and `webhook_token` — into
 * the client bundle, along with 80K of `drizzle-orm/pg-core` metadata. This
 * application has client-role logins, so that map was readable by people
 * outside the agency.
 *
 * `@/lib/stages` has no dependencies, so a component can import the labels
 * without importing a database. Values are re-exported below so existing
 * server-side imports from `@/db/schema` keep working.
 */
export const canonicalStageEnum = pgEnum("canonical_stage", CANONICAL_STAGES);

export {
  CANONICAL_STAGES,
  REQUIRED_CANONICAL_STAGES,
  STAGE_LABELS,
  FUNNEL_PATH,
} from "@/lib/stages";
export type { CanonicalStage } from "@/lib/stages";

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

/**
 * What a `sync_runs` row was.
 *
 * `*_daily` means a FULL trailing-window reconciliation — the nightly cron or a
 * manual "Sync now". `*_intraday` is the stale-while-revalidate refresh fired by
 * a dashboard load, which pulls today only.
 *
 * The split exists because health has to judge those two differently. An
 * intraday refresh is best-effort: it races the page response, can be killed
 * when the serverless invocation ends, and its failure costs nothing (the next
 * page load retries within 15 minutes). A failed reconciliation is real — it
 * means the numbers have stopped being trued up against the platform. Writing
 * both under one kind made the freshness check read whichever happened last, so
 * a client whose cron had been dead for a week still showed "Synced 2m ago"
 * purely because somebody opened the page.
 */
export const syncKindEnum = pgEnum("sync_kind", [
  "meta_daily",
  "meta_intraday",
  "meta_reach",
  "meta_backfill",
  "ghl_backfill",
  "google_daily",
  "google_intraday",
  "google_backfill",
  "tiktok_daily",
  "tiktok_intraday",
  "tiktok_backfill",
]);

export const syncStatusEnum = pgEnum("sync_status", [
  "running",
  "success",
  "failed",
]);

export const insightLevelEnum = pgEnum("insight_level", [
  "account",
  "campaign",
  "adset",
  "ad",
]);

/**
 * What an ad is made of, for creative reporting.
 *
 * `carousel` and `unknown` are real answers, not fallbacks: a carousel has many
 * assets and no single identity, and an ad whose creative we could not read must
 * not be silently bucketed with the images.
 */
export const creativeTypeEnum = pgEnum("creative_type", [
  "image",
  "video",
  "carousel",
  "unknown",
]);
export type CreativeType = (typeof creativeTypeEnum.enumValues)[number];

/**
 * Meta's delivery diagnostics. Ad level only, and only once the ad has cleared
 * ~500 impressions — below that Meta returns `UNKNOWN`, which is a distinct
 * fact from `AVERAGE` and must not be rendered as one.
 */
export const deliveryRankingEnum = pgEnum("delivery_ranking", [
  "above_average",
  "average",
  "below_average_35",
  "below_average_20",
  "below_average_10",
  "unknown",
]);
export type DeliveryRanking = (typeof deliveryRankingEnum.enumValues)[number];

/**
 * Dashboard user roles.
 *
 *   superadmin — us. Crosses agency boundaries; the only role that may.
 *   agency     — owns clients within ONE agency, and can create more.
 *   client     — one dashboard, scoped by `user_clients`.
 *   staff      — 🔴 pre-tenancy. Means "sees every row in the database".
 *
 * `staff` is kept, not renamed, and that is deliberate. It was what all 63
 * `staffGuard()` call sites checked, and rewriting the enum and the guards in
 * one step would have meant landing the tenant column and the authorization
 * rewrite together — with no working state in between and no way to verify one
 * without the other. So the two new values went in first (a Postgres enum value
 * has to be committed before anything may use it) and the guards moved after.
 *
 * That move is now done: every route handler calls `agencyGuard` or
 * `superadminGuard`, and `staffGuard` survives only as a definition in
 * `auth.ts` and an entry in the guard census. What still checks for the ROLE is
 * `isCrossTenantRole` in `client-scope.ts`, which is what keeps the operator's
 * own access alive until `superadmin` has been assigned. `staff` is retired in
 * one deliberate step once that reassignment has happened.
 *
 * Until then, treat `staff` as `superadmin` with no audit identity: it is the
 * role the shared-password bootstrap mints, which is leak #11 and the reason
 * that bootstrap has to go before sign-up opens.
 *
 * 🔴 The ORDER is `staff, client, superadmin, agency` and must stay that way.
 * It is not a preference — it is what Postgres will hold after
 * `ALTER TYPE ... ADD VALUE` appends the two new labels to the existing pair.
 * Declaring a tidier order here would make `db:push` see a type it cannot
 * reconcile by appending, and a recreate of an enum in use is not a thing to
 * discover on a deploy. `tenancy.test.ts` reads the labels back out of a real
 * Postgres after running the migration and asserts this exact sequence.
 */
export const userRoleEnum = pgEnum("user_role", [
  "staff",
  "client",
  "superadmin",
  "agency",
]);
export type UserRole = (typeof userRoleEnum.enumValues)[number];

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
 * agencies — the tenant
 * ------------------------------------------------------------------ *
 *
 * 🔴 The row every other row belongs to.
 *
 * Until this table existed there was no tenant in the schema at all: 26 tables,
 * zero `agency_id`, and `staff` meaning "sees every row in the database". That
 * is a correct design for one agency running its own tool and an immediate data
 * breach for the second one, so nothing about sign-up can be opened until
 * every table that holds a customer's data can name whose it is.
 *
 * Adding the column is the easy half. The hard half — replacing the unscoped
 * accessors so that a query which forgets the tenant fails to compile — is
 * Phase 2, and this table is what makes it expressible.
 */

export const agencyStatusEnum = pgEnum("agency_status", [
  "active",
  "suspended",
]);

export const agencies = pgTable(
  "agencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /**
     * Reserved for a future subdomain or path prefix. Not yet routed — client
     * slugs stay globally unique for now (see `clients.slug`), so nothing reads
     * this to resolve a request.
     */
    slug: text("slug").notNull(),
    status: agencyStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("agencies_slug_key").on(t.slug)],
);

export type Agency = typeof agencies.$inferSelect;

/**
 * The agency every pre-tenancy row is backfilled to.
 *
 * Deliberately not a random uuid: a reader who finds this id on a row should
 * see immediately that it is a migration artifact rather than a real tenant.
 * `drizzle/0023_tenancy.sql` hardcodes the same literal — `tenancy.test.ts`
 * asserts the two agree, because a mismatch would point every existing client
 * at an agency row that does not exist and fail the foreign key at the worst
 * possible moment.
 */
export const BOOTSTRAP_AGENCY_ID = "00000000-0000-0000-0000-000000000001";

/* ------------------------------------------------------------------ *
 * clients
 * ------------------------------------------------------------------ */

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Who owns this client.
     *
     * 🔴 `restrict`, not `cascade`. Deleting an agency must not silently take
     * its clients — and with them the `stage_transitions` ledger, which is the
     * one dataset in this system that cannot be rebuilt from any API. Removing
     * an agency has to deal with its clients explicitly and visibly.
     *
     * No default. A default would quietly assign any insert that forgot the
     * tenant to whichever agency the default named, which is the exact failure
     * this column exists to prevent — so a forgotten `agencyId` is a compile
     * error at the call site instead.
     */
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /**
     * 🔴 Globally unique, deliberately, and NOT scoped to the agency yet.
     *
     * `canAccessSlug` and the edge proxy are both slug-keyed: the session token
     * carries bare slugs, so if two agencies could each own `/c/acme` the proxy
     * would authorise the wrong tenant's dashboard without a database read to
     * catch it. Scoping the slug therefore requires moving the session payload
     * off bare slugs first. Until then the namespace stays global — the cost is
     * that the URL space leaks the shape of the client roster, which is far
     * cheaper than authorising across a tenant boundary.
     */
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
    ghlAuthMethod: ghlAuthMethodEnum("ghl_auth_method")
      .notNull()
      .default("pit"),
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

    // --- Real-time new-lead alerts ---
    /**
     * Slack or Discord incoming-webhook URL, encrypted at rest.
     *
     * 🔴 The host is allowlisted on both write and send — see
     * `src/lib/alerts/compose.ts`. A user-supplied URL the server then fetches
     * is an SSRF primitive, and this one is set through an authenticated staff
     * route on a public repository, so an authz slip would chain straight into
     * reading cloud metadata.
     */
    alertWebhookEncrypted: text("alert_webhook_encrypted"),
    /**
     * Separate from the URL being present, so alerts can be muted for a noisy
     * week without losing the destination and having to find it again.
     */
    alertsEnabled: boolean("alerts_enabled").notNull().default(false),

    // --- Liveness markers, powering the health checklist ---
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /**
     * Last FULL trailing-window reconciliation per platform, as opposed to an
     * intraday current-day refresh.
     *
     * Deliberately separate from `lastSyncedAt`, which cannot serve this
     * purpose: the stale-while-revalidate path on dashboard load calls the same
     * `syncClientMetrics` with `since = until = today`, writing the same
     * `sync_runs` kind and the same `lastSyncedAt`. Without a dedicated column
     * a client viewed all day would look permanently "synced" while never
     * actually being reconciled against the platform's restatements.
     *
     * Also deliberately one column PER PLATFORM. Meta, Google and TikTok
     * reconcile on separate crons; a shared column would let whichever ran
     * first mark the client done and make the other two skip it permanently.
     *
     * NULL means never reconciled, which correctly reads as overdue.
     */
    lastMetaReconciledAt: timestamp("last_meta_reconciled_at", {
      withTimezone: true,
    }),
    lastGoogleReconciledAt: timestamp("last_google_reconciled_at", {
      withTimezone: true,
    }),
    lastTiktokReconciledAt: timestamp("last_tiktok_reconciled_at", {
      withTimezone: true,
    }),
    /**
     * When a budget-pacing alert last went out, and what it said.
     *
     * Both, not just the timestamp. The status is what lets a client whose
     * drift REVERSES — underspending on Monday, overspending by Friday — get
     * told immediately, while one that is merely still underspending waits out
     * the cooldown. A timestamp alone would either repeat a stale warning daily
     * or sit silent through a change of direction, and the second is the one
     * that costs money.
     */
    lastPacingAlertAt: timestamp("last_pacing_alert_at", {
      withTimezone: true,
    }),
    lastPacingAlertStatus: text("last_pacing_alert_status"),
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
    // Every scoped read in Phase 2 filters on this. Cheap now, and adding it
    // later means an index build on a table under load.
    index("clients_agency_idx").on(t.agencyId),
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

    /**
     * When `tokenEncrypted` dies. NULL means it does not expire.
     *
     * 🔴 The whole reason this column exists: a system-user token never
     * expires, but a **user** token from the "Continue with Facebook" flow
     * lasts ~60 days and then stops. Without the date stored, that connection
     * would work perfectly through setup and every check made while someone was
     * watching, then go quiet two months later with no signal — the exact
     * silent-death failure this product exists to replace. `tokenExpiryState()`
     * in `lib/meta/oauth.ts` reads it, and the health checklist warns 14 days
     * out, because re-authorising may need the client rather than the agency.
     */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),

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
    /**
     * 🔴 Scoped to the client. This key was GLOBALLY unique, which is a squat.
     *
     * A globally unique ad-account id means the first agency to type an id owns
     * it forever: the legitimate owner is permanently blocked from attaching
     * their own account, with no route to appeal that does not go through us.
     * The rejection is also a disclosure oracle — "already attached to a
     * different client" confirms, to anyone who can type an id, that some other
     * tenant holds that account.
     *
     * `tiktok_ad_accounts` was already keyed this way and is the model. Spend
     * double-counting within one agency is still prevented, but by an
     * agency-scoped check in `meta/accounts.ts` that can answer helpfully
     * without answering across a tenant boundary.
     */
    uniqueIndex("meta_ad_accounts_account_key").on(t.clientId, t.adAccountId),
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

    /**
     * 🔴 The manager account this customer is reached THROUGH — the
     * `login-customer-id` header, per account rather than one global env var.
     *
     * The env var is correct for the agency-MCC model, where every client
     * account is linked under one Manager account we own. It is wrong the
     * moment a client signs in with **their own** Google account: their
     * accounts sit under THEIR manager, or under no manager at all, and sending
     * our MCC id as the header is a request Google answers with a permission
     * error rather than data.
     *
     * Null means "use the agency MCC from env", which keeps every existing
     * account working exactly as before.
     *
     * The failure this prevents is silent in the worst way: the header is
     * syntactically fine and the call simply returns nothing for accounts that
     * plainly have spend.
     */
    loginCustomerId: text("login_customer_id"),

    /**
     * True when this row is a MANAGER account rather than one that runs ads.
     *
     * Manager accounts cannot be queried for metrics — `customer.status` and
     * spend live on the leaf accounts beneath them. Recorded so the connect UI
     * can show the hierarchy without offering an account that will always
     * report zero.
     */
    isManager: boolean("is_manager").notNull().default(false),

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
    // Scoped to the client for the reason recorded on
    // `meta_ad_accounts_account_key`: a global unique on a customer id hands
    // permanent ownership to whoever types it first, and its rejection message
    // discloses that another tenant holds the account.
    uniqueIndex("google_ad_accounts_customer_key").on(t.clientId, t.customerId),
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
    /**
     * ⚠️ Globally unique, and now deliberately staying that way.
     *
     * Unlike an ad-account id, this key is how an inbound webhook finds its
     * tenant — the payload carries a location id and nothing else. A per-agency
     * index would make the same location id resolvable to two rows, and the
     * receiver has nothing in the payload to break the tie with.
     *
     * This used to be blocked on something worse: `claimInstallation` accepted
     * any `(installationId, clientId)` pair with no authorization and no
     * already-claimed guard, so scoping the index alone would have moved that
     * leak rather than closed it. That is now fixed — the function takes a
     * loaded `Client` rather than an id, and refuses to move a claimed install
     * across a tenant boundary (`ghl/oauth.test.ts`). With the claim authorized
     * at the point of claiming, one global row per sub-account is the correct
     * shape rather than a compromise: two agencies cannot both hold it, so the
     * uniqueness IS the tenant rule.
     */
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
    uniqueIndex("pipeline_stages_client_stage_key").on(
      t.clientId,
      t.ghlStageId,
    ),
    index("pipeline_stages_client_canonical_idx").on(
      t.clientId,
      t.canonicalStage,
    ),
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

    /** TikTok Click ID — the TikTok analog of `fbclid` and `gclid`. */
    ttclid: text("ttclid"),
    /** TikTok numeric campaign id, when derivable from UTMs on the ad URL. */
    tiktokCampaignId: text("tiktok_campaign_id"),

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

    /**
     * First OUTBOUND CALL to this lead — the anchor for speed-to-lead. Set once
     * (COALESCE) from an OutboundMessage webhook where messageType = CALL.
     */
    firstCallAt: timestamp("first_call_at", { withTimezone: true }),
    /**
     * First message in either direction — we reached out, or they replied. The
     * signal for auto-detecting "contacted" independent of a manual stage move.
     */
    firstTouchAt: timestamp("first_touch_at", { withTimezone: true }),

    /**
     * When a real-time alert was sent for this lead.
     *
     * 🔴 Also the lock. GHL retries a webhook about twelve times, so the claim
     * is `UPDATE … WHERE alerted_at IS NULL RETURNING id` and only a returned
     * row may send — two concurrent deliveries cannot both win it. A separate
     * read-then-write would put a dozen identical pings in a Slack channel.
     */
    alertedAt: timestamp("alerted_at", { withTimezone: true }),

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
    currentStageId: uuid("current_stage_id").references(
      () => pipelineStages.id,
      {
        onDelete: "set null",
      },
    ),
    /** Raw GHL stage id, always populated even when unmapped. This is what the
     *  transition diff compares against, so it must never be lossy. */
    currentStageGhlId: text("current_stage_ghl_id"),

    status: opportunityStatusEnum("status"),
    monetaryValue: numeric("monetary_value", { precision: 14, scale: 2 }),

    ghlCreatedAt: timestamp("ghl_created_at", { withTimezone: true }),
    /** Authoritative timestamp of the most recent stage change, re-read from
     *  the REST API because the webhook payload carries no event time. */
    lastStageChangeAt: timestamp("last_stage_change_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("opportunities_client_ghl_key").on(
      t.clientId,
      t.ghlOpportunityId,
    ),
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

    /*
     * Ad-set and ad identity. Empty string above their level, for the same
     * reason `metaCampaignId` is: they are part of the unique key, and a NULL
     * would make every row distinct from every other and defeat the upsert.
     */
    metaAdsetId: text("meta_adset_id").notNull().default(""),
    adsetName: text("adset_name"),
    metaAdId: text("meta_ad_id").notNull().default(""),
    adName: text("ad_name"),

    /**
     * 🔴 THE CREATIVE DEDUP KEY — `image_hash` or `video_id`, never the ad id.
     *
     * The same asset running in twelve ad sets is twelve ads with twelve
     * distinct ad ids. Grouping creative performance by ad id therefore splits
     * one creative's spend and leads across twelve rows, and per-creative
     * cost-per-lead comes out roughly TWELVE TIMES too low — a number that
     * looks like a star performer and is an artifact of the grouping.
     *
     * Denormalised onto the metrics row (rather than joined through
     * `meta_ad_creatives` at query time) so the leaderboard is one GROUP BY
     * against data already filtered by client and date, and so a creative that
     * is later deleted in Ads Manager keeps its historical rows attributable.
     *
     * Empty string when unknown — the ad's creative could not be read, or the
     * row is above ad level.
     */
    creativeKey: text("creative_key").notNull().default(""),
    creativeType: creativeTypeEnum("creative_type")
      .notNull()
      .default("unknown"),

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

    /*
     * ---- Creative performance. All additive counts; ratios derived at query
     * time from summed components, never stored. ----
     */

    /**
     * 3-second video views — the numerator of HOOK RATE.
     *
     * Read from `actions[action_type=video_view]`, **not** `video_play_actions`.
     * A "play" includes an autoplay start the viewer never chose and never saw
     * through; counting those inflates hook rate on placements that autoplay in
     * feed, which is most of them.
     */
    video3sViews: integer("video_3s_views").notNull().default(0),
    /** `video_play_actions` — plays, stored for reconciliation against Ads Manager. */
    videoPlays: integer("video_plays").notNull().default(0),
    /**
     * ThruPlays — the numerator of HOLD RATE.
     *
     * 🔴 NOT COMPARABLE ACROSS VIDEO LENGTHS. Meta counts a ThruPlay as
     * "watched to completion" for a video under 15 seconds, but merely "reached
     * 15 seconds" for anything longer. So a 10s ad earns its ThruPlay by being
     * finished while a 60s ad earns one at the quarter mark, and ranking the two
     * on hold rate compares different achievements. `meta_ad_creatives`
     * therefore stores video duration, and every hold-rate benchmark must be
     * segmented by length bucket. No competitor surfaces this.
     */
    thruPlays: integer("thru_plays").notNull().default(0),

    /** Retention anchors. Only these five exist — any smoother "retention
     *  curve" in this category is interpolation between them, and should say so. */
    videoP25: integer("video_p25").notNull().default(0),
    videoP50: integer("video_p50").notNull().default(0),
    videoP75: integer("video_p75").notNull().default(0),
    videoP95: integer("video_p95").notNull().default(0),
    videoP100: integer("video_p100").notNull().default(0),

    /** actions[landing_page_view] — the click→land leak. Lower than link clicks
     *  whenever the page is slow or the click was accidental. */
    landingPageViews: integer("landing_page_views").notNull().default(0),
    /** Clicks that actually left Facebook, as opposed to on-platform expansions. */
    outboundClicks: integer("outbound_clicks").notNull().default(0),

    /*
     * Delivery diagnostics. Ad level only, and `unknown` below ~500 impressions
     * — which is a different statement from `average` and is stored as such.
     */
    qualityRanking: deliveryRankingEnum("quality_ranking"),
    engagementRateRanking: deliveryRankingEnum("engagement_rate_ranking"),
    conversionRateRanking: deliveryRankingEnum("conversion_rate_ranking"),

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
    /*
     * The upsert key. `metaAdsetId` and `metaAdId` joined it when ad-level sync
     * landed: without them every ad in a campaign collides on one row and the
     * last one written wins, so a campaign with forty ads would report the spend
     * of whichever ad Meta happened to return last. Rows above ad level carry
     * empty strings, which keeps campaign and account rows on their own keys.
     */
    uniqueIndex("fb_daily_metrics_key").on(
      t.clientId,
      t.metaAdAccountId,
      t.date,
      t.level,
      t.metaCampaignId,
      t.metaAdsetId,
      t.metaAdId,
    ),
    index("fb_daily_metrics_client_date_idx").on(t.clientId, t.date),
    /*
     * The creative leaderboard's index: "spend and leads per creative over a
     * date range" is one range scan grouped by `creativeKey`. Level is in the
     * key because campaign-level rows carry an empty creative key and must
     * never be swept into a creative aggregate.
     */
    index("fb_daily_metrics_creative_idx").on(
      t.clientId,
      t.level,
      t.creativeKey,
      t.date,
    ),
  ],
);

/* ------------------------------------------------------------------ *
 * metaAdCreatives — what an ad actually looks like
 * ------------------------------------------------------------------ */

/**
 * One row per AD, carrying its creative identity and assets.
 *
 * Two jobs, and the first is the one that has to be right from day one:
 *
 * 1. **Resolve ad id → creative key.** Insights reports per ad; creative
 *    performance has to be reported per ASSET, and the mapping between them
 *    lives only here. Get it wrong and every per-creative cost metric is
 *    divided by the number of ad sets the asset runs in.
 * 2. **Make the creative grid possible.** A table of ad ids is close to
 *    worthless; a grid of actual thumbnails with spend and CPL underneath is
 *    the screen agencies stare at.
 *
 * Keyed by ad id, not creative id: an ad's creative can be swapped, and we want
 * the row to follow the ad while `creativeKey` records what it currently shows.
 */
export const metaAdCreatives = pgTable(
  "meta_ad_creatives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    metaAdAccountId: text("meta_ad_account_id").notNull().default(""),

    metaAdId: text("meta_ad_id").notNull(),
    adName: text("ad_name"),
    metaAdsetId: text("meta_adset_id"),
    metaCampaignId: text("meta_campaign_id"),

    /** Meta's own creative object id. Useful for debugging; NEVER the dedup key. */
    metaCreativeId: text("meta_creative_id"),

    /** `image_hash` or `video_id` — the identity a human would call "the ad". */
    creativeKey: text("creative_key").notNull().default(""),
    creativeType: creativeTypeEnum("creative_type")
      .notNull()
      .default("unknown"),
    imageHash: text("image_hash"),
    videoId: text("video_id"),

    /**
     * Video duration in seconds, fetched from the video object — insights does
     * not carry it.
     *
     * Required for honest hold-rate reporting: ThruPlay means "finished" below
     * 15s and "reached 15s" above it, so the metric is only comparable within a
     * length bucket. Null for images, and null for videos whose duration could
     * not be read — in which case hold rate is shown without a benchmark rather
     * than against the wrong one.
     */
    videoLengthSeconds: numeric("video_length_seconds", {
      precision: 8,
      scale: 2,
    }),

    /** Copy, for reading the grid without leaving the dashboard. */
    title: text("title"),
    body: text("body"),
    callToActionType: text("call_to_action_type"),
    /** Where the ad sends people — the other half of an attribution audit. */
    linkUrl: text("link_url"),

    /** Meta-hosted preview image. Expires, so it is refreshed on every sync. */
    thumbnailUrl: text("thumbnail_url"),

    /** `ACTIVE` / `PAUSED` / … — an ad can be off while its history stays. */
    status: text("status"),
    /**
     * Ad-set learning state (`LEARNING`, `LEARNING_LIMITED`, `SUCCESS`).
     *
     * A correctness input for keep/kill, not a decoration: recommending a kill
     * on an ad set that has not exited the learning phase is precisely the
     * wrong call, because its delivery is still being optimised and its current
     * cost per result is not its steady-state cost.
     */
    learningStage: text("learning_stage"),

    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_ad_creatives_key").on(t.clientId, t.metaAdId),
    index("meta_ad_creatives_creative_idx").on(t.clientId, t.creativeKey),
  ],
);

/* ------------------------------------------------------------------ *
 * fbBreakdownMetrics — who the money actually reached
 * ------------------------------------------------------------------ */

/**
 * Which segmentation a breakdown row describes.
 *
 * ONE key per API request, never a combination — verified against Meta's
 * breakdown documentation, which states plainly that "due to storage
 * constraints, only some permutations of breakdowns are available" and does not
 * list `age`/`gender` alongside `publisher_platform` / `platform_position` /
 * `impression_device` in any permitted permutation. Requesting an unlisted pair
 * is a hard API error, not a degraded response.
 *
 * `placement` is the one deliberate combination — `publisher_platform` with
 * `platform_position` is the documented pair, and it is the only way to say
 * "Instagram Reels" rather than "Instagram, somewhere".
 */
export const breakdownKeyEnum = pgEnum("breakdown_key", [
  "age",
  "gender",
  "region",
  "placement",
  "device",
]);
export type BreakdownKey = (typeof breakdownKeyEnum.enumValues)[number];

/**
 * Ad performance split by audience segment.
 *
 * Answers the question a local service business loses the most money to:
 * *where is this spend actually going?* Clicks forty miles outside the service
 * area, or on a placement nobody converts from, are usually the largest silent
 * waste in the account — invisible in every campaign-level total.
 *
 * Three properties of Meta's data shape this table:
 *
 * 1. **Segments do not reconcile to the campaign total, and never will.** Meta
 *    withholds segments whose audience falls below its privacy threshold. The
 *    difference is real and must be displayed rather than discovered — a reader
 *    who adds up the age rows and finds them $300 short of the headline spend
 *    will conclude the dashboard is broken.
 * 2. **`reach` is not additive across segments**, exactly as it is not across
 *    days: one person in two age brackets is impossible, but one person reached
 *    on both Facebook and Instagram counts once in each placement row and once
 *    overall. Stored per row, summed never.
 * 3. **Account level, not campaign level.** age(7) × gender(3) × placement(~12)
 *    × campaign × day multiplies row count by the campaign count for a question
 *    nobody asks — "which age group converts" is an account-level question. The
 *    campaign column exists (empty string) so per-campaign can be added later
 *    without a migration.
 *
 * Stored per DAY rather than per period, unlike `fb_period_reach`. Period rows
 * would only be readable for the exact windows we happened to sync, which makes
 * the date picker — the primary control on the page — silently inert for this
 * section. Daily rows cost the same API calls and aggregate to any range.
 */
export const fbBreakdownMetrics = pgTable(
  "fb_breakdown_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    metaAdAccountId: text("meta_ad_account_id").notNull().default(""),

    /*
     * A single day has start == end. The pair is kept rather than one `date`
     * column so a genuinely non-additive metric (reach for a whole month, per
     * placement) can be stored later against its exact window, in the same
     * table, without a migration.
     */
    dateStart: date("date_start").notNull(),
    dateEnd: date("date_end").notNull(),

    level: insightLevelEnum("level").notNull().default("account"),
    /** Empty string at account level — NOT null, which would defeat the unique index. */
    metaCampaignId: text("meta_campaign_id").notNull().default(""),

    breakdownKey: breakdownKeyEnum("breakdown_key").notNull(),
    /** e.g. `25-34`, `female`, `Instagram · Reels`, `California`, `mobile_app`. */
    segmentValue: text("segment_value").notNull(),

    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicksAll: integer("clicks_all").notNull().default(0),
    linkClicks: integer("link_clicks").notNull().default(0),
    spend: numeric("spend", { precision: 14, scale: 4 }).notNull().default("0"),
    leadsTotal: integer("leads_total").notNull().default(0),
    /** Deduplicated people IN THIS SEGMENT. Never sum across segments or days. */
    reach: integer("reach").notNull().default(0),

    isProvisional: boolean("is_provisional").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("fb_breakdown_metrics_key").on(
      t.clientId,
      t.metaAdAccountId,
      t.dateStart,
      t.dateEnd,
      t.level,
      t.metaCampaignId,
      t.breakdownKey,
      t.segmentValue,
    ),
    index("fb_breakdown_metrics_lookup_idx").on(
      t.clientId,
      t.breakdownKey,
      t.dateStart,
    ),
  ],
);

export type FbBreakdownMetric = typeof fbBreakdownMetrics.$inferSelect;
export type NewFbBreakdownMetric = typeof fbBreakdownMetrics.$inferInsert;

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

/* ------------------------------------------------------------------ *
 * Branding — the client's mark on the client's report
 * ------------------------------------------------------------------ */

/**
 * How visibly the agency signs a client's report.
 *
 * `none` produces an unattributed document a client could pass off as in-house,
 * which quietly weakens renewals — so it exists but is not the default. Shipping
 * all three and defaulting to `prepared_by` leaves the call with the agency.
 */
export const agencyMarkModeEnum = pgEnum("agency_mark_mode", [
  "full",
  "prepared_by",
  "none",
]);
export type AgencyMarkMode = (typeof agencyMarkModeEnum.enumValues)[number];

/**
 * Per-client branding. One row per client, created on first save.
 *
 * A separate table rather than columns on `clients` for one concrete reason:
 * `logo_wordmark` is a `bytea` that can run to a couple of hundred kilobytes,
 * and `clients` is selected in full on nearly every request — the client list,
 * every dashboard load, every API route. Putting a blob there would drag it
 * across the wire on every one of those. Here it is read only by the logo route.
 *
 * The field split is by OWNER, not by a precedence rule:
 *   client-editable (W3): displayName, logos, brandColor, reportContactLine
 *   agency-only:          brandColorAppliesToDashboard, clientEditable
 * A precedence rule is where "whose logo wins" becomes unanswerable; separate
 * fields cannot conflict.
 */
export const clientBranding = pgTable("client_branding", {
  clientId: uuid("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),

  /** Shown instead of `clients.name` on the dashboard and report. */
  displayName: text("display_name"),
  /**
   * The client's colour, ALREADY NORMALISED by `normalizeBrandColor` on write.
   *
   * Stored post-normalisation rather than raw so every reader gets a value that
   * is legible on both themes without re-deriving it — and so the value a staff
   * member sees echoed back is the value that will actually render.
   */
  brandColor: text("brand_color"),
  /** One line under the agency mark on a report — "Questions? hello@…". */
  reportContactLine: text("report_contact_line"),

  /** Wide logo for a header. PNG or SVG bytes. */
  logoWordmark: bytea("logo_wordmark"),
  logoWordmarkType: text("logo_wordmark_type"),
  /** Square mark, for the favicon-sized slot. */
  logoSquare: bytea("logo_square"),
  logoSquareType: text("logo_square_type"),
  /**
   * Cache-busting token for the logo URL.
   *
   * The logo route is cached hard — it is an image on every page load — so
   * without a version in the URL a replaced logo would keep serving the old
   * bytes from a CDN or browser cache for as long as the TTL, and the client
   * would reasonably conclude the upload failed.
   */
  logoVersion: integer("logo_version").notNull().default(0),

  /**
   * Whether the brand colour reaches the DASHBOARD, or only the report.
   *
   * Agency-controlled, deliberately. A client's brand red on a dashboard whose
   * status colours are red/amber/green is a legibility problem rather than a
   * preference, and the person who has to read the dashboard for forty clients
   * is the one who should decide.
   */
  brandColorAppliesToDashboard: boolean("brand_color_applies_to_dashboard")
    .notNull()
    .default(true),
  /** Per-client kill switch for W3's client-editable branding. */
  clientEditable: boolean("client_editable").notNull().default(false),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Who last wrote this — used for the "last edited by X" conflict message. */
  updatedBy: text("updated_by"),
});

export type ClientBrandingRow = typeof clientBranding.$inferSelect;

/**
 * Agency-wide settings. Exactly one row, id fixed to `SINGLETON`.
 *
 * 🔴 **Seeded on read, not by migration.** There is no migration runner in this
 * project — `package.json` has `db:generate`/`db:push` only, and `db:push`
 * diffs the schema without ever executing `drizzle/*.sql`. So any INSERT written
 * into a migration file would never run, and a reader expecting a seeded row
 * would find none. `getAgencySettings()` upserts on read instead.
 *
 * Validation lives in zod at the API boundary rather than in CHECK constraints,
 * for the same reason: a CHECK added by a later migration would not be applied.
 */
/**
 * Report branding, one row per agency.
 *
 * Was a hard singleton — `id text primary key default 'SINGLETON'` — which is
 * exactly the shape a single-tenant tool takes and exactly the shape that
 * cannot be shared. The primary key is now the tenant itself, so a second
 * agency's wordmark cannot overwrite the first's.
 *
 * `cascade` here, unlike `clients`: branding is reproducible from a logo file,
 * so there is nothing to strand.
 */
export const agencySettings = pgTable("agency_settings", {
  agencyId: uuid("agency_id")
    .primaryKey()
    .references(() => agencies.id, { onDelete: "cascade" }),
  /**
   * What to print on a report, when that differs from the tenant's own name in
   * `agencies.name` — a trading name, or a white-label. Null means use
   * `agencies.name`.
   */
  agencyName: text("agency_name"),
  agencyMarkMode: agencyMarkModeEnum("agency_mark_mode")
    .notNull()
    .default("prepared_by"),
  supportEmail: text("support_email"),
  logoWordmark: bytea("logo_wordmark"),
  logoWordmarkType: text("logo_wordmark_type"),
  logoVersion: integer("logo_version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AgencySettingsRow = typeof agencySettings.$inferSelect;

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
    /**
     * The tenant this event belongs to, or null for platform-level events.
     *
     * Nullable on purpose and permanently — a failed login for an unknown
     * address, or a sign-up throttled before any agency exists, genuinely has
     * no tenant, and a NOT NULL column would force those to be attributed to
     * somebody. Null rows are visible to superadmins only.
     *
     * `set null` rather than cascade: deleting a tenant must not delete the
     * record of what was done to it.
     */
    agencyId: uuid("agency_id").references(() => agencies.id, {
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
    // Carries the sort as well as the filter — the scoped read is always
    // "this agency, newest first, limit N".
    index("audit_log_agency_at_idx").on(t.agencyId, t.at.desc()),
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
    /**
     * The agency this login belongs to. NOT NULL, including for `superadmin`.
     *
     * A nullable tenant column is a trap: `WHERE agency_id = $1` silently
     * matches nothing when the parameter is undefined, so a scoping bug reads
     * as an empty dashboard rather than as an error — and the reviewer sees a
     * query that looks correctly scoped. Platform-wide reach is a property of
     * the ROLE, checked in one place, never the absence of a tenant.
     */
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "restrict" }),
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
    /**
     * When this address was proved to belong to whoever holds the account.
     *
     * Null means unproved, not "old account". Rows that predate self-serve
     * sign-up are stamped by the migration — they were created by hand, by
     * someone who already knew the person, which is a stronger proof than an
     * email round-trip and should not be re-demanded of them.
     */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * 🔴 GLOBALLY unique, not per-agency, and it has to stay that way.
     *
     * The login form asks for an email and a password and nothing else — there
     * is no tenant field and there should not be one, because a person should
     * not have to know their agency's slug to sign in. That makes the email the
     * sole lookup key, so two agencies holding the same address would make
     * "which account is this" unanswerable at exactly the moment it matters.
     */
    uniqueIndex("users_email_key").on(t.email),
    index("users_agency_idx").on(t.agencyId),
  ],
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
export type MetaAdCreative = typeof metaAdCreatives.$inferSelect;
export type NewMetaAdCreative = typeof metaAdCreatives.$inferInsert;
export type FbPeriodReach = typeof fbPeriodReach.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserClient = typeof userClients.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;

/* ------------------------------------------------------------------ *
 * share_links — "forward this to my board"
 * ------------------------------------------------------------------ *
 *
 * A read-only, expiring, revocable URL onto ONE client's report for ONE fixed
 * period. Four properties, each deliberate:
 *
 * 🔴 **The bearer token is never stored.** Only its SHA-256. A share URL grants
 * access to a client's spend and outcomes, so it is a credential, and a
 * credential kept in plaintext is one database read away from being everyone's.
 * The hash is what gets looked up; the token exists only in the URL the operator
 * copies once.
 *
 * **The period is frozen into the row, not resolved at view time.** A live link
 * would keep publishing to whoever holds the URL — so next quarter's collapse
 * reaches the board without anybody deciding to send it. The person forwarding a
 * report should be accountable for what is in it, which means it shows the range
 * they were looking at when they created it, permanently.
 *
 * **Expiry is mandatory, revocation is always available.** A URL that has been
 * forwarded cannot be un-forwarded; the only controls that survive are time and
 * a kill switch.
 *
 * **The password is optional and separate.** It raises a shared link from
 * "anyone with the URL" to "anyone with the URL and the phrase", which is the
 * difference that matters when a board pack gets attached to an email thread.
 */
export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /** SHA-256 (hex) of the bearer token. The token itself is never persisted. */
    tokenHash: text("token_hash").notNull(),

    /** Operator's own note — "July board pack". Shown in the manage list only. */
    label: text("label"),

    /** The frozen reporting period, in the client's timezone. */
    rangeStart: date("range_start").notNull(),
    rangeEnd: date("range_end").notNull(),
    /** Which ad platform's figures the link was created against. */
    platform: text("platform").notNull().default("meta"),

    /** scrypt hash, same scheme as user passwords. Null = no gate. */
    passwordHash: text("password_hash"),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set on revoke; the row is kept so the audit trail survives. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /*
     * Usage, so the operator can answer "did they ever open it?" and notice a
     * link being opened long after the meeting it was made for.
     */
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("share_links_token_hash_key").on(t.tokenHash),
    index("share_links_client_idx").on(t.clientId, t.createdAt),
  ],
);

export type ShareLink = typeof shareLinks.$inferSelect;

/* ------------------------------------------------------------------ *
 * dashboard_layouts — which sections a dashboard shows
 * ------------------------------------------------------------------ */

/**
 * Who a stored layout belongs to.
 *
 * 🔴 **The split is the isolation mechanism, not a nicety.** With one row per
 * client, a client hiding the campaign table would blind the agency on the same
 * page — and the agency would have no way to tell a hidden section from a broken
 * one. Two rows means each audience's view is theirs.
 */
export const layoutAudienceEnum = pgEnum("layout_audience", [
  "staff",
  "client",
]);
export type LayoutAudience = (typeof layoutAudienceEnum.enumValues)[number];

export const dashboardLayouts = pgTable(
  "dashboard_layouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    audience: layoutAudienceEnum("audience").notNull(),

    /**
     * `[{ id, visible }]`, already canonicalised.
     *
     * Strict on write, lenient on read: the API runs an incoming payload
     * through `resolveLayout` and persists the RESULT, so dedupe, bounding and
     * unknown-id removal happen once at the boundary rather than on every
     * render. Readers still go through `resolveLayout` again, because a row
     * written by an older deploy is exactly as untrusted as a request body.
     */
    sections: jsonb("sections").notNull(),

    /**
     * Shape version of `sections`.
     *
     * Read forward AND backward: a version AHEAD of this code means the row was
     * written by a newer deploy, and the only safe reading of a shape we have
     * never seen is to ignore it and render defaults. Guessing would render a
     * dashboard that silently omits sections.
     */
    schemaVersion: integer("schema_version").notNull().default(1),

    /**
     * The agency's per-client freeze. When true the client cannot change their
     * own layout — and, critically, cannot clear this flag either: the write
     * path reads it BEFORE parsing a body and refuses, so `{"locked":false}`
     * never gets a hearing.
     */
    locked: boolean("locked").notNull().default(false),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Powers the "last edited by X on DATE" line behind a 409 conflict. */
    updatedBy: text("updated_by"),
  },
  (t) => [
    // At most two rows per client — one per audience.
    uniqueIndex("dashboard_layouts_client_audience_key").on(
      t.clientId,
      t.audience,
    ),
  ],
);

export type DashboardLayoutRow = typeof dashboardLayouts.$inferSelect;

/* ------------------------------------------------------------------ *
 * report_summaries — the written weekly update
 * ------------------------------------------------------------------ */

export const summaryFramingEnum = pgEnum("summary_framing", [
  "summary",
  "wins",
  "issues",
  "recommendations",
]);
export type SummaryFraming = (typeof summaryFramingEnum.enumValues)[number];

/**
 * A written summary of one reporting period, in one framing.
 *
 * 🔴 **The draft and the published copy are separate columns, and that IS the
 * "never auto-publish" guarantee.** Not a flag someone could flip by accident,
 * not a policy in a prompt: generation writes `headline`/`body` and physically
 * cannot write the `published_*` pair, publishing is its own endpoint and its
 * own audit entry, and the client-facing report reads ONLY `published_body`.
 *
 * The consequence that matters most: regenerating can never change, or
 * withdraw, what a client has already been sent. A model rewriting a paragraph
 * behind a live share link would be the worst failure this feature could have,
 * and the shape of the table rules it out rather than guarding against it.
 *
 * One row per (client, platform, period, framing) — so "Wins" and "Issues" for
 * the same week are separate documents, and regenerating one replaces that one.
 */
export const reportSummaries = pgTable(
  "report_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /** Which dashboard the figures came from — the two are separate views. */
    platform: text("platform").notNull().default("meta"),
    /** The period described, in the client's timezone. */
    rangeStart: date("range_start").notNull(),
    rangeEnd: date("range_end").notNull(),
    framing: summaryFramingEnum("framing").notNull(),

    /** The working copy: generated, then freely edited by a person. */
    headline: text("headline").notNull(),
    body: text("body").notNull(),

    /**
     * Figures in the working copy that trace to nothing the metrics engine
     * produced. Stored rather than recomputed so the flag survives an edit and
     * a reload, and so "this went out with an unverified number in it" is
     * answerable after the fact.
     */
    verification: jsonb("verification"),
    /** Null once a person has edited the text — after that it is theirs. */
    generatedBy: text("generated_by"),
    model: text("model"),

    /** The frozen copy. Only `POST …/publish` ever writes these. */
    publishedHeadline: text("published_headline"),
    publishedBody: text("published_body"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    uniqueIndex("report_summaries_period_key").on(
      t.clientId,
      t.platform,
      t.rangeStart,
      t.rangeEnd,
      t.framing,
    ),
  ],
);

export type ReportSummaryRow = typeof reportSummaries.$inferSelect;

/* ------------------------------------------------------------------ *
 * monthly_commentary — what we did, what's next, and how last month went
 * ------------------------------------------------------------------ */

/**
 * One row per client per calendar month per platform.
 *
 * 🔴 **Keyed to a calendar month, not a date range — and that is the feature.**
 * `report_summaries` describes whatever window the reader is looking at, which
 * is right for a summary and useless for a promise: "last month we said we
 * would fix cost per lead" can only be answered if "last month" is a fixed
 * thing that next month's report can go and find. A commentary attached to
 * "the trailing 30 days" would be unreachable a month later.
 *
 * ── What lives in which column, and why `outcomes` is here and not there ──
 *
 * The row for August holds:
 *
 *   `did`         — what we did in August
 *   `commitments` — what we will do in September
 *   `outcomes`    — how JULY's commitments turned out
 *
 * The last one is the part worth explaining. Recording July's results against
 * July's row would mean editing a document the client has already been sent —
 * and a published report that changes after the fact is the one thing this
 * whole draft/published split exists to prevent. August's row answering July's
 * plan leaves July frozen exactly as it was read.
 *
 * The published columns mirror `report_summaries` for the same reason: a
 * half-written note must not appear behind a live share link, and the guarantee
 * is a separate column rather than a status flag so no single careless write can
 * defeat it.
 */
export const monthlyCommentary = pgTable(
  "monthly_commentary",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().default("meta"),

    /** `yyyy-MM` in the client's timezone. Sorts chronologically as text. */
    month: text("month").notNull(),

    /** The working copy: freely edited, never client-visible. */
    did: text("did").notNull().default(""),
    /** `Commitment[]` — the plan for the FOLLOWING month. */
    commitments: jsonb("commitments").notNull().default([]),
    /** `Outcome[]` — answers to the PREVIOUS month's commitments. */
    outcomes: jsonb("outcomes").notNull().default([]),

    /** The frozen copy. Only `POST …/commentary/publish` writes these. */
    publishedDid: text("published_did"),
    publishedCommitments: jsonb("published_commitments"),
    publishedOutcomes: jsonb("published_outcomes"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    uniqueIndex("monthly_commentary_month_key").on(
      t.clientId,
      t.platform,
      t.month,
    ),
  ],
);

export type MonthlyCommentaryRow = typeof monthlyCommentary.$inferSelect;

/* ------------------------------------------------------------------
 * Budgets
 * ------------------------------------------------------------------ */

/**
 * What the client agreed to spend per month, per platform.
 *
 * The dashboard can already say what was spent. It cannot say whether that was
 * the RIGHT amount, and both directions of wrong cost an agency the account:
 * overspending bills the client money they did not agree to, underspending
 * means media they paid for never ran — and the second is the one that hides,
 * because nothing is broken, no check goes red, the numbers are simply smaller
 * than they should be and nobody notices until the invoice.
 *
 * ── Why `effective_from` and not one row per month ────────────────────
 *
 * A budget is a standing agreement, not a monthly fact: "£4,000 a month from
 * March" holds until it is renegotiated. One row per month would need a new row
 * every month forever, and the failure when someone forgets is silent — the
 * month simply has no budget and pacing goes blank on the exact surface that
 * exists to be looked at.
 *
 * So a row here means "from this month onward, until superseded". Amending
 * history is then possible but never accidental, which also keeps PAST pacing
 * honest: a client who moved from £2k to £4k in June should still show June
 * judged against £2k, and a single mutable "monthly budget" column on `clients`
 * could not do that — it would silently restate every past month to today's
 * figure and turn a hit target into a miss.
 *
 * Amounts are in the AD ACCOUNT's currency, deliberately without a currency
 * column: pacing compares this number against spend from that account, so a
 * budget denominated in anything else is not a display problem but a wrong
 * answer. See `src/lib/metrics/pacing.ts`.
 */
export const adBudgets = pgTable(
  "ad_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().default("meta"),

    /** `yyyy-MM` in the client's timezone. Sorts chronologically as text. */
    effectiveFrom: text("effective_from").notNull(),

    /**
     * Monthly amount, in the ad account's currency.
     *
     * `numeric`, like every other money column here — a float would drift on
     * exactly the arithmetic pacing does (divide by days, multiply back up).
     * Nullable is NOT the same as absent: a row with a null amount is an
     * explicit "no budget from this month", which is how a client who stops
     * committing to a monthly figure is recorded without deleting the history
     * of what they used to commit to.
     */
    monthlyAmount: numeric("monthly_amount", { precision: 14, scale: 2 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    uniqueIndex("ad_budgets_effective_key").on(
      t.clientId,
      t.platform,
      t.effectiveFrom,
    ),
  ],
);

export type AdBudget = typeof adBudgets.$inferSelect;

/* ------------------------------------------------------------------
 * Scheduled report delivery
 * ------------------------------------------------------------------ */

/**
 * Who gets a report by email, how often.
 *
 * One row per client per platform, matching how the dashboard is scoped: a
 * client running both Facebook and Google gets two schedules, because the two
 * are separate views with separate numbers and merging them into one email
 * would produce a report whose totals match neither dashboard.
 */
export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().default("meta"),

    enabled: boolean("enabled").notNull().default(false),
    /** `weekly` | `monthly`. */
    cadence: text("cadence").notNull().default("monthly"),
    /** Hour in the CLIENT's timezone, so a report lands at their breakfast. */
    sendHour: integer("send_hour").notNull().default(8),

    recipients: text("recipients").array().notNull().default([]),

    /**
     * `period.key` of the last successful send — the end date of the period,
     * not the instant it was sent.
     *
     * 🔴 Keyed by PERIOD rather than by time, so a cron firing five times in an
     * hour sends once. A timestamp would only tell us when we last tried, which
     * says nothing about whether this period has been covered.
     */
    lastSentPeriod: text("last_sent_period"),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    /** Set when a send fails, cleared on the next success. Surfaced in the UI. */
    lastError: text("last_error"),

    /** Days the emailed share link stays open. */
    linkTtlDays: integer("link_ttl_days").notNull().default(30),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    uniqueIndex("report_schedules_client_platform_key").on(
      t.clientId,
      t.platform,
    ),
  ],
);

export type ReportSchedule = typeof reportSchedules.$inferSelect;

/**
 * Every send attempt, successful or not.
 *
 * Append-only, and the unique constraint is the idempotency guarantee rather
 * than a tidiness measure: two cron invocations racing — which happens whenever
 * a run is retried — must produce one email, and the database is the only place
 * that can be decided. The insert is attempted BEFORE the email goes out, so a
 * duplicate loses the race and never sends.
 */
export const reportSends = pgTable(
  "report_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().default("meta"),

    /** The period covered — `period.key`, i.e. its end date. */
    periodKey: text("period_key").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    recipients: text("recipients").array().notNull().default([]),
    /** The share link the email pointed at, so it can be revoked later. */
    shareLinkId: uuid("share_link_id"),

    /** `sending` | `sent` | `failed`. */
    status: text("status").notNull().default("sending"),
    /** Provider message id, when it gave one. */
    providerId: text("provider_id"),
    error: text("error"),
    /** Periods that went by without a report, named rather than hidden. */
    skippedPeriods: text("skipped_periods").array().notNull().default([]),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    /*
     * 🔴 PARTIAL — failed rows are excluded from the constraint.
     *
     * The unique index is the idempotency mechanism: the send path inserts
     * before it emails, so two racing cron invocations both compute the same
     * period and exactly one wins. But a FAILED attempt must not hold the
     * period hostage — with an unconditional constraint, one transient provider
     * outage would permanently block that period from ever being retried, and
     * the report would simply never arrive.
     *
     * Excluding failures gives both properties at once: at most one live or
     * successful send per period, and as many failed attempts as it takes,
     * every one of them kept as history.
     */
    uniqueIndex("report_sends_period_key")
      .on(t.clientId, t.platform, t.periodKey)
      .where(sql`status <> 'failed'`),
  ],
);

export type ReportSend = typeof reportSends.$inferSelect;

/* ------------------------------------------------------------------
 * TikTok Ads
 * ------------------------------------------------------------------ */

/**
 * A TikTok advertiser account attached to a client.
 *
 * 🔴 The access token is stored per ACCOUNT rather than globally, unlike Meta's
 * system-user token. TikTok's `/oauth2/access_token/` returns one token per
 * authorising user, scoped to the advertisers that user can reach, and
 * `/oauth2/advertiser/get/` enumerates them. Two clients authorising separately
 * therefore hold two unrelated tokens, and there is no agency-wide equivalent to
 * fall back on.
 *
 * TikTok access tokens do not expire — the one genuinely easier thing about this
 * integration — but they ARE invalidated when the authorising user's access is
 * revoked, so a null-token row is a normal state and not a bug.
 */
export const tiktokAdAccounts = pgTable(
  "tiktok_ad_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /** TikTok advertiser id, digits only. */
    advertiserId: text("advertiser_id").notNull(),
    advertiserName: text("advertiser_name"),

    /** Encrypted at rest, same scheme as the GHL and Meta tokens. */
    accessTokenEncrypted: text("access_token_encrypted"),

    currency: text("currency"),
    /** The advertiser's own timezone — TikTok buckets days in it, as Meta does. */
    timezone: text("timezone"),

    /** `active` | `paused` | `removed`, mirroring the Meta account states. */
    status: text("status").notNull().default("active"),

    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("tiktok_ad_accounts_key").on(t.clientId, t.advertiserId)],
);

export type TiktokAdAccount = typeof tiktokAdAccounts.$inferSelect;

/**
 * Daily TikTok spend, per campaign.
 *
 * Deliberately the same shape as `google_daily_metrics` rather than
 * `fb_daily_metrics`: TikTok's reporting API has no equivalent of Meta's
 * `reach` (deduplicated people over a period), so there is no non-additive
 * metric here and no period table to go with it. Storing a `reach` column we
 * could never populate correctly would invite someone to sum it.
 */
export const tiktokDailyMetrics = pgTable(
  "tiktok_daily_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),

    /** Part of the unique key, so two advertisers cannot collide on a date. */
    advertiserId: text("advertiser_id").notNull().default(""),

    date: date("date").notNull(),
    /** Empty string for account-level rows — never null, which would defeat
     *  the unique index exactly as it would on the other two metric tables. */
    tiktokCampaignId: text("tiktok_campaign_id").notNull().default(""),
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
    uniqueIndex("tiktok_daily_metrics_key").on(
      t.clientId,
      t.advertiserId,
      t.date,
      t.tiktokCampaignId,
    ),
  ],
);

export type TiktokDailyMetric = typeof tiktokDailyMetrics.$inferSelect;
