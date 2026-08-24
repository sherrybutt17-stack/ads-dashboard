# Facebook Ads + GHL Live KPI Dashboard

> **Status: built, not yet connected.** All code is written and verified
> (typecheck, lint, production build, 33 tests). Nothing runs until credentials
> are supplied — see `SETUP.md`.
>
> **Changes made after this plan was approved**, in build order:
> - GHL wiring switched from workflow webhooks to a **private marketplace OAuth
>   app** — workflows cannot be created via API (GHL's entire workflows product
>   is a single read-only `GET /workflows/`; no `workflows.write` scope exists),
>   so the app is the only route to zero-touch client onboarding. Per-token
>   workflow webhooks remain supported as a fallback.
> - Database layer supports **Neon or Supabase**, driver picked from the
>   connection string. Neon chosen.
> - **Client timezone is auto-adopted** from the Meta ad account rather than
>   warned about — Meta buckets days in the ad account's timezone and offers no
>   alternative, so it is the authority.
> - **Paid-lead filter added** (`clients.paidLeadFilter`): cost metrics divide
>   spend only by leads with a Meta campaign ID *or* a configurable GHL tag.
>   Counting every pipeline lead understated true paid CPL.
> - Trend chart is **two stacked panels, not dual-axis**.
> - `costPer()` returns null when spend is 0 but conversions exist — the
>   "$0.00 CP-LEAD" failure visible in the source sheet's May–Jun 2026 rows.

---

## Context

The agency currently reports client KPIs through a Google Sheet
(`Parfaire Medical Aesthetics 111 - Overall.csv` — 51 rows × 158 columns, seven
report blocks laid side by side). It is a dead artifact: manually refreshed,
`SHOWN` is 0 for every month in its history despite 13 appointments and 3 closed
deals, `PIX LEADS`/`PC LEADS` are 0 across all 391 leads, and May–Jun 2026 record
25 leads against $0.00 spend. Six of its seven blocks contain no data at all.

**The sheet is the specification for the output, not the data source.** We are
replacing it with a live, multi-client web dashboard that looks and functions
like it, fed by two real pipes:

1. **GoHighLevel** — every lead and every pipeline stage movement, in near real
   time, via webhook.
2. **Meta Marketing API** — Reach, Impressions, Link Clicks, CTR, Spend pulled on
   a nightly schedule per ad account.

The agency adds clients from the dashboard UI; each client gets its own
dashboard, its own GHL sub-account wiring, and its own Meta ad account.

### The finding that shapes the whole architecture

**GoHighLevel has no stage-transition history API.** Verified against GHL's
published OpenAPI specs (v2 and v3) — no `history`, `timeline`, `audit`, or
`activity` path exists on opportunities. GHL's own idea board carries open,
unshipped requests for exactly this feature. The only retrievable signal is
`lastStageChangeAt`: **one** prior data point per opportunity.

Consequences, which are not negotiable:

- Funnel history **cannot be backfilled**. It can only be accumulated forward.
- **Every day the webhook receiver is not live is a day of funnel history
  destroyed permanently.** "How many leads moved New → Contacted in March" is
  answerable only if something was recording in March.
- The app must be the **system of record** for stage history. This is why a
  database is mandatory rather than a convenience.

Getting the webhook receiver deployed is therefore the highest-priority task in
this plan, ahead of any UI work.

---

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Hosting | **Vercel + Neon Postgres** | Public HTTPS URL for webhooks, built-in Cron, free at this volume |
| Database | **Neon Postgres — explicitly not Google Sheets** | See below |
| GHL wiring | **Private marketplace OAuth app** | Webhook URL configured ONCE on the app; every installing sub-account then streams events with zero per-client setup. Workflow webhooks remain as a fallback |
| Scope | **Multi-client from day one** | Clients added from the UI, each with its own dashboard + ad account |
| Meta auth | **System User token, `ads_read`** | Never expires; correct for an unattended nightly job |
| Meta refresh | **Stale-while-revalidate on page load (15 min) + nightly reconciliation** | See below |
| App auth | **Shared password via middleware** | Sensible default; per-client logins are a later upgrade |

