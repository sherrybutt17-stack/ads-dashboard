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

Record in one continuous take, **full browser window with the address bar
visible throughout**, and upload to YouTube as *Unlisted*. Reviewers check that
the client ID in the URL matches the project they are reviewing; a video cropped
to the page content is the single most common reason for rejection.

Set the Google consent screen's **language to English** (bottom-left toggle)
before recording.

1. **`https://dash.growthguild.us/about`** — show the home page, scroll through
   "What we ask Google for, and why", then follow the footer links to the
   privacy policy and terms. This proves the three links on the consent screen
   are real pages describing this app.
2. **Sign in** to the dashboard at `https://dash.growthguild.us` and open a
   client's setup page. Narrate that this is the agency's own staff signing in.
3. **Click Continue with Google.** Show the data-access notice under the
   button, then pause a beat on the consent screen so the address bar is
   legible — the `client_id=` parameter must be readable — and so the app name
   and requested scope are on screen.
4. **Grant access**, and let the redirect land back in the app.
5. **Show the account picker** that follows, and attach one Google Ads account.
6. **Show the data in use** — the client's dashboard rendering Google spend,
   clicks and conversions next to the CRM funnel. This is the step reviewers
   most often find missing: they need to see the scope's data actually being
   used for the purpose described, not just granted.
7. **Show revocation** — the disconnect control in the dashboard, and mention
   that a user can also revoke from their Google account settings.
8. **Show the second consent flow** — Google requires every flow to be shown.
   The wizard also offers *Sign in with Google again* (reconnect); click it and
   let the consent screen appear once more.

Keep it under about five minutes. Do not edit out the consent screen or the URL
bar, and do not speed up the grant step.

---

## After submitting

Allow 3–10 business days; sensitive-scope reviews are sometimes faster and
sometimes much slower. Google replies by email to the developer contact
addresses on the Branding page — watch them, including spam. Expect at least one round of
clarification questions; answer in the same thread rather than resubmitting,
which restarts the queue.

Nothing about the app needs to change while you wait. The flow works today
through the *Advanced* link.
