# Setup

Everything here gates the data pipes and cannot be automated from inside the
app. Work top to bottom.

> **Do step 4 first if you are short on time.** GoHighLevel has no
> stage-transition history API — every day the webhook is not live is a day of
> pipeline history that cannot be recovered later by any means. Meta history
> backfills fine; GHL history does not.

---

## 0 · Local install

```bash
npm install
cp .env.example .env.local     # fill in as you work through the steps below
npm run db:push                # create the tables
npm run dev
```

Generate the two secrets:

```bash
openssl rand -hex 32           # ENCRYPTION_KEY
openssl rand -hex 32           # CRON_SECRET
```

---

## 1 · Database — Neon or Supabase

Both free tiers are ample here; this data is small. The driver is selected
automatically from the connection string, so switching later is only an env var
change.

### Option A — Neon (recommended)

1. Create a project at <https://console.neon.tech>.
2. Copy the **pooled** connection string.
3. Set `DATABASE_URL`. It must end in `?sslmode=require`.

### Option B — Supabase

1. Create a project at <https://supabase.com/dashboard>.
2. **Project Settings → Database → Connection string → Transaction pooler.**
   Use the **pooler** URL (port **6543**), not the direct one (5432) — serverless
   functions open a connection per invocation and will exhaust the direct
   connection limit under webhook load.
3. Replace `[YOUR-PASSWORD]` with your database password.

> ⚠️ **Supabase free pauses a project after a period of inactivity, and an
> actually-paused project needs a manual unpause.** For most apps that is
> harmless. Here it is the one failure mode that loses data permanently: if the
> database is unreachable when GoHighLevel fires a webhook, that stage
> transition is gone — there is no history API to re-fetch it from.
>
> In practice the hourly cron keeps the project active. If you use Supabase,
> confirm the cron is actually running before relying on it, and check the
> "Meta data freshness" health row periodically.

Then, either way:

```bash
npm run db:push
```

### 1b · Upgrading a database that already has data

`db:push` is correct for a **fresh** database and only for a fresh one. It
diffs `schema.ts` against the database and writes its own DDL, which makes it
very good at adding columns and completely incapable of the one thing an
existing deployment needs: **moving data**. A `NOT NULL` column added to a table
that already holds rows has no value to put in them, so push either prompts or
fails.

These migrations therefore run **by hand, in this order, before `db:push`**:

```bash
psql "$DATABASE_URL" -f drizzle/0022_loose_lady_ursula.sql
psql "$DATABASE_URL" -f drizzle/0023_tenancy.sql       # agencies + agency_id
psql "$DATABASE_URL" -f drizzle/0024_audit_agency.sql  # audit_log.agency_id
npm run db:push                                        # everything else
```

Why the order is load-bearing, not a preference:

- **0023 before push.** `clients.agency_id` and `users.agency_id` are `NOT NULL`
  on populated tables. 0023 adds them nullable, backfills every existing row to
  the bootstrap agency, then tightens. Afterwards push sees a matching schema
  and leaves those tables alone.
- **0024 after 0023.** It reads `clients.agency_id`, which 0023 creates.
- **Both before push**, not instead of it — push still applies everything else.

Two later migrations sit outside that ordering, because neither adds a `NOT
NULL` column to a populated table — which is exactly what `db:push` handles
well. Push applies both; the files exist for anyone applying migrations in
sequence:

- **`0025_tiktok_reconcile.sql`** — `clients.last_tiktok_reconciled_at`. NULL is
  the correct starting value: it reads as "never reconciled", so every existing
  client is picked up by the next nightly run rather than appearing already
  trued up.
- **`0026_ad_budgets.sql`** — the `ad_budgets` table behind budget pacing (§5e).
  A new table with no backfill; until a budget is entered, the pacing panel
  reports "no budget set" and still projects where the month lands.
- **`0027_pacing_alerts.sql`** — `clients.last_pacing_alert_at` and
  `.last_pacing_alert_status`, the suppression state for pacing alerts (§5e).
  Both NULL means "never alerted", which correctly reads as nothing to
  suppress.

The ordered three are guarded and safe to re-run, deliberately with no wrapping
transaction: a half-applied migration you can simply run again is worth more
than an all-or-nothing one that leaves you working out which half landed. Each
is covered by a test that runs the real file against a real Postgres
(`src/db/tenancy.test.ts`, `src/db/audit-agency.test.ts`).