### Why Postgres and not Google Sheets

Sheets fails on this specific workload:

- **No unique constraints → no idempotency.** GHL retries webhooks ~12× with
  jitter, at-least-once and unordered. Postgres collapses retries via a unique
  `dedupe_key`; Sheets appends a duplicate row per retry and inflates funnel
  counts silently.
- **No concurrency control.** Simultaneous stage-change webhooks clobber each
  other's writes. There is no transaction to wrap them in.
- **Quotas.** ~60 writes/min per user — a busy lead day plus multi-client syncing
  exceeds it, and the failure mode is dropped data.
- **The core query.** "Distinct opportunities entering `appointment_booked`
  between two dates in the client's timezone" is one indexed SQL query; in Sheets
  it is a fragile array formula that degrades every month.

A spreadsheet that silently stopped populating is the problem being replaced.

### Meta refresh cadence

Meta refreshes insights roughly every 15 minutes, so that cadence is meaningful.
A 15-minute cron is 96 runs/day and requires Vercel Pro. Instead:

- **On dashboard load**, check `last_synced_at`. Older than 15 minutes → fire a
  background sync for the current day, serve cached data immediately, update when
  it lands. No user waits, and no API calls are burned on dashboards nobody
  opens.
- **One nightly cron** performs the trailing 7-day re-pull that captures Meta's
  restatements (§ Constraints). This fits the free tier.
- A per-client sync lock prevents concurrent viewers triggering duplicate syncs.

### Stack

Next.js 15 (App Router, TypeScript, `src/`) · Tailwind · Drizzle ORM ·
`@neondatabase/serverless` · Vercel Cron · Recharts.

---

## Constraints discovered in research

These are researched facts, not assumptions. Each one changes the code.

### Meta

- **Day buckets follow the ad account's timezone**, not UTC and not the server's.
  Read it from `GET /v25.0/act_{id}?fields=timezone_id,timezone_name,currency`.
- **The requested 11:59pm job is wrong and must be adjusted.** Insights refresh
  every 15 minutes and keep updating for up to 28 days as attribution windows
  fill. A hard 11:59pm cutoff permanently freezes incomplete numbers. **Correct
  job: run ~02:00 account-local, pull *yesterday*, and re-pull a trailing 7-day
  window each night, upserting.** The dashboard then self-heals instead of
  drifting from Ads Manager. Rows younger than 28 days are flagged provisional.
- **`reach` is deduplicated people and cannot be summed across days.** Adding 30
  daily reach values overstates monthly reach 2–5×. Every aggregate period needs
  its own query — hence a separate `fb_period_reach` table. Same applies to
  `frequency` and `cpp`. Impressions, clicks, spend, and action counts *are*
  additive.
- **Link clicks: `inline_link_clicks` is pinned to a 1-day-click window** and will
  read lower than the Ads Manager "Link clicks" column, which respects the
  account's attribution setting (default 7d click + 1d view). Use
  `actions[action_type=link_click]` with `use_unified_attribution_setting=true`
  to match what the client sees. Store both.
- **Leads: do not sum the lead action types.** `lead` already contains
  `onsite_conversion.lead_grouped` and `offsite_conversion.fb_pixel_lead`.
  Double-counting here is the most common lead-reporting bug.
- All numeric metrics return as **JSON strings**. Cast on ingest.
- `actions` is **sparse** — zero-activity types are absent and the whole key can
  be missing. Filter by `action_type`, default to 0. Never index positionally.
- Pin the API version in every URL (`v25.0`); expired versions silently fall back
  to an older one rather than erroring. Marketing API versions last ~12 months.

### GoHighLevel

- The opportunity webhook payload carries **no previous stage, no stage name (id
  only), and no event timestamp** (`dateAdded` is the opportunity's creation
  date). We must diff against our own stored state to derive a transition.
