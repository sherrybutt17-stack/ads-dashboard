import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { Fragment } from "react";
import { getClientForSession } from "@/lib/clients";
import { getSessionUser, canAccessSlug, isAgencyOperator } from "@/lib/auth";
import { loadDashboard } from "@/lib/metrics/dashboard";
import { refreshIfStale } from "@/lib/meta/sync";
import { refreshGoogleIfStale } from "@/lib/google/sync";
import { refreshTiktokIfStale } from "@/lib/tiktok/sync";
import { activeGoogleAccountsForDisplay } from "@/lib/google/accounts";
import { activeTiktokAccountsForDisplay } from "@/lib/tiktok/accounts";
import type { AdPlatform } from "@/lib/metrics/queries";
import { parseAdPlatform } from "@/lib/platforms";
import {
  trailingWindowInclusive,
  isValidDateKey,
  rangeLabel,
  MAX_RANGE_DAYS,
} from "@/lib/dates";
import { formatNumber } from "@/lib/metrics/compute";
import { SignOut } from "@/components/SignOut";
import { SyncIndicator } from "@/components/SyncIndicator";
import { DateRangePicker } from "@/components/DateRangePicker";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ShareReport } from "@/components/ShareReport";
import { ExportMenu } from "@/components/ExportMenu";
import { Icon } from "@/components/Icon";
import { adPipeState, crmPipeState } from "@/components/DataState";
import { getAdPipeStatus, getCrmPipeStatus } from "@/lib/metrics/pipe-status";
import { buildInsights } from "@/lib/metrics/insights";
import { accentFor } from "@/lib/branding";
import { getClientBranding } from "@/lib/branding-store";
import {
  resolveLayout,
  LAYOUT_SCHEMA_VERSION,
  SECTION_GROUPS,
  parseSectionGroup,
} from "@/lib/dashboard/registry";
import { listSummaries } from "@/lib/ai/store";
import { summariesConfigured } from "@/lib/ai/summary";
import { loadCommentaryForEditor } from "@/lib/commentary/report";
import { monthKeyForDateKey, previousMonthKey } from "@/lib/commentary/model";
import { getLayout } from "@/lib/dashboard/layout-store";
import { defaultAudience } from "@/lib/dashboard/layout-write";
import { CustomiseSections } from "@/components/CustomiseSections";
import { DashboardNav } from "@/components/DashboardNav";
import {
  renderSection,
  NoWebhookBanner,
  AttributionBanner,
  CAMPAIGN_DOTS,
  type SectionContext,
} from "@/lib/dashboard/sections";
import type { CSSProperties } from "react";

export const dynamic = "force-dynamic";