> ⚠️ **Back up first.** `stage_transitions` is the one table in this database
> that cannot be rebuilt from any upstream API — see the note at the top of this
> file. Take a snapshot before running any of this.

---

## 2 · Meta Marketing API

You need an app and a **System User** token. System user tokens never expire,
which is what an unattended sync job requires — a normal user token dies after
60 days, or sooner if that person changes their password.

1. **Create an app** at <https://developers.facebook.com/apps> → type
   **Business**. Note the App ID and App Secret → `META_APP_ID`,
   `META_APP_SECRET`.
2. **Business Settings → Users → System Users → Add.** Give it Admin.
3. **Assign assets:** add the ad account(s), with at least *Analyst* access.
4. **Generate a token** for the system user. Select your app and request
   **`ads_read` only**.
   - Do **not** request `ads_management` — that is write access and attracts
     heavier review for no benefit here.
   - Do **not** tick "expires in 60 days".
5. Set `META_SYSTEM_USER_TOKEN`.
6. Leave `META_API_VERSION=v25.0`.

**App Review:** not needed while the token holder has a role on the app and
access to the ad account (Standard Access). You only need review + Business
Verification to serve ad accounts you do not manage.

**If a client's ad account is in a different Business Manager**, you cannot
reach it with your system user token. Enter a per-client token override in the
setup wizard (step 3) instead.

> ⚠️ **Pin the API version.** Expired Marketing API versions do **not** error —
> Meta silently falls back to an older one, changing behaviour with no signal.
> Versions last roughly 12 months. Review this twice a year.

---

## 2b · Google Ads API — optional

Skip this entirely if no client runs Google Ads; the dashboard works Meta-only,
and the wizard's Google step stays inert until these are set.

There are **two ways** a Google Ads account can reach this dashboard, and the app
supports both:

| | **Model A — agency MCC** | **Model B — client signs in** |
|---|---|---|
| How | client links their account to your Manager account | client clicks *Connect Google*, authorizes with their own Google login |
| Credential | one agency refresh token, in env | a per-account token, encrypted in the database |
| `login-customer-id` | your MCC | **theirs**, discovered automatically |
| Needs OAuth verification | no | **yes** |

Model B is the front door — nobody has to be talked through a link request — and
Model A stays as the fallback. The app resolves `login-customer-id` per account,
so the two coexist without interfering.

### 🔴 Corrected 2026-08-21: you are probably not blocked

This section used to say *"no Google data flows until your developer token has
Basic access — Explorer only reaches test accounts."* **That is wrong.**
Verified against Google's own access-levels page:

> "Explorer Access level allows the developer token to make Google Ads API
> requests against both test accounts and production accounts. Production
> accounts are any accounts that serve real, live Google ads."

| Level | Real accounts? | Daily operations |
|---|---|---|
| Test Account | no | 15,000 (test only) |
| **Explorer** (often granted automatically) | **yes** | **2,880** |
| Basic | yes | 15,000 |
| Standard | yes | unlimited |

A `Search`/`SearchStream` request counts as **one** operation no matter how many
rows it returns, and a sync makes exactly **one** — `getDailyMetrics`, whatever
the window. (`listClientAccounts` and `getCustomer` are onboarding calls, not
sync calls.) The OAuth token exchange hits `oauth2.googleapis.com` and is not an
Ads API operation at all.

So on the nightly cron alone, Explorer's 2,880/day is ~2,880 account-syncs —
not a constraint at any plausible size.

**The one thing that can burn it** is the stale-while-revalidate refresh, which
fires on dashboard load up to every 15 minutes: 96 ops/day for one account whose
dashboard sits open all day. That puts the practical Explorer ceiling around
**30 accounts** in that worst case, and ~156 on Basic. Both are far above the
nightly-only figure, and neither is the 100-user OAuth cap, which is a different
limit on a different axis — see the table above.

So: check your current level in API Center **before** treating this as blocked,
and apply for Basic in parallel with shipping rather than ahead of it.

### The steps