- `pipelineStageId` is a **UUID** while `id`/`pipelineId`/`contactId` are 20-char
  base62. Do not assume a uniform id format.
- **No webhook carries attribution.** Join via `contactId` → `GET /contacts/{id}`
  → `attributionSource` / `lastAttributionSource`.
- Webhooks retry ~12 times with jitter: delivery is **at-least-once and
  unordered**. Processing must be idempotent and must not assume arrival order.
- Signature verification is mid-migration: `X-GHL-Signature` (Ed25519) is
  current; `X-WH-Signature` (RSA-SHA256) is deprecated 2026-09-01. Workflow
  webhooks may carry neither — hence the per-client secret URL token below.

### Attribution — the known weak point

GHL does **not** natively store Meta ad IDs. Its own recommended workaround joins
on campaign *names*, which breaks the instant anyone renames a campaign.

`attributionSource.campaignId` does hold the Meta numeric campaign ID when UTMs
are set up. The parser appears to be query-parameter-name driven, so appending
`ad_id={{ad.id}}&ad_group_id={{adset.id}}` should populate `adId`/`adGroupId` —
**this is an inference and is the first thing to verify empirically.**

Native Lead Ad forms have no UTM path at all; those need
`{{contact.facebookLeadId}}` resolved against the Meta API.

**Resolved:** the operator will add UTM parameters when building campaigns, so
per-campaign attribution is expected to work for all *new* campaigns. Two
caveats to keep in mind:

- **Historical leads stay unattributed.** Contacts already in GHL have no
  campaign ID and cannot be retroactively assigned one. Per-campaign breakdowns
  begin from the first UTM-tagged campaign forward; the dashboard must label
  pre-UTM leads as "Unattributed" rather than silently dropping or
  misassigning them.
- **Native Lead Ad forms bypass UTMs entirely.** If any campaign uses Instant
  Forms rather than driving to a landing page, those leads arrive with no
  attribution regardless of URL parameters, and need the
  `{{contact.facebookLeadId}}` → Meta API path instead.

The "Attribution flowing" health check (§2) exists to catch a UTM setup that was
intended but not actually applied.

---

## Schema

`src/db/schema.ts` (Drizzle). Canonical stage enum, fixed across all clients:

```
new_lead · contacted · appointment_booked · showed · no_show · closed_won · lost
```

| Table | Purpose | Key columns |
|---|---|---|
| `clients` | One row per client | `slug`, `timezone`, `ghl_location_id`, `meta_ad_account_id`, `meta_token_override` (nullable, for a different Business Manager), `webhook_token` (unique random), `status` |
| `pipeline_stages` | Maps each client's GHL stage IDs → canonical stages | `client_id`, `ghl_pipeline_id`, `ghl_stage_id`, `ghl_stage_name`, `canonical_stage`, `display_order` |
| `contacts` | Leads + attribution | `ghl_contact_id`, contact fields, `utm_*`, `meta_campaign_id`, `meta_adset_id`, `meta_ad_id`, `fbclid`, `raw_attribution` jsonb |
| `opportunities` | Current state | `ghl_opportunity_id`, `contact_id`, `current_stage_id`, `status`, `monetary_value`, `last_stage_change_at` |
| **`stage_transitions`** | **Append-only ledger — the irreplaceable data** | `opportunity_id`, `from_stage_id` (nullable), `to_stage_id`, `from_canonical`, `to_canonical`, `changed_at`, `source` (`webhook`\|`backfill_snapshot`), `dedupe_key` (unique) |
| `webhook_events` | Raw payload log | `client_id`, `received_at`, `headers`, `payload`, `status`, `error` — enables replay if processing logic has a bug |
| `fb_daily_metrics` | Nightly Meta pull | unique on `(client_id, date, level, meta_campaign_id)`; `reach`, `impressions`, `clicks_all`, `link_clicks`, `spend`, `leads_total`, `leads_pixel`, `leads_onsite`, `is_provisional` |
| `fb_period_reach` | Non-additive reach per period | unique on `(client_id, period_start, period_end, meta_campaign_id)` |
| `sync_runs` | Observability | `kind`, `started_at`, `status`, `rows_written`, `error` |