export default async function ClientDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  /*
   * Scoped read, then the grant check. `getClientForSession` already applies
   * both the tenant and — for a client-role login — the slug grant, so a
   * client belonging to another agency is `null` here and renders the same
   * 404 as one that does not exist. `canAccessSlug` below is kept as the
   * redirect-to-home behaviour for a signed-in user hitting a slug they do
   * not hold, which is a nicer landing than a bare not-found.
   */
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) notFound();

  // Defence in depth behind the proxy: a client user may only see their own
  // dashboards. `staff` also drives whether the admin chrome (Setup) renders.
  const session = await getSessionUser();
  if (!canAccessSlug(session, slug)) redirect("/");
  const staff = isAgencyOperator(session);

  /*
   * Stale-while-revalidate: if the last ad-platform sync is older than 15
   * minutes, refresh today's data in the background. Never blocks the render —
   * the page serves what is cached and picks up the new figures on next load.
   *
   * Scheduled with `after()`, not a bare floating promise. A detached promise
   * only survives while the invocation does, and a serverless function may be
   * frozen the moment its response is flushed — so the Meta fetch would be cut
   * off mid-flight, leaving a `sync_runs` row stuck in `running` until the
   * reaper flipped it to `failed`. That manufactured a failure for a pipe that
   * was working, on the surface whose whole job is to make real failures
   * legible. `after()` keeps the invocation alive until this settles.
   */
  after(async () => {
    await Promise.allSettled([
      refreshIfStale(client),
      refreshGoogleIfStale(client),
      // TikTok has no cron — both Vercel Hobby slots are spent on Meta and
      // Google — so this on-load path is the ONLY thing that ever calls the
      // TikTok sync. Without it a connected advertiser shows a permanently
      // empty tab.
      refreshTiktokIfStale(client),
    ]);
  });

  const platform: AdPlatform = parseAdPlatform(sp.platform);

  // Range comes straight from the URL (the picker markets links as shareable), so
  // validate before it reaches the date math / SQL — junk like ?start=foo or
  // ?days=1e11 would otherwise build an Invalid Date and 500 the whole dashboard.
  const days = sp.days ? Number(sp.days) : 30;
  const safeDays =
    Number.isFinite(days) && days > 0
      ? Math.min(Math.floor(days), MAX_RANGE_DAYS)
      : 30;
  const hasValidRange =
    isValidDateKey(sp.start) &&
    isValidDateKey(sp.end) &&
    (sp.start as string) <= (sp.end as string);
  const range = hasValidRange
    ? { startKey: sp.start as string, endKey: sp.end as string }
    : (() => {
        const w = trailingWindowInclusive(safeDays, client.timezone);
        return { startKey: w.startKey, endKey: w.endKey };
      })();

  /*
   * The month the commentary panel opens on: the one the selected range ENDS
   * in, so a monthly report and its commentary line up without a second
   * control. The panel carries its own picker for every other case, because
   * commentary is monthly and a 30-day window is not a month.
   */
  const commentaryMonth = monthKeyForDateKey(range.endKey);

  /*
   * 🔴 The layout is fetched BEFORE the dashboard, not alongside it.
   *
   * That costs one serial round trip on a small indexed row, and it buys the
   * right to skip up to eleven of the dashboard's queries — including the two
   * twelve-month cohort loops and the duplicate scan. Until this was split,
   * hiding a section saved nothing at all: `loadDashboard` was a single
   * unconditional `Promise.all` and the customise drawer only changed what was
   * rendered from data that had already been paid for.
   *
   * It resolves to code defaults on any failure, so a client whose layout row
   * cannot be read gets the whole dashboard rather than an error.
   */
  const storedLayout = await getLayout(client.id, defaultAudience(session));

  /*
   * Which sections render, in what order.
   *
   * `resolveLayout` is total by construction: a malformed row, a row written by
   * a newer deploy, or a row naming a section that no longer exists all fall
   * back to the registry order rather than throwing. A dashboard full of real
   * numbers must not go down over a display preference. It returns only the
   * VISIBLE sections, so the id set below is simply its contents.
   *
   * Scoped by AUDIENCE, which is the isolation mechanism rather than a nicety:
   * with one row per client, a client hiding the campaign table would blind the
   * agency on the same page, and the agency would have no way to tell a hidden
   * section from a broken one.
   */
  const sections = resolveLayout(
    {
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      sections: storedLayout.sections.map((x) => ({
        id: x.def.id,
        visible: x.visible,
      })),
    },
    // Staff-only sections are absent from a client's registry entirely, so this
    // flag is what decides whether they exist for this render at all.
    { staff },
  );

  /*
   * Which tab is open, and therefore which sections render.
   *
   * 🔴 `required` sections render on EVERY tab, not just their own. The lead
   * filter note and the headline numbers are how a reader knows WHICH leads the
   * figures on screen describe — a reader looking at the Ads tab needs that as
   * much as one on Overview, and a tab that quietly omitted it would be the
   * same silent omission the customise drawer already refuses to allow.
   *
   * The filter runs BEFORE `visibleSections` is built, so it feeds selective
   * loading: opening one tab issues one tab's queries. That is the difference
   * between the 4–6 second loads this page had and something that feels
   * immediate.
   */
  const activeGroup = parseSectionGroup(sp.tab);
  const tabSections = sections.filter(
    (s) => s.group === activeGroup || s.required,
  );

  /*
   * Which tabs to offer: only those with something on them. A client with no
   * Google or TikTok account and no written summaries should not be given an
   * empty tab to click, and `resolveLayout` has already dropped anything hidden
   * or staff-only.
   */
  const availableGroups = SECTION_GROUPS.filter((g) =>
    sections.some((s) => s.group === g.id && !s.required),
  );

  const visibleSections = new Set(tabSections.map((d) => d.id));

  const [data, google, tiktok, adPipe, branding, summaries, commentary] =
    await Promise.all([
      loadDashboard(client, { ...range, sections: visibleSections }, platform),
      /*
       * Degrades to "no Google accounts" rather than throwing. This table gains
       * columns, and a deploy that lands before its migration would otherwise
       * take the whole page down over a feature this client may not even use.
       */
      activeGoogleAccountsForDisplay(client.id),
      // Same degradation as Google: an empty list rather than an error page when
      // the migration adding this table has not run yet.
      activeTiktokAccountsForDisplay(client.id),
      // Two indexed queries, run alongside the dashboard rather than after it, so
      // every empty region below can say WHY it is empty instead of rendering the
      // same dashed box for "paused", "unreachable" and "never connected".
      getAdPipeStatus(client, platform),
      /*
       * Resolved on EVERY render, never snapshotted. That is the fix for the
       * behaviour this category is most complained about for: a theme change that
       * applies only to reports created afterwards, leaving every existing one
       * showing the old logo forever.
       */
      getClientBranding(client.id),
      /*
       * Written summaries, staff only. A client render skips the query entirely
       * rather than fetching rows it will never be allowed to show — the section
       * is not in a client's registry, so there is nothing to render them into.
       */
      staff
        ? listSummaries({
            clientId: client.id,
            platform,
            rangeStart: range.startKey,
            rangeEnd: range.endKey,
          }).then((r) => ({ ...r, configured: summariesConfigured() }))
        : Promise.resolve(null),
      /*
       * Monthly commentary, staff only — same reasoning as the summaries above.
       * `loadCommentaryForEditor` swallows a missing table into `error`, so a
       * deploy ahead of its migration costs this panel and nothing else.
       */
      staff
        ? loadCommentaryForEditor(client, platform, commentaryMonth)
        : Promise.resolve(null),
    ]);
  const crmPipe = getCrmPipeStatus(client);
  const { current, daily } = data;
  const currency = data.client.currency;
  // The toggle only appears once Google is actually connected — a Meta-only
  // client keeps the single, un-switched dashboard it had before.
  const hasGoogle = google.accounts.length > 0;
  const hasTiktok = tiktok.accounts.length > 0;
  const PLATFORM_LABEL = {
    meta: "Meta",
    google: "Google",
    tiktok: "TikTok",
  } as const;
  const spendLabel = PLATFORM_LABEL[platform];
  /*
   * Only the platforms actually connected. A client running Meta alone keeps
   * the single un-switched dashboard they had before, and a tab for a platform
   * with no account behind it would render an empty view that looks like a
   * broken pipe rather than an absent one.
   */
  const platforms = (["meta", "google", "tiktok"] as const).filter(
    (p) => p === "meta" || (p === "google" ? hasGoogle : hasTiktok),
  );

  /*
   * Resolved once, so the trend chart, the campaign table and the heatmap cannot
   * tell three different stories about the same pipe. Null means the pipe is
   * healthy and an empty panel is free to mean what it looks like.
   */
  const adState = adPipeState(adPipe, { staff, slug });
  const crmState = (emptyPanel: boolean) =>
    crmPipeState(crmPipe, { staff, slug, emptyPanel });

  /*
   * What the KPI deltas are measured against, named on every tile.
   *
   * `daily` is one entry per day of the selected range, so its length IS the
   * window size — and the previous window is built from the same length, which
   * is what makes "previous 30 days" a statement of fact rather than a label.
   */
  const rangeDays = data.daily.length;
  const basis = rangeDays === 1 ? "previous day" : `previous ${rangeDays} days`;

  /*
   * The report shows the SAME period the dashboard is showing, explicitly —
   * always as start/end rather than as `days`, so a report opened tomorrow from
   * a link someone kept still covers the days it covered when it was generated.
   * A trailing-window parameter would quietly slide.
   */
  const reportHref = `/c/${slug}/report?start=${range.startKey}&end=${range.endKey}${
    platform !== "meta" ? `&platform=${platform}` : ""
  }`;
  /*
   * Meeting mode, on the same explicit period and for the same reason: a deck
   * opened from a kept link must cover the days it covered when it was built.
   */
  const presentHref = `/c/${slug}/present?start=${range.startKey}&end=${range.endKey}${
    platform !== "meta" ? `&platform=${platform}` : ""
  }`;

  /*
   * One href builder for both the platform toggle and the tabs.
   *
   * Each carries the OTHER's current value, so switching platform keeps you on
   * the tab you were reading and switching tab keeps the platform — along with
   * the date range, which the picker advertises as shareable.
   */
  const hrefWith = (over: { platform?: AdPlatform; tab?: string }) => {
    const params = new URLSearchParams();
    if (sp.days) params.set("days", String(sp.days));
    if (sp.start) params.set("start", sp.start);
    if (sp.end) params.set("end", sp.end);
    const p = over.platform ?? platform;
    if (p !== "meta") params.set("platform", p);
    const t = over.tab ?? activeGroup;
    if (t !== "overview") params.set("tab", t);
    const qs = params.toString();
    return qs ? `/c/${slug}?${qs}` : `/c/${slug}`;
  };
  const platformHref = (p: AdPlatform) => hrefWith({ platform: p });

  // Shared campaign identity (color + name), keyed by Meta campaign id, so the
  // same campaign reads identically in the explorer and the campaign table.
  const campaignIds = Array.from(
    new Set([
      ...data.campaigns
        .map((c) => c.campaignId)
        .filter((x): x is string => Boolean(x)),
      ...data.leads
        .map((l) => l.campaignId)
        .filter((x): x is string => Boolean(x)),
    ]),
  ).sort();
  const campaignColors: Record<string, string> = {};
  campaignIds.forEach((id, i) => {
    campaignColors[id] = CAMPAIGN_DOTS[i % CAMPAIGN_DOTS.length];
  });
  const campaignNames: Record<string, string> = {};
  for (const c of data.campaigns) {
    if (c.campaignId) campaignNames[c.campaignId] = c.campaignName;
  }

  const sparkSpend = daily.map((d) => d.ads.spend);
  const sparkLeads = daily.map((d) => d.funnel.new_lead);
  const sparkAppts = daily.map((d) => d.funnel.appointment_booked);
  const sparkWon = daily.map((d) => d.funnel.closed_won);

  /*
   * Revenue reporting has three states, and collapsing them is the failure mode.
   *
   *   deals closed, none valued  → we do not know. Dash, and say why.
   *   deals closed, some valued  → report it, but say the coverage out loud so
   *                                nobody reads a partial figure as the total.
   *   nothing closed             → a real zero, shown as a real zero.
   *
   * The middle case is live: verified 2026-08-12, 43 of 64 closed-won
   * opportunities carry a value and none created since March does.
   */
  const wonOpps = current.revenue?.wonOpps ?? 0;
  const wonWithValue = current.revenue?.wonWithValue ?? 0;
  const valuesMissing = wonOpps > 0 && wonWithValue === 0;
  const revenueFootnote = valuesMissing
    ? `${formatNumber(wonOpps)} closed, no deal value set`
    : wonWithValue > 0 && wonWithValue < wonOpps
      ? `${formatNumber(wonWithValue)} of ${formatNumber(wonOpps)} deals valued`
      : undefined;

  // Per-client accent + the "what changed" headline. The accent is scoped to the
  // dashboard subtree via CSS vars, so this client's data-identity (hero glow,
  // mark, heatmap, insight eyebrow) reads in their colour without touching the
  // fixed brand blue of the action buttons.
  // The client's own colour when they have one, otherwise the generated accent
  // — byte-identical to before for every client who has not set one.
  const accent = accentFor(client.id, branding);
  const brandName = branding.displayName ?? data.client.name;
  const insights = buildInsights(data);
  const accentVars = {
    "--accent": accent.color,
    "--accent-glow": accent.glow,
  } as CSSProperties;

  const sectionCtx: SectionContext = {
    data,
    client,
    platform,
    slug,
    staff,
    currency,
    spendLabel,
    basis,
    insights,
    campaignColors,
    campaignNames,
    adState,
    crmState,
    sparkSpend,
    sparkLeads,
    sparkAppts,
    sparkWon,
    valuesMissing,
    revenueFootnote,
    summaries: summaries ?? undefined,
    commentary: commentary
      ? {
          ...commentary,
          /*
           * Six months back plus this one. Long enough to fix a past month or
           * read what was promised two quarters ago, short enough that the
           * picker stays one row. Built here rather than queried because a
           * month with nothing written in it is still a month somebody may want
           * to write into — a list of months that HAVE commentary would hide
           * exactly the ones that need it.
           */
          months: Array.from({ length: 6 }).reduce<string[]>(
            (acc) => [...acc, previousMonthKey(acc[acc.length - 1])],
            [commentaryMonth],
          ),
        }
      : undefined,
  };

  return (
    <div className="flex min-h-full" style={accentVars}>
      <DashboardNav
        slug={slug}
        brandName={brandName}
        logoUrl={
          branding.hasLogo
            ? `/api/c/${slug}/branding/logo?v=${branding.logoVersion}`
            : null
        }
        groups={availableGroups}
        activeGroup={activeGroup}
        hrefForGroup={(g) => hrefWith({ tab: g })}
        reportHref={reportHref}
        presentHref={presentHref}
        staff={staff}
        showBranding={staff || branding.clientEditable}
        /*
         * The dot fires on the two conditions that mean a pipe is actually
         * down, not merely quiet: the CRM has never delivered a webhook, or the
         * ad platform is unreachable. "Paused" is deliberately excluded — an
         * account with no spend is a business decision, and flagging it would
         * train the operator to ignore the one indicator that matters.
         */
        connectionsWarning={
          staff &&
          (!data.client.firstWebhookAt ||
            adPipe.state === "unreachable" ||
            adPipe.state === "stale")
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-10 border-b"
          style={{
            borderColor: "var(--border)",
            background:
              "color-mix(in srgb, var(--surface-page) 80%, transparent)",
            backdropFilter: "saturate(180%) blur(14px)",
            WebkitBackdropFilter: "saturate(180%) blur(14px)",
          }}
        >
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3.5 sm:px-6">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {branding.hasLogo ? (
                /*
                 * The client's own mark, at the client's own dashboard.
                 *
                 * eslint-disable below for the same reason as the creative grid:
                 * this is a per-tenant, access-controlled route whose bytes change
                 * on upload, so `next/image` would need a remotePatterns entry for
                 * our own origin and would cache across a replacement.
                 */
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/c/${slug}/branding/logo?v=${branding.logoVersion}`}
                  alt={brandName}
                  className="h-9 w-auto max-w-[160px] shrink-0 object-contain"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] text-[15px] font-bold text-white"
                  style={{
                    background:
                      "linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 50%, #0d1b30) 100%)",
                    boxShadow:
                      "0 2px 10px -2px color-mix(in srgb, var(--accent) 55%, transparent), inset 0 1px 0 rgba(255,255,255,0.25)",
                  }}
                >
                  {brandName.trim().charAt(0).toUpperCase() || "•"}
                </div>
              )}
              <div className="min-w-0">
                <Link
                  href="/"
                  title="Back to all clients"
                  className="mb-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80"
                  style={{
                    color: "var(--text-secondary)",
                    borderColor: "var(--border-strong)",
                    background: "var(--surface-2)",
                  }}
                >
                  <Icon name="arrowLeft" size={12} /> All clients
                </Link>
                <h1
                  className="truncate text-[17px] leading-tight font-semibold"
                  style={{
                    color: "var(--text-primary)",
                    letterSpacing: "-0.012em",
                  }}
                >
                  {brandName}
                </h1>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <SyncIndicator syncedAt={data.client.lastSyncedAt} />
              {platforms.length > 1 && (
                <div
                  role="group"
                  aria-label="Ad platform"
                  className="inline-flex items-center rounded-[9px] border p-0.5"
                  style={{
                    borderColor: "var(--border-strong)",
                    background: "var(--surface-2)",
                  }}
                >
                  {platforms.map((p) => {
                    const active = platform === p;
                    return (
                      <Link
                        key={p}
                        href={platformHref(p)}
                        aria-current={active ? "page" : undefined}
                        className="rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors"
                        style={{
                          background: active
                            ? "var(--surface-1)"
                            : "transparent",
                          color: active
                            ? "var(--text-primary)"
                            : "var(--text-muted)",
                          boxShadow: active
                            ? "0 1px 2px rgba(0,0,0,0.08)"
                            : "none",
                        }}
                      >
                        {/* "Facebook" rather than "Meta" on the tab, because
                          that is what the client calls the ads they are buying. */}
                        {p === "meta" ? "Facebook" : PLATFORM_LABEL[p]}
                      </Link>
                    );
                  })}
                </div>
              )}
              <DateRangePicker currentLabel={data.range.label} />
              <CustomiseSections
                slug={slug}
                staff={staff}
                locked={storedLayout.locked}
                initialUpdatedAt={storedLayout.updatedAt?.toISOString() ?? null}
                initial={storedLayout.sections.map((s) => ({
                  id: s.def.id,
                  label: s.def.label,
                  description: s.def.description,
                  cadence: s.def.cadence,
                  required: Boolean(s.def.required),
                  visible: s.visible,
                  isNew: s.isNew,
                }))}
              />
              {/*
              Share and Export stay in the header while Report and Present moved
              to the sidebar, which looks inconsistent until you read it as the
              split the whole layout is built on: these two ACT on the selected
              range — a share link freezes it, an export writes it to a file — so
              they belong beside the picker that sets it. Report and Present only
              navigate to another view of the same thing.
            */}
              {staff && (
                <ShareReport
                  clientId={client.id}
                  rangeStart={range.startKey}
                  rangeEnd={range.endKey}
                  rangeText={rangeLabel(range.startKey, range.endKey)}
                  platform={platform}
                />
              )}
              {/*
              Staff only, matching the route. Giving clients their own export is
              reasonable and is one line in `CLIENT_RESOURCES` — but that line
              changes the security model, and this is not the change that should
              carry it.
            */}
              {staff && (
                <ExportMenu
                  slug={slug}
                  start={range.startKey}
                  end={range.endKey}
                  platform={platform}
                />
              )}
              {/*
              These stay in the header rather than moving to the sidebar with
              the rest of the account chrome, because the sidebar is `lg:` and
              up. Signing out and switching theme are not desktop privileges.
            */}
              <SignOut />
              <ThemeToggle />
            </div>
          </div>
          {/*
          Tabs.

          Inside the header rather than at the top of <main> on purpose: the
          entrance stagger targets `main > *:nth-child(n)`, so a nav element
          there would take a section's animation slot and push every section one
          step later.

          Horizontally scrollable rather than wrapping, so four tabs plus a long
          client name cannot push the row into a second line on a narrow screen
          — the overlapping-controls problem this header already had.
        */}
          {availableGroups.length > 1 && (
            <nav
              aria-label="Dashboard sections"
              className="-mb-px flex gap-1 overflow-x-auto px-4 sm:px-6"
            >
              {availableGroups.map((g) => {
                const active = g.id === activeGroup;
                return (
                  <Link
                    key={g.id}
                    href={hrefWith({ tab: g.id })}
                    aria-current={active ? "page" : undefined}
                    title={g.blurb}
                    className="shrink-0 border-b-2 px-3 py-2.5 text-[13.5px] font-medium whitespace-nowrap transition-colors"
                    style={{
                      borderColor: active ? "var(--accent)" : "transparent",
                      color: active
                        ? "var(--text-primary)"
                        : "var(--text-muted)",
                    }}
                  >
                    {g.label}
                  </Link>
                );
              })}
              {/*
              Below `lg` the sidebar is hidden, so these would be unreachable —
              including Connections, which is where someone goes when a feed has
              died. They ride the same scrollable row rather than getting their
              own bar, separated by a rule so they read as a different kind of
              destination than the tabs.
            */}
              <span
                aria-hidden="true"
                className="mx-1 my-2 w-px shrink-0 lg:hidden"
                style={{ background: "var(--border-strong)" }}
              />
              {[
                { href: reportHref, label: "Report", show: true },
                { href: presentHref, label: "Present", show: true },
                { href: `/c/${slug}/setup`, label: "Connections", show: staff },
                {
                  href: `/c/${slug}/branding`,
                  label: "Branding",
                  show: staff || branding.clientEditable,
                },
              ]
                .filter((l) => l.show)
                .map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="shrink-0 px-3 py-2.5 text-[13.5px] font-medium whitespace-nowrap lg:hidden"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {l.label}
                  </Link>
                ))}
            </nav>
          )}
        </header>

        <main className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-7 sm:px-6">
          {/* Diagnostic banners are operator concerns and link to Setup, which a
            client can't reach — staff only. They sit outside the section
            registry deliberately: "your webhook is dead" is not something a
            layout should ever be able to hide. */}
          {staff && !data.client.firstWebhookAt && (
            <NoWebhookBanner slug={slug} />
          )}
          {staff && data.attributionGap && (
            <AttributionBanner slug={slug} platform={platform} />
          )}

          {/*
          The page body, from the registry.

          Rendered as a flat map with Fragment keys and NO wrapper element — the
          entrance stagger in globals.css targets `main > *:nth-child(n)`, so an
          intervening div would collapse every section onto one delay.
        */}
          {tabSections.map((s) => (
            <Fragment key={s.id}>{renderSection(s.id, sectionCtx)}</Fragment>
          ))}

          <footer
            className="flex flex-wrap gap-x-4 gap-y-1 py-4 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <span>Timezone: {data.client.timezone}</span>
            <span>
              {spendLabel} last synced:{" "}
              {data.client.lastSyncedAt
                ? new Date(data.client.lastSyncedAt).toLocaleString("en-US", {
                    timeZone: data.client.timezone,
                  })
                : "never"}
            </span>
            {/*
            Only when the selected range actually contains rows Meta may still
            restate. This used to print on every Meta view regardless — including
            ranges made entirely of settled data — so it carried no information
            and taught the reader to skip it. Now its presence is the signal.
          */}
            {data.provisional.provisionalRows > 0 && (
              <span>
                {data.provisional.since
                  ? `Figures from ${data.provisional.since} onward are provisional`
                  : "Some figures in this range are provisional"}{" "}
                — Meta restates spend and conversions for up to 28 days as
                attribution windows fill.
              </span>
            )}
          </footer>
        </main>
      </div>
    </div>
  );
}