1. **Create an empty Manager (MCC) account** at
   <https://ads.google.com/home/tools/manager-accounts>. Nothing gets linked to
   it under Model B — it exists solely because Google shows **API Center** only
   on manager accounts, and API Center is where the developer token lives.
2. **Google Cloud project:** at <https://console.cloud.google.com> create a
   project, enable the **Google Ads API**, then create an **OAuth client**
   (type: **Web application**). Add the redirect URI **exactly**:
   `https://dash.growthguild.us/api/oauth/google/callback`
   → `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`.
3. **Point `dash.growthguild.us` at Vercel** — one CNAME. OAuth must run on your
   own domain (see *Domain strategy* below).
4. **Check the three public pages load without signing in.** They ship with the
   app and Google's reviewer must be able to reach all three:
   `/about` · `/legal/privacy` · `/legal/terms`
5. **Search Console:** add a **Domain property** for `growthguild.us` and verify
   it by DNS TXT record.
6. **OAuth consent screen:** add **Authorized domain `growthguild.us` BEFORE any
   URLs** — the URL fields reject anything whose domain is not already listed.
   Then set the home page, privacy and terms links to the three pages above, and
   press **Verify Branding**.
7. **Apply for developer token *Basic* access** in the MCC → **Tools → API
   Center** → `GOOGLE_ADS_DEVELOPER_TOKEN`. Do this *after* step 6.
8. **Set publishing status to *In production***. Do not stay in *Testing*:
   Google **revokes refresh tokens after 7 days** in that state, so every client
   connection silently dies within a week. *Published but unverified* is
   shippable — it shows an "unverified app" warning and caps at **100 users for
   the lifetime of the app, not resettable** — so publish, ship, and verify in
   parallel.
9. **Submit OAuth verification:** a written justification plus a demo video
   showing your branding, the full consent flow, the exact scopes, and the
   client ID visible in the address bar. Allow up to 10 days.

> **No CASA.** The annual third-party security assessment applies to
> *restricted* scopes. `adwords` is *sensitive* (reclassified October 2020), so
> this is standard review. The app requests `adwords` and nothing else —
> deliberately, since one extra scope changes which review you are in.

### For Model A only (agency MCC)

10. **Refresh token:** authorize once as the MCC-owner user with scope
    `https://www.googleapis.com/auth/adwords` and offline access (the OAuth
    Playground is the quickest path) → `GOOGLE_ADS_REFRESH_TOKEN`. Google
    refresh tokens are reusable and do not rotate.
11. Set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to the **MCC id, digits only** (no
    dashes). Accounts connected through Model B store their own manager id and
    ignore this.
12. **Link each client account to the MCC**, then paste that account's Customer
    ID into the wizard. It is verified against the API immediately, echoing back
    the account name so a wrong id is caught in the moment.

### Domain strategy — this constrains white-label

Google's *Authorized domain* covers every subdomain of the top private domain,
so `<client>.growthguild.us` is free on the OAuth side and Vercel wildcards
scale it. **Client-owned vanity domains do not scale** — each is a separate top
private domain needing its own Authorized Domain entry and its own Search
Console verification.

**Rule: run OAuth only on the agency's own domain.** Client vanity domains may
serve read-only report views; never the consent flow.

> ⚠️ **Pin the API version.** `GOOGLE_ADS_API_VERSION` defaults to `v22`. Unlike
> Meta — which silently falls back to an older version and hands you quietly
> wrong numbers — Google **hard-errors** on a sunset version, which is the
> better failure. The previous default here was `v18` (Nov 2024), long past
> sunset, and would have failed every call. Confirm the current version against
> Google's release notes before the first real request and set it explicitly.
> A separate nightly cron (`/api/cron/google-sync`) reconciles Google spend; it
> never touches the Meta pipeline.

---

## 3 · Deploy

Webhooks need a public HTTPS URL, so the GHL step cannot be completed against
localhost.

1. Push to GitHub, import into Vercel.
2. Set every variable from `.env.example` in Vercel's project settings.
3. Set `NEXT_PUBLIC_APP_URL` to the deployed origin. It renders the per-client
   webhook URL, every link that goes out by email, and each provider's OAuth
   `redirect_uri`. On Vercel the deployment's own domain is used as a fallback,
   so an omission is no longer silently `localhost` — but a custom domain in
   front of the project is invisible to that fallback, so set it explicitly.
