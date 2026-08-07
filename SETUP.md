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

The model mirrors Meta but with one twist: instead of a per-account token, **one
Manager (MCC) account** authorizes every client account **linked** to it. So the
credentials below are agency-level (one set for all clients); a client only ever
supplies its **Customer ID** in the wizard.

1. **Create a Manager (MCC) account** at <https://ads.google.com/home/tools/manager-accounts>.
2. **Google Cloud project:** at <https://console.cloud.google.com> create a
   project, enable the **Google Ads API**, then create an **OAuth client**
   (type: Web or Desktop). Note the client id/secret →
   `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`.
3. **Developer token:** in the MCC → **Tools → API Center**. Copy it →
   `GOOGLE_ADS_DEVELOPER_TOKEN`. *Explorer Access* is granted automatically
   (enough for daily reporting); apply for *Basic* only if you exceed its
   per-day cap.
4. **Refresh token:** authorize once as the MCC-owner user with scope
   `https://www.googleapis.com/auth/adwords` and offline access (the OAuth
   Playground is the quickest path). Paste into `GOOGLE_ADS_REFRESH_TOKEN`.
   Unlike GHL, Google refresh tokens are reusable and do not rotate.
5. Set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to the **MCC id, digits only** (no dashes).
6. Leave `GOOGLE_ADS_API_VERSION=v18`.
7. **Link each client account to the MCC** (Google Ads → Sub-account access, or
   the client accepts the link request). Read access is enough. Then, in the
   wizard's *Connect Google Ads* step, paste that account's Customer ID — it is
   verified against the API immediately, echoing back the account name so a
   wrong id is caught in the moment.

> ⚠️ **Pin the API version**, same reasoning as Meta — Google deprecates
> versions roughly yearly. A separate nightly cron (`/api/cron/google-sync`)
> reconciles Google spend; it never touches the Meta pipeline.

---

## 3 · Deploy

Webhooks need a public HTTPS URL, so the GHL step cannot be completed against
localhost.

1. Push to GitHub, import into Vercel.
2. Set every variable from `.env.example` in Vercel's project settings.
3. Set `NEXT_PUBLIC_APP_URL` to the deployed origin — it is what renders the
   per-client webhook URL.
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
| `.github/workflows/reconcile.yml` | every 3 hours | Primary. Each client reconciled within 3h of its local 3am. |
| `vercel.json` crons | once daily | Backstop. If the GitHub trigger breaks or GitHub disables it, you degrade to daily rather than to nothing. |

Whichever fires first does the work; the other finds nothing to do.

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
  arrive unattributed regardless.

The setup page's **"Campaign attribution"** health check confirms this is
actually working — it reports what fraction of recent contacts carry a campaign
ID.

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
