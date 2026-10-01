# Google OAuth verification — submission pack

The **"Google hasn't verified this app"** interstitial is not a bug and cannot be
removed by anything in this repository. Google shows it to every OAuth client
that requests a *sensitive* scope and has not passed review — including for test
users, including with the consent screen perfectly configured. It disappears
only when verification is approved.

**Until then:** *Advanced → Go to Growth Guild (unsafe)* completes the flow. The
refresh token it produces is real and permanent; nothing about the connection is
degraded by having clicked through the warning. What the unverified state
actually costs you is the **100-user lifetime cap** (not resettable) and the fact
that a client seeing that screen will reasonably refuse to continue.

🔴 **A rejection is worse than waiting.** If Google rejects the submission,
users' access to the `adwords` scope is cut off until it is fixed and every
material resubmitted. Submit only once everything below is true.

We request one scope, `https://www.googleapis.com/auth/adwords`, which is
*sensitive*, not *restricted* — so this is standard review with **no CASA**
security assessment. See `SETUP.md` § 2b for the console configuration this
assumes is already done.

---

## Before submitting — console checklist

In <https://console.cloud.google.com> → **Google Auth Platform**:

- [ ] **Audience:** user type **External**, publishing status **In production**
      (*Testing* revokes refresh tokens after 7 days — every client connection
      dies within a week, long after anyone is watching.)
- [ ] **App name** matches the name on the `/about` page: Growth Guild
- [ ] **User support email** and **developer contact** both reachable
- [ ] **App logo** (optional) — add it before verifying branding; changing it
      later triggers re-verification
- [ ] **Authorized domain:** `growthguild.us` — added *before* the URL fields,
      which reject any URL whose domain is not already listed
- [ ] **Application home page:** `https://dash.growthguild.us/about`
- [ ] **Privacy policy:** `https://dash.growthguild.us/legal/privacy`
- [ ] **Terms of service:** `https://dash.growthguild.us/legal/terms`
- [ ] All three load in a logged-out browser (they are carved out of the auth
      gate in `src/proxy.ts` — re-check after any change to `PUBLIC_PREFIXES`)
- [ ] `growthguild.us` verified in Search Console as a **Domain property**, by
      DNS TXT, under the same Google account that owns the Cloud project
- [ ] **Branding verified AND published** — *Verify branding*, then *Publish
      branding* within 7 days. Google will not accept a data-access submission
      until branding is published.
- [ ] **Data Access:** `.../auth/adwords` and nothing else, listed under
      *sensitive* scopes
- [ ] **Clients:** only the production Web client, redirect URI exactly
      `https://dash.growthguild.us/api/oauth/google/callback`, no `localhost`,
      no JavaScript origins. The video must cover every OAuth client in the
      project, so dev/test clients live in a separate project.
- [ ] **Google Ads API page:** terms accepted, access level Explorer or Basic
- [ ] Vercel production env: `GOOGLE_ADS_CLIENT_ID`/`_SECRET` from this
      project, `NEXT_PUBLIC_APP_URL=https://dash.growthguild.us`, no stale
      `GOOGLE_ADS_API_VERSION`

🔴 The Search Console owner of `growthguild.us` must be an **Owner or Editor**
on the Cloud project. A mismatch is the most common cause of a submission
bouncing back for "domain ownership could not be confirmed".

---

## Scope justification — paste into the form

> Growth Guild is a marketing agency. This application is our internal client
> reporting dashboard: it joins advertising spend from Google Ads and Meta to
> outcomes recorded in each client's CRM — enquiries, appointments booked,
> appointments attended, and closed deals — so that a client can see what their
> advertising actually produced rather than only what it cost.
>
> We request a single scope, https://www.googleapis.com/auth/adwords, and use it
> for exactly one purpose: reading daily campaign performance metrics
> (impressions, clicks, cost and conversions) for the Google Ads accounts a
> client has explicitly connected. Those metrics are stored against that client
> and rendered in their dashboard alongside their CRM pipeline.
>
> The access is read-only in practice. The application never creates, edits,
> pauses or budgets a campaign, and never places a bid. A narrower scope would
> not work: the Google Ads API offers exactly one OAuth scope,
> https://www.googleapis.com/auth/adwords, and no read-only variant, so this is
> the minimum that allows reading campaign performance at all. We request
> nothing else.
>
> Users are agency staff and the agency's clients — an agency creates its own
> account, and each client is given a login by their agency and sees only their
> own accounts. Before a client picks accounts, we list the accounts their
> sign-in can reach (names and IDs) so they can choose; we read performance
> data only from the accounts they choose. Google user data is never sold or
> used for advertising, and is shared only with the service providers that run
> the features using it: Vercel (hosting) and Neon (database), and — where the
> features are switched on — Anthropic, which writes a plain-English summary of
> a report from its aggregated figures, and a PDF rendering service that turns
> a report page into a PDF on request. Credentials are encrypted at rest. A
> client can revoke access from their Google account at any time, or disconnect
> it from within the dashboard, which deletes the stored token immediately.

(The same explanation, in the wording a reviewer will compare it against, is
already published at `https://dash.growthguild.us/about`. Keep the two in step —
a justification that does not match the home page is a rejection.)

---

## Demo video — shot list

**Claude Code / browser automation cannot record this.** Google's sign-in needs
the staff member's own passkey, Google blocks sign-in from automated browsers,
and automation captures the page without the address bar — which is the one
thing the reviewer checks. Record it yourself with the OS recorder (macOS:
Cmd+Shift+5 → *Record Entire Screen*, Options → *Show Mouse Clicks*, microphone
on if narrating). Editing is allowed — Google suggests adding call-outs — but
never cut the consent screen or the grant.