4. Set `DASHBOARD_PASSWORD`. **Without it the dashboard is publicly readable.**

### Cron — the nightly reconcile

Both platforms restate spend and conversions for up to ~28 days as attribution
windows fill, so each night re-pulls that whole trailing window and upserts.
That is what keeps an arbitrary date range matching Ads Manager instead of
drifting.

Clients are **not** all in one timezone, and both Meta and Google bucket days in
the ad account's timezone, so each client's day closes at a different instant.
The endpoints therefore gate each client on:

> *has this client's local reconcile hour (default **03:00**) passed without a
> reconcile since?*

— rather than "is it exactly 3am for them right now". This matters more than it
looks:

- It is **safe at any cadence**, so a best-effort free scheduler is fine.
- A **late or skipped run costs nothing but latency** — the client is still
  overdue and gets picked up next time. An exact-hour match would silently drop
  every client at that offset for the night.
- It is **idempotent**, so multiple triggers can coexist without double work.

Hour 3 rather than 2 because local 2am does not exist on spring-forward day in
the US, EU or Australia.

**Two triggers, deliberately:**

| Trigger | Cadence | Role |
|---|---|---|
| `.github/workflows/reconcile.yml` | every 3 hours | Primary. Each client reconciled within 3h of its local 3am. Calls all three platform crons. |
| `.github/workflows/reports.yml` | hourly | Scheduled report email (§5d). No-op until `RESEND_API_KEY` is set. |
| `vercel.json` crons | once daily | Backstop for **Meta and Google only**. |

Whichever fires first does the work; the other finds nothing to do.

> ⚠️ **TikTok has no backstop.** Vercel's Hobby tier allows two cron jobs and
> Meta and Google hold both, so `/api/cron/tiktok-sync` runs from the GitHub
> workflow and nowhere else. If that workflow is disabled, TikTok stops being
> reconciled while the other two degrade only to daily — and the symptom is
> subtle, because the on-load refresh keeps *today* current, so a TikTok tab goes
> on looking live while every day behind it quietly freezes. Moving to Vercel Pro
> (or adding a third free trigger) removes the asymmetry.

The GitHub trigger needs a `CRON_SECRET` repo secret under
*Settings → Secrets and variables → Actions*, matching the value in Vercel's
environment variables.

> If you ever rotate or remove that secret, comment the two `schedule` lines in
> the workflow back out at the same time. Otherwise every run fails on the guard
> step — correct behaviour, but it emails a failure every 3 hours, and recurring
> red trains people to ignore the one failure that matters. Nothing is missed
> while it is off; the daily Vercel cron still reconciles.

> ⚠️ GitHub disables scheduled workflows after **60 days of no repo activity**
> (it emails you first). The daily Vercel cron is the safety net if that happens.

**Manual true-up**, ignoring the overdue gate entirely:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-app>.vercel.app/api/cron/meta-sync?force=1"
```

`?hour=N` overrides the local reconcile hour. The response reports `targetHour`,
how many abandoned `sync_runs` rows were cleared (`reaped`), and per-client
`synced` / `skipped` / `deferred` / `failed`.

**`deferred` is the one to watch.** A run stops dispatching new clients at 240s
to leave headroom to respond, and reports the rest as deferred rather than being
killed mid-loop with no record. One-off deferrals are harmless — the next run
picks them up. Persistent ones mean the client count has outgrown a single
invocation, and the reconcile should move to a queue or a Pro plan.

---

## 4 · GoHighLevel — build the marketplace app ONCE

This is a one-time setup. After it, adding a client is a single click: they
install the app and stage changes start streaming. No workflow building, ever.

> **Why an app and not a Private Integration Token?** Webhook subscriptions
> attach to a marketplace app. A PIT has no webhook capability at all, which is
> why the token route requires hand-building a workflow in every sub-account.
> And workflows **cannot** be created via API — GHL's entire workflows product
> is a single read-only `GET /workflows/` endpoint, with no `workflows.write`
> scope in existence. Requests for workflow CRUD have been open since 2022.

### 4a · Create the app

<https://marketplace.gohighlevel.com> → **My Apps → Create App**

- Distribution: **Agency & Sub-Account**
- Keep it **private/unlisted** — it does not need to be publicly listed.
- Redirect URI: `https://YOUR-DOMAIN/api/oauth/callback`