Two schema notes that matter:

- **`pipeline_stages` is what makes this multi-tenant.** The GHL webhook sends
  only a stage UUID, and every client names and orders their stages differently.
  This table is the translation layer; without it, funnel logic would be
  hardcoded per client.
- **Store raw metrics, derive ratios at query time.** Never store CTR/CPC/CPM —
  they must be recomputed from summed components, because averaging a ratio
  across days is wrong.

---

## Implementation

### 1 · Webhook receiver — build first, deploy first

`src/app/api/webhooks/crm/[token]/route.ts`

Each client gets a unique unguessable `webhook_token` in its URL. This routes the
event to the right tenant without parsing GHL's loosely-shaped workflow payload,
and doubles as the shared secret (workflow webhooks may carry no signature
header).

Processing order, all inside one transaction:

1. Persist the raw payload to `webhook_events` **before** any parsing, and return
   `200` fast. A parse failure must never cause GHL to retry-storm us, and the
   raw row lets us replay after a logic fix.
2. Resolve `token` → client. Unknown token → `404`, still logged.
3. Upsert contact and opportunity.
4. Read the opportunity's stored `current_stage_id`. If it differs from the
   incoming `pipelineStageId`, append a `stage_transitions` row with
   `from_stage_id` = stored, `to_stage_id` = incoming.
5. `changed_at`: re-read `lastStageChangeAt` via `GET /opportunities/{id}` — the
   payload has no event timestamp and this is the authoritative value. Fall back
   to receipt time.
6. `dedupe_key` = `(opportunity_id, to_stage_id, changed_at)`, unique-constrained.
   Delivery is at-least-once, so retries must collapse rather than duplicate.

Also handle an unmapped `pipelineStageId` (client added a stage in GHL): record
the transition, flag the stage as unmapped, and surface it in settings for the
operator to map. Never drop the event.

### 2 · Client onboarding + connection health checklist

- `src/app/page.tsx` — client list, each row showing a live connection-health
  badge, plus "Add client"
- `src/app/c/[slug]/page.tsx` — that client's dashboard
- `src/app/c/[slug]/setup/page.tsx` — the connection wizard and checklist
- `src/app/api/clients/route.ts` — CRUD
- `src/app/api/clients/[id]/health/route.ts` — runs the live checks below

**Add-client wizard**, step by step, each step verifying before advancing:

1. **Client basics** — name, slug, timezone.
2. **Connect GHL** — paste the sub-account Private Integration Token + location
   ID. Immediately call `GET /locations/{id}` to prove the token works and the
   location resolves; show the returned business name back as confirmation.
3. **Map pipeline stages** — fetch that client's pipelines and stages from GHL,
   present their real stage names in a dropdown UI mapping to our seven canonical
   stages. Cannot proceed until every canonical stage is mapped or explicitly
   marked unused.
4. **Connect Meta ad account** — enter the ad account ID; verify by calling
   `GET /v25.0/act_{id}?fields=name,currency,timezone_name`. Display the returned
   name/currency/timezone so a wrong account ID is caught immediately. Optional
   per-client token override for accounts in a different Business Manager.
5. **Install the webhook** — display the generated
   `/api/webhooks/crm/{token}` URL with copy-paste GHL setup instructions, then
   **wait for a live event**: the page polls until the first real webhook lands,
   showing "Waiting for first event…" → "✅ Received". This is what proves the
   pipe actually works rather than merely looking configured.

**Persistent health checklist** — the same checks rerun on demand and surface on
the client list. This exists specifically because the current sheet's silent
failure (six empty blocks, `SHOWN` = 0 forever, leads with $0 spend) went
unnoticed for months. Each row is green/amber/red with a "Re-test" button:

| Check | Passing means |
|---|---|
| GHL token valid | `GET /locations/{id}` returns 200 |
| Stage mapping complete | Every canonical stage has a GHL stage bound |
| No unmapped stages seen | No webhook has arrived carrying an unknown stage id |
| Webhook alive | An event received within the expected window |
| Meta token valid | Ad account read returns 200 |
| Meta data fresh | `last_synced_at` within threshold; last `sync_runs` row succeeded |
| Spend/lead coherence | **Not** (spend = 0 while leads > 0), nor the inverse — the exact corruption visible in the current sheet's May–Jun 2026 rows |
| Attribution flowing | ≥1 contact in the last 30 days carrying a `meta_campaign_id` — proves the UTM setup is live |

Amber (degraded) is distinct from red (broken): an ad account legitimately paused
should read amber "no spend — ads paused", never a green that hides a dead pipe.

### 3 · Meta sync

- `src/lib/meta/client.ts` — typed API wrapper: `appsecret_proof` on every call,
  reads `X-Business-Use-Case-Usage` and `x-fb-ads-insights-throttle`, backs off
  at ~80% utilization, honors `estimated_time_to_regain_access`. Serializes
  per-account calls rather than firing in parallel.
- `src/lib/meta/sync.ts` — for one client: resolve account timezone, pull
  `level=campaign&time_increment=1` over a trailing 7-day window, upsert into
  `fb_daily_metrics`; issue **separate** queries for each aggregate period's
  reach into `fb_period_reach`.
- `src/lib/meta/refresh.ts` — the stale-while-revalidate path. Called on
  dashboard load: if `last_synced_at` > 15 min, take a per-client advisory lock
  and sync the current day in the background. Serves cached data immediately.
- `src/app/api/cron/meta-sync/route.ts` — nightly reconciliation, the trailing
  7-day re-pull. Iterates clients whose local time has just passed the sync hour.
  Guarded by `CRON_SECRET`.

Reference call shape (verified against v25.0):

```
GET /v25.0/act_{id}/insights
  ?level=campaign&time_increment=1
  &time_range={"since":"...","until":"..."}
  &fields=campaign_id,campaign_name,account_currency,reach,frequency,
          impressions,clicks,ctr,cpc,inline_link_clicks,
          inline_link_click_ctr,spend,cpm,actions,cost_per_action_type
  &use_unified_attribution_setting=true
```

> ⚠️ **Vercel Cron note:** the Hobby tier permits one cron run per day, which
> cannot serve clients across multiple timezones correctly. Either run on Pro
> (hourly) or, on Hobby, pin a single UTC hour that is ~02:00 for the clients'
> shared timezone. Decide before onboarding clients in different regions.

### 4 · Metrics engine

`src/lib/metrics/` — pure functions, unit-testable, no I/O.

Funnel counts come from the ledger: a period's `APPTS` is the count of **distinct
opportunities whose transitions entered `appointment_booked`** within the window.
Distinct-opportunity rather than raw-transition, so a lead bounced back and forth
between stages is counted once — that is what makes cost-per-appointment
economically meaningful.

Derived metrics, every one guarded against divide-by-zero → `null`, rendered as
`-` exactly as the sheet does:

```
CP-LEAD = spend / leads          BOOK %  = appts / leads
CP-APPT = spend / appts          SHOW %  = shown / appts
CP-SHOW = spend / shown          CLOSE % = won / shown
CP-WON  = spend / won            OPTIN % = leads / link_clicks
CTR = link_clicks / impressions  CPM = spend / impressions × 1000
CPC = spend / link_clicks
```

The four sheet views, plus the requested custom range:

1. **Moving averages** — 3 / 7 / 14 / 30 / 60 / 90-day windows
2. **7-day change** — last 7 vs previous 7, with % change
3. **14-day daily report** — one row per day
4. **Month-on-month** — one row per calendar month, trailing 12
5. **Custom date+time range picker**, recomputing all metrics live

