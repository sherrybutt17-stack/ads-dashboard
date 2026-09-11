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

We request one scope, `https://www.googleapis.com/auth/adwords`, which is
*sensitive*, not *restricted* — so this is standard review with **no CASA**
security assessment. See `SETUP.md` § 2b for the console configuration this
assumes is already done.

---

## Before submitting — console checklist

In <https://console.cloud.google.com> → APIs & Services → OAuth consent screen:

- [ ] **User type: External**, publishing status **In production**
      (*Testing* revokes refresh tokens after 7 days — every client connection
      dies within a week, long after anyone is watching.)
- [ ] **App name** matches the name on the `/about` page: Growth Guild
- [ ] **User support email** and **developer contact** both reachable
- [ ] **App logo** uploaded (triggers brand verification — do it now, not later)
- [ ] **Authorized domain:** `growthguild.us` — added *before* the URL fields,
      which reject any URL whose domain is not already listed
- [ ] **Application home page:** `https://dash.growthguild.us/about`
- [ ] **Privacy policy:** `https://dash.growthguild.us/legal/privacy`
- [ ] **Terms of service:** `https://dash.growthguild.us/legal/terms`
- [ ] All three load in a logged-out browser (they are carved out of the auth
      gate in `src/proxy.ts` — re-check after any change to `PUBLIC_PREFIXES`)
- [ ] `growthguild.us` verified in Search Console as a **Domain property**, by
      DNS TXT, under the same Google account that owns the Cloud project
- [ ] **Scopes:** `.../auth/adwords` and nothing else

🔴 The account that owns the Cloud project, the Search Console property and the
YouTube video should be the same one. A mismatch is the most common cause of a
submission bouncing back for "domain ownership could not be confirmed".

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
> pauses or budgets a campaign, and never places a bid. We do not request
> adwords_management or any additional scope, because no feature needs one.
>
> Users are the agency's own staff and the agency's clients — each client sees
> only their own accounts, behind their own login. There is no public sign-up.
> Google user data is never sold, and is never transferred to any third party
> except the infrastructure providers that host the application (Vercel) and its
> database (Neon). Credentials are encrypted at rest. A client can revoke access
> from their Google account at any time, or ask us to disconnect it from within
> the dashboard, which deletes the stored token.

(The same explanation, in the wording a reviewer will compare it against, is
already published at `https://dash.growthguild.us/about`. Keep the two in step —
a justification that does not match the home page is a rejection.)

---

## Demo video — shot list

Record in one continuous take, **full browser window with the address bar
visible throughout**, and upload to YouTube as *Unlisted*. Reviewers check that
the client ID in the URL matches the project they are reviewing; a video cropped
to the page content is the single most common reason for rejection.

1. **`https://dash.growthguild.us/about`** — show the home page, scroll through
   "What we ask Google for, and why", then follow the footer links to the
   privacy policy and terms. This proves the three links on the consent screen
   are real pages describing this app.
2. **Sign in** to the dashboard at `https://dash.growthguild.us` and open a
   client's setup page. Narrate that this is the agency's own staff signing in.
3. **Click Connect Google.** Pause a beat on the consent screen so the address
   bar is legible — the `client_id=` parameter must be readable — and so the
   requested scope is on screen.
4. **Grant access**, and let the redirect land back in the app.
5. **Show the account picker** that follows, and attach one Google Ads account.
6. **Show the data in use** — the client's dashboard rendering Google spend,
   clicks and conversions next to the CRM funnel. This is the step reviewers
   most often find missing: they need to see the scope's data actually being
   used for the purpose described, not just granted.
7. **Show revocation** — the disconnect control in the dashboard, and mention
   that a user can also revoke from their Google account settings.

Keep it under about five minutes. Do not edit out the consent screen or the URL
bar, and do not speed up the grant step.

---

## After submitting

Allow around 10 days; sensitive-scope reviews are sometimes faster and sometimes
much slower. Google replies by email to the developer contact address — watch
`agency@growthguild.us`, including spam. Expect at least one round of
clarification questions; answer in the same thread rather than resubmitting,
which restarts the queue.

Nothing about the app needs to change while you wait. The flow works today
through the *Advanced* link.