Copy the **Client ID** and **Client Secret** → `GHL_CLIENT_ID`,
`GHL_CLIENT_SECRET`.

### 4b · Scopes — ⚠️ these lock permanently

Select exactly:

- `opportunities.readonly`
- `contacts.readonly`
- `locations.readonly`

> **Scopes can only be edited while the app is in draft.** Once it goes live
> they are frozen, and changing them means publishing a new app version and
> having every client reinstall. Err toward including a scope you *might* need.
> (The webhook URL and event list stay editable forever — only scopes freeze.)

### 4c · Subscribe to webhook events

App → **Advanced Settings → Webhooks**. Set the URL to:

```
https://YOUR-DOMAIN/api/webhooks/crm
```

Note: **no token in the path.** This is the app-level receiver — one URL for
every client, with tenants told apart by `locationId` in the payload.

Enable these events:

| Event | Why |
|---|---|
| `OpportunityCreate` | New leads entering the pipeline |
| `OpportunityStageUpdate` | **The important one** — every stage movement |
| `OpportunityStatusUpdate` | won / lost / abandoned |
| `ContactCreate` | Contact records + attribution |
| `INSTALL` / `UNINSTALL` | Tracks app installs and removals |

### 4d · Add a client

In the dashboard: **Add client** → **Install on a sub-account**. You'll be sent
to GHL to choose the sub-account and returned automatically. Pipeline stages
import on the way back, so you land straight on the mapping screen.

Then map stages, connect the ad account, and you're done. The client's timezone
is adopted from the Meta ad account automatically.

> **Stages import unmapped, deliberately.** The wizard offers a name-based
> suggestion for each one and a button to apply them all, but nothing is written
> to the mapping until you save. Nothing downstream can tell a guess from a
> confirmed mapping — there is no column for it — so a guess written at import
> would be counted by the funnel and would turn the "stage mapping complete"
> health check green without anyone having looked. Check the suggestions before
> accepting them; `Disqualified` in particular must not be mapped to `Lost`
> (see the stage list in `src/lib/stages.ts` for why).

### Fallback: Private Integration Token

Still supported for sub-accounts where the app cannot be installed. Leave
`GHL_CLIENT_ID` unset and the wizard falls back to token entry plus the
per-client webhook URL, which then does require hand-building a workflow
(Automation → Workflows → trigger **Pipeline Stage Changed** → action
**Webhook** → **publish it**; a draft workflow fires nothing).

---

## 5 · Ad URL parameters — required for per-campaign costs

GoHighLevel does **not** natively store Meta ad IDs. Its own documented
workaround joins on campaign *names*, which breaks the moment anyone renames a
campaign. The fix is URL parameters.

In Ads Manager, on each ad, set **Website URL → URL parameters**:

```
utm_source=facebook
utm_medium=paid
utm_campaign={{campaign.name}}
campaign_id={{campaign.id}}
ad_id={{ad.id}}
ad_group_id={{adset.id}}
```

Two things to know:

- **Historical leads stay unattributed.** Contacts already in GHL have no
  campaign ID and cannot be assigned one retroactively. Per-campaign breakdowns
  begin from your first tagged campaign forward; older leads render as
  "Unattributed" rather than being dropped, so totals still reconcile.
- **Native Instant Forms bypass UTMs entirely.** If a campaign uses a Facebook
  lead form instead of a landing page, no URL parameters apply and those leads
  arrive unattributed regardless. There is one route back for those — see 5a.

The setup page's **"Campaign attribution"** health check confirms this is
actually working — it reports what fraction of recent contacts carry a campaign
ID.

### 5a · Instant Form leads — the one route back

A Lead Ad form opens inside Facebook. There is no landing page, so there are no
URL parameters and nothing above applies. What those leads do carry is a
**leadgen id**, which Meta will trade back for the ad, ad set and campaign:

```
npx tsx --env-file=.env.local scripts/repair-attribution.ts            # dry run
npx tsx --env-file=.env.local scripts/repair-attribution.ts --apply
```

It only ever fills a blank column, so it is safe to re-run, and it does 500
leads per run so it cannot exhaust the ad account's API budget and stall the
nightly sync behind it.