What Google checks (sensitive-scope page and "Examples of Common Issues"):
the consent flow in **English**; the consent screen showing the app name
**Growth Guild**; the **OAuth client ID** (`client_id=85350514831-…`) readable
in the address bar *on the consent screen*; the same app and branding as the
submission; the complete consent screen with only the `adwords` scope; every
consent flow; and the scope's data **being used** in the app. No length limit —
6–8 minutes is realistic. Narration is optional but helps.

### Before you press record

- [ ] Branding **verified and published**, audience **In production**, one Web
      client only, redirect URI only `…/api/oauth/google/callback` (no
      Playground, no localhost). Unpublished branding shows the domain instead
      of "Growth Guild" on the consent screen — a rejection.
- [ ] Vercel production has the new `GOOGLE_ADS_CLIENT_ID`/`_SECRET`, and no
      `GOOGLE_ADS_API_VERSION=v22`.
- [ ] **Hide other clients.** The account picker lists *every* account the
      Google login can reach (the agency login reaches 250+ businesses), with
      names and IDs, before you can filter. Either sign in with a Google user
      that can reach only the demo account, or blur the picker in editing.
- [ ] **Rehearse off camera, same day, same client and account:** Continue
      with Google → attach an account that had spend in the last 30 days → wait
      2–3 minutes → open `/c/<slug>?platform=google` and confirm non-zero spend
      with no red/amber banner, and that the consent screen said "Growth Guild"
      with `client_id=85350514831-…`. Then **Remove** it. The metrics are kept,
      so on camera the dashboard fills instantly (the first-sync backfill runs
      only once per client). Attach through the picker only — the manual
      *Customer ID → Verify & add* path starts no backfill.
- [ ] Chrome: a clean profile, English UI, bookmarks bar hidden, one tab,
      right-click the address bar → **Always show full URLs**, window at least
      1280 px wide (below 1024 px the *Connections* sidebar disappears).
- [ ] Mac: Do Not Disturb on, Slack/Mail quit. Record 10 s as a test and check
      the address bar is legible.
- [ ] **Sign out** of the dashboard.

### Shot list

1. **`https://dash.growthguild.us/about`** — scroll through the page, hold on
   *What we ask Google for, and why* (the `adwords` scope, "read-only in
   practice"). Footer → **Privacy policy**: hold on *Google user data,
   specifically* and the **Limited Use** paragraph. Footer → **Terms of
   service**: hold on *Connected accounts*.
2. **Type** `https://dash.growthguild.us/c/<slug>/setup` in the address bar
   (not `/` — the client list shows every client). The login page appears;
   sign in and you land straight on *Setup & connections*.
3. Scroll to **Connect Google Ads (optional)** and stop — don't scroll further
   (webhook URLs, report recipients). Hold on the **Continue with Google**
   button and the *What we access: read-only…* notice under it.
4. Click **Continue with Google**. The first URL's `clientId=` is our internal
   record, not Google's. Pick the Google account.
5. *Google hasn't verified this app* → **Advanced** → **Go to Growth Guild
   (unsafe)**. Don't cut it.
6. **Consent screen — the key shot.** Check the language (bottom left) says
   English. Hold ~5 s on **Growth Guild** and the Google Ads scope. Click into
   the address bar and move along until **`client_id=85350514831-…`** is
   readable; hold ~5 s. Google's wording for this scope is broad — say the app
   only reads. Click **Continue**.
7. Back on setup: *Which of these belong to this client?* Tick the demo
   account → **Attach 1 account**. Show the connected row (name, *primary*,
   id, red **Remove**).
8. **Second consent flow.** Press **Cmd+R** while `?googleStash=` is still in
   the URL: the used sign-in shows red text and **Sign in with Google again**.
   Click it and go through the Google screens again (hold on the name, scope
   and `client_id` again). When the picker returns, don't attach — click the
   header link **← <Client name>**. (*Sign in with Google again* only exists
   on an expired or used sign-in; there is no other reconnect control.)
9. **Data in use.** The dashboard opens on *Facebook* — click **Google** in the
   *Facebook | Google* switch (`?platform=google`). Show *Overview* (Ad spend,
   Cost per lead, *Spend and leads over time*), **Ads** (*Campaign breakdown*
   — "Google spend joined to CRM outcomes by campaign attribution") and
   **Reports** (Spend, CTR, CPM, CPC). **Never open Leads** (names and phone
   numbers). If it says *Fetching your Google history*, wait and reload.
10. **Revocation in the app.** Sidebar **Connections** → *Connect Google Ads*
    → red **Remove** → OK on *Remove this Google Ads account? Metrics already
    pulled are kept.* This deletes the stored Google token.
11. **Revocation at Google.** Open `https://myaccount.google.com/permissions`,
    show **Growth Guild** and its remove-access control. Stop recording.

### After recording

Upload in YouTube Studio as **Unlisted** (never Private), open the link in a
signed-out window to confirm it plays, then paste it into Google Auth Platform
→ Data Access → *YouTube link*, with the justification above. Have a test login
and steps ready in case the reviewer asks to try the app.

---

## After submitting

Allow 3–10 business days; sensitive-scope reviews are sometimes faster and
sometimes much slower. Google replies by email to the developer contact
addresses on the Branding page — watch them, including spam. Expect at least one round of
clarification questions; answer in the same thread rather than resubmitting,
which restarts the queue.

Nothing about the app needs to change while you wait. The flow works today
through the *Advanced* link.