All windows are computed in the **client's timezone**, not the server's.

### 5 · Dashboard UI — premium, and readable at a glance

`src/app/c/[slug]/page.tsx` plus `src/components/`.

**Design intent:** the sheet's *information* without the sheet's *presentation*.
158 columns of undifferentiated numbers is why nobody noticed six blocks were
empty. The rebuild keeps every metric but establishes a visual hierarchy — the
numbers that drive decisions read first, supporting detail recedes, and broken or
stale data is impossible to miss.

**Load two skills before writing any UI code** — this is a required step, not a
suggestion:

- **`artifact-design`** — calibrate the overall design investment, layout system,
  and typographic scale before building components.
- **`dataviz`** — read *before* the first line of chart code or any color choice.
  It supplies the form heuristic, a validated accessible palette that works in
  both light and dark, mark specs, stat-tile/KPI-row patterns, and a color
  formula with a runnable validator. This is what keeps trend lines, the funnel,
  and the stat tiles reading as one system instead of Recharts defaults.

**Layout, top to bottom:**

1. **Headline KPI row** — Spend, Leads, Cost per Lead, Appointments, Shows,
   Closed/Won. Large numerals, each with its sparkline and period-over-period
   delta (green/red with directionality that respects metric polarity — a falling
   cost-per-lead is *good* and must render as such).
2. **The funnel** — the seven stages as a proportioned visual, with conversion
   rate and drop-off annotated between each pair. This is the view that answers
   "where are we losing people," which the sheet could not show at all.
3. **Trend chart** — spend and leads over the selected range as **two stacked
   panels sharing an x-axis, not a dual axis** (see the change note at the top).
   A dual axis lets two arbitrary scales sit side by side, so any apparent
   correlation between dollars and lead counts is an artifact of where the axes
   were placed. Each panel also carries a dashed ghost of the previous period.
4. **The four report tables** — moving averages, 7-day change, 14-day daily,
   month-on-month. Collapsible, dense but properly typeset: tabular numerals,
   right-aligned figures, `-` for undefined, subdued zero states.
5. **Campaign breakdown** — per-campaign rows once UTM attribution is live.

**Craft details that carry the "premium" read:** tabular-figure font for all
numerics so columns align optically; restrained palette with a single accent;
generous whitespace around the KPI row and density only where density earns its
place (the tables); skeleton loaders rather than spinners; smooth number
transitions on refresh; full light/dark support; responsive down to tablet with
wide tables scrolling inside their own container rather than breaking the page.

**Date/time range picker** in the header with presets (Today, 7d, 14d, 30d, 90d,
MTD, Custom), recomputing every metric live in the client's timezone.

**Honest empty states.** A paused ad account must render as a deliberate "No
spend in this period — ads paused" state, visually distinct from "we cannot
reach Meta." Conflating those two is precisely how the current sheet misled.

### 6 · Auth

`src/middleware.ts` — shared-password gate over all routes except
`/api/webhooks/*` (must stay public for GHL) and `/api/cron/*` (guarded by
`CRON_SECRET` instead). Per-client logins are a later upgrade.

---

## Environment

```
DATABASE_URL              # Neon connection string
META_APP_ID
META_APP_SECRET
META_SYSTEM_USER_TOKEN    # never expires; default for all clients
META_API_VERSION=v25.0
CRON_SECRET
DASHBOARD_PASSWORD
ENCRYPTION_KEY            # encrypts per-client tokens at rest
```

Per-client credentials (GHL Private Integration Token, optional Meta token
override) are **entered through the onboarding wizard and stored encrypted in
the `clients` table** — not in env vars, since clients are added at runtime from
the UI.

---

## Manual setup outside the code

Documented in `SETUP.md`, since these gate the pipes and cannot be automated:

1. **Meta** — create app → System User in Business Manager → assign to the ad
   account → generate a non-expiring `ads_read` token. No App Review needed while
   the token holder has a role on the app and access to the account.
2. **GHL, per sub-account** — create a Workflow, trigger "Pipeline Stage
   Changed" (plus one on contact creation), add a Webhook (Outbound) action
   pointing at that client's `/api/webhooks/crm/{token}` URL.
3. **Ad URL parameters** — append `utm_campaign={{campaign.name}}`,
   `campaign_id={{campaign.id}}`, `ad_id={{ad.id}}`, `ad_group_id={{adset.id}}`
   to each ad, so GHL captures a real campaign ID per contact. **Required for
   per-campaign cost breakdowns.**

---

## Build order

Deliberately sequenced so the irreplaceable data starts accumulating on day one,
before any UI exists.

1. Scaffold + schema + migrations
2. Client CRUD + onboarding wizard + stage mapping UI
3. **Webhook receiver → deploy to Vercel → wire one GHL workflow → verify a real
   stage change lands in `stage_transitions`.** History starts here — everything
   before this point is preparation, everything after is recoverable.
4. GHL backfill: one synthetic transition per existing opportunity from
   `lastStageChangeAt`, marked `source='backfill_snapshot'` — establishes the
   floor of what is knowable.
5. Meta client + stale-while-revalidate refresh + nightly reconciliation +
   backfill trailing 90 days
6. Metrics engine + unit tests
7. Connection health checklist
8. **Load `artifact-design` and `dataviz` skills**, then build the dashboard UI +
   date range picker
9. `SETUP.md`

---

## Verification

**Webhook** — move a real opportunity between stages in GHL; confirm a
`stage_transitions` row appears with correct `from`/`to`/`changed_at`. Replay the
same `webhook_events` payload twice and confirm the unique `dedupe_key` collapses
it to one row (proves at-least-once delivery is safe).

**Meta** — run the sync for a known date range and reconcile `spend`,
`impressions`, and `link_clicks` against Ads Manager for the same account and
window. Confirm the account timezone is respected by checking a day boundary.
Confirm summed daily reach ≠ the separately-queried period reach (this
difference is expected and proves the non-additive handling is real).

**Metrics** — unit tests over a fixture ledger asserting each derived metric,
including divide-by-zero → `-`. Regression test the real numbers from the CSV:
Dec 2025 = $364.45 spend / 65 leads / $5.61 CP-LEAD / 2 won.

**End to end** — create a client through the onboarding wizard, map stages, paste
the webhook URL into GHL, generate a test lead, watch it appear in the dashboard,
advance it through all seven stages, confirm each shows in the funnel and that
cost-per-stage recomputes.

**Health checklist** — deliberately break each pipe and confirm the checklist
catches it and reports the *correct* failure: revoke the GHL token (→ red, token
invalid), point at a nonexistent ad account (→ red), pause the ad account (→
amber "ads paused", **not** red and **not** green), delete a stage mapping (→
red, unmapped stage). This is the check that the current sheet lacked entirely.

**Refresh behavior** — load a dashboard twice within 15 minutes and confirm only
one Meta sync fires (the lock holds); wait past the window and confirm a reload
triggers a background refresh without blocking render.

**Empirical checks to run before trusting the data** (flagged as unverified in
research):
- Whether `ad_id`/`ad_group_id` URL params actually populate
  `attributionSource.adId` — the highest-value unknown in this build.
- Whether `actions:link_click` or `inline_link_clicks` matches the client's Ads
  Manager column, given their attribution setting.
- The element shape of `pipelines[].stages[]` — genuinely unpublished; GHL's own
  PHP SDK types it `array<array<mixed>>`.

---

## Out of scope for v1

Google Ads (the sheet's empty `GOOGLE - OVERALL` block), the `SEMINAR CAMPAIGN`
block's different schema (`SHOWN EVAL` / `BUY EVAL` / `CONFIRMED`), per-client
user logins, and automated PDF/email reporting.