> 🔴 **Expect the first run to be refused.** Reading a lead submission needs the
> `leads_retrieval` permission; the system user token from § 2 has `ads_read`.
> Meta gates "what a person typed into a form" far more tightly than ad
> statistics. The script detects that specific refusal and names the scope,
> rather than reporting "0 repaired" — which would look identical to having
> nothing to repair.
>
> **Until that scope is granted, Instant Form leads cannot be attributed by any
> route.** If per-campaign reporting matters more than the form's conversion
> rate, drive those ads to a landing page instead.

Nothing is written until an Instant Form lead actually arrives through the
webhook: `contacts.facebook_lead_id` is populated on the GHL contact path and
has no historical source. Which GHL field carries the id is taken from their
merge-field documentation and **has not yet been confirmed against a live
payload** — the parser accepts several spellings for that reason.

---

## 5b · Written summaries — optional

The dashboard can draft the weekly client update. Set one environment variable:

```
ANTHROPIC_API_KEY=sk-ant-...      # console.anthropic.com/settings/keys
```

Skip it and nothing breaks — the panel says drafting is not configured, you can
still write and publish a summary by hand, and every figure on every page is
identical either way.

**What it does and does not do.** The model writes sentences; it never computes
a number. Every figure it is allowed to use is handed to it by the metrics
engine, and the finished text is checked back against that list — a number that
matches nothing is named above the draft in red before you can send it. Its
output schema has no numeric field and no verdict field at all.

**It never publishes.** Drafting and editing write a private working copy;
"Publish to client report" is a separate button, a separate endpoint and a
separate audit entry, and it freezes the text. Regenerating afterwards changes
what you see and *not* what a client holding a share link is reading. To change
that you have to publish again.

The panel is agency-only — it is absent from a client-role dashboard and from
their customise drawer, not merely hidden.

---

## 5c · Server-rendered PDF — optional, and it fixes one specific thing

```
PDF_RENDER_KEY=...            # browserless.io, or pdfshift.io
PDF_RENDER_PROVIDER=pdfshift  # only if not using browserless
```

Skip it and nothing breaks: the "Download PDF" button is absent and the print
button works exactly as before.

**What it buys is the page margin.** Chrome stamps the document title, the date,
the **source URL** and the page number into every printed page whenever its
"Headers and footers" checkbox is ticked — which is the default, and which is
deliberately unreachable from CSS and JavaScript. So the first report a client
forwards to their board carries
`ads-dashboard-shaheer4.vercel.app/c/<slug>/report` down the side of it. A
"please untick that box" instruction is not a fix; it will not survive one real
client. Rendering server-side removes the chrome because there is no browser
window and no print dialog.

Two things to know:

- **`NEXT_PUBLIC_APP_URL` must be a public address.** The render service fetches
  the report *from us*, so it cannot see `localhost`. That case is detected and
  reported as a configuration problem rather than hanging for thirty seconds.
  Locally, use the print button.
- **The renderer has no login**, so the URL it fetches carries a 90-second
  HMAC-signed token covering that client and that exact date range. It is
  stateless — no database row per PDF — which normally means "cannot be revoked
  early"; at ninety seconds that is a shorter window than a revocation would
  take to reach anyone. The signing key is derived from `ENCRYPTION_KEY`, so
  there is no extra secret to set.

Both buttons stay. A render service can be down or out of credits, and a report
you cannot get off the screen at all is worse than one with a footer.

---

## 5d · Scheduled report email — optional

```
RESEND_API_KEY=...
REPORT_FROM="Growth Guild <reports@yourdomain.com>"
```

Emails clients a **link** to their report, weekly or monthly. Configured per
client on their setup page: cadence, recipients, and the hour — in *their*
timezone, so it lands at their breakfast rather than at whatever UTC hour a cron
fires.

**A link, not an attachment**, and that is the whole design. Meta restates spend
and conversions for up to 28 days, so a monthly report emailed on the 1st is
provisional for most of its life. A PDF in an inbox is frozen forever and cannot
be corrected; a share link expires, can be revoked the moment a figure turns out
to be wrong, and resolves what it shows when it is opened. The email carries the
period and the link and **no numbers at all**, for exactly that reason.

### 🔴 The sender domain is the part that cannot be skipped

`REPORT_FROM` must be on a domain you control, with **SPF, DKIM and DMARC**
published and the domain verified with the provider. This is not polish. Mail
from an unauthenticated domain is filed as spam, and a client report sitting in
a junk folder is worse than one never sent — you believe it arrived and the
client believes it never did.

A `gmail.com` sender is **rejected outright**, not merely filtered: Gmail
publishes DMARC `p=reject`. The app refuses that address before calling the
provider and says so on the panel.

### The cron

`.github/workflows/reports.yml`, hourly. Hourly is required because send hours
are per-client-timezone, and Vercel Hobby's one-run-per-day is already spent
twice over on the reconciles. Needs the same `CRON_SECRET` repo secret.

Safe at any cadence, including retries and overlapping runs: each schedule
decides for itself whether its period is complete, whether the local send hour
has passed, and whether that period already went out. The guarantee is enforced
in Postgres — a partial unique index on (client, platform, period), with the row
claimed *before* the email is sent — so two racing invocations send exactly once.

**A missed run sends one report, not a backlog.** Three weeks of downtime
produces the most recent period plus a line naming the ones that were skipped,
rather than three emails, two of which describe periods nobody can act on.

---

## 5e · Budget pacing — optional, no credentials needed

Nothing to configure and nothing to install: enter the client's agreed monthly
budget on their setup page (**Monthly budget**) and the dashboard's *Budget
pacing* panel starts measuring spend against it. Requires
`drizzle/0026_ad_budgets.sql` — or a `db:push` — to have run.

Three things worth knowing before the first number is entered:

- **Enter it in the ad account's currency.** There is deliberately no currency
  field. Pacing divides this figure against that account's spend, so a budget
  denominated in anything else is not a display problem, it is a wrong answer.
- **Each entry applies from its month onward, until a later one replaces it.**
  Raising a client from $2,000 to $4,000 in June means adding a June entry, not
  editing the March one. That is what stops a raise from silently restating
  every closed month against today's figure and turning a month that hit its
  target into one that missed by half.
- **An empty amount is a real setting**, distinct from having no entry: it
  records "no budget from this month on" while keeping the history of what was
  agreed before.

The panel is staff-only. The variance against a commercial term is an
agency-side conversation, not something a client's own dashboard should open.

The **client list** carries the book-level view of the same thing: what has been
committed and placed this month per currency, and an alphabetical list of the
clients pacing outside 10% of their own agreement. Clients with no budget on
record are counted and named as excluded rather than quietly dropped from the
total. It costs five queries for the whole book regardless of its size.
It reads the same weekday-weighted projection as *Where this month lands*, so
the two panels cannot quote different month-end figures.

### Budget delivery, in arrears

The **Budget delivery** panel (Reports tab, staff only) is the same question
asked backwards: for each of the last twelve months, what was agreed, what was
placed, and whether it landed within 10%. It is the record to have in front of
you at a renewal.

Two things it deliberately does not do:

- **It never scores the month in progress.** On the 8th, $900 of a $4,000 month
  is not a 78% shortfall, it is the 8th — and scoring it would put the loudest
  colour on the panel for the first three weeks of every month.
- **It never averages the monthly percentages.** The headline figure is total
  placed over total committed, so a $200 month cannot weigh as much as a
  $20,000 one.

A month before the client's first agreement reads "No budget" rather than 0%:
nothing was promised, so nothing was missed.

### Pacing alerts

A panel is only useful to someone who opens it, and an underspend is only
fixable while the month still has days left. So if the client has an alert
destination configured (§ the alerts panel on the same page), pacing warnings
post to the same Slack or Discord channel as the lead alerts:

| Fires when | Message |
|---|---|
| Projected to finish **20%+ under** budget | what was agreed, the projection, the gap, and what to spend per day to land on it |
| Projected to finish **20%+ over** | the same |
| **Budget spent with days still to run** | how many days are left, and that delivery stops when the account runs dry |

Everything else about it is a rule for staying quiet, because a channel that
pings daily gets muted — and it is the lead alerts, the ones with a five-minute
half-life, that are lost when it does:

- **20%, not the dashboard's 10%.** A drift between the two is visible on the
  panel and silent in the channel, so ordinary delivery lumpiness never pings.
- **At most one message a week per direction.** A client 20% underspent on the
  8th is still 20% underspent on the 9th.
- **Unless the drift reverses.** Underspending on Monday and overspending by
  Friday is a genuinely new problem, and a purely time-based cooldown would
  swallow it for a week.
- **Never inside the last 5 days of the month.** "Projected to underspend by
  $1,200" on the 30th is a post-mortem wearing an alarm's clothing. An
  exhausted budget is the exception — money already gone is worth saying on any
  day, because the account has stopped delivering either way.
- **Only during the client's working hours** (09:00–20:00 local).
- **Never when the spend figures cannot be trusted.** This is the important one:
  pacing divides *recorded* spend by the agreed budget, so a sync that has not
  run records nothing and looks exactly like an account that stopped
  delivering. An alert saying "underspending" over a broken pipe would send you
  to raise a budget that was already being spent. Whenever the platform is
  unreachable, has never synced, or is still backfilling, the alert is
  suppressed, the dashboard panel replaces its verdict with the reason, and the
  client is excluded from the book totals and named as excluded. A merely
  *stale* pipe — last sync succeeded, a few hours behind — is still trusted;
  pacing over a month is not moved by a few hours.

It runs from `/api/cron/pacing`, on the same free 3-hourly GitHub schedule as
the reconciles and deliberately after them — alerting on figures the same run
was about to correct would report a drift that no longer exists. Force one
past the working-hours gate (the cooldown still applies) with:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-app>.vercel.app/api/cron/pacing?force=1"
```

---

## 6 · Verify end to end

Work the health checklist on each client's setup page. Then deliberately break
things and confirm the checklist reports the *right* failure:

| Action | Expected |
|---|---|
| Revoke the GHL token | 🔴 GoHighLevel connection |
| Enter a nonexistent ad account | 🔴 Meta ad account |
| Pause the ad account | 🟡 "ads paused" — **not** red, **not** green |
| Unmap a pipeline stage | 🔴 Stage mapping |
| Send the same webhook twice | one `stage_transitions` row, not two |

That last row is the idempotency guarantee: GHL retries deliveries ~12 times
with jitter, so a redelivery must collapse rather than inflate every funnel
count downstream.

**Reconcile Meta** against Ads Manager for the same account and window — spend,
impressions, and link clicks should match. Note that summed daily reach will
*not* equal the period reach figure, and that difference is correct: reach
counts distinct people, so it cannot be added across days.

---

## Things that will bite you

- **The 11:59pm instinct is wrong.** Meta keeps restating spend and conversions
  for up to 28 days as attribution windows fill. The nightly job pulls
  *yesterday* plus a trailing 7-day re-pull and upserts, so the dashboard
  self-heals. A hard end-of-day cutoff would freeze incomplete numbers forever.
- **Reach is not additive.** Summing 30 daily values overstates monthly reach
  2–5×. Aggregate periods are queried separately.
- **Link clicks have two definitions.** `inline_link_clicks` is pinned to a
  1-day-click window and reads *lower* than the Ads Manager column. Both are
  stored; the dashboard shows the attribution-respecting one.
- **Client timezone should match the ad account timezone.** The wizard warns on
  a mismatch. If they disagree, daily rows are offset and month boundaries
  straddle.
- **Deleting a client archives it.** A hard delete would cascade into
  `stage_transitions` and destroy funnel history GHL cannot supply again.
- **Duplicate detection can only see leads that have a phone or an email.**
  On the current book that is roughly one lead in eight — the rest arrived
  through a historical import that never populated those columns. The panel
  states the denominator before it states any finding, because "2 duplicates"
  on its own reads as a fact about the pipeline when it is a fact about the
  sliver of it that can be checked.
- **The month-end forecast ignores the date picker**, deliberately: it is a
  claim about the calendar month, so it loads the calendar month. It also
  projects only spend and leads. Appointments and closes take weeks to mature,
  so pacing a month-to-date count of those forward would report the calendar as
  a decline.
- **CSV exports leave undefined values blank, never zero.** A blank cell is
  what a spreadsheet reads as "no value" and what `AVERAGE` skips; `$0.00` is
  the exact failure in the source spreadsheet this product replaced.
