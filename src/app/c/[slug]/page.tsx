import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getClientBySlug } from "@/lib/clients";
import { getSessionUser, isStaff, canAccessSlug } from "@/lib/auth";
import { loadDashboard, MOVING_AVERAGE_DAYS } from "@/lib/metrics/dashboard";
import { refreshIfStale } from "@/lib/meta/sync";
import { refreshGoogleIfStale } from "@/lib/google/sync";
import { activeGoogleAccounts } from "@/lib/google/accounts";
import type { AdPlatform } from "@/lib/metrics/queries";
import { trailingWindowInclusive } from "@/lib/dates";
import { SignOut } from "@/components/SignOut";
import {
  formatCurrency,
  formatNumber,
  formatPercent,

} from "@/lib/metrics/compute";
import { StatTile } from "@/components/StatTile";
import { Funnel } from "@/components/Funnel";
import { PipelineExplorer } from "@/components/PipelineExplorer";
import { SpeedToLeadWidget } from "@/components/SpeedToLead";
import { TrendCharts } from "@/components/TrendCharts";
import { MetricsTable } from "@/components/MetricsTable";
import { DateRangePicker } from "@/components/DateRangePicker";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { PeriodMetrics } from "@/lib/metrics/queries";

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
  const client = await getClientBySlug(slug);
  if (!client) notFound();

  // Defence in depth behind the proxy: a client user may only see their own
  // dashboards. `staff` also drives whether the admin chrome (Setup) renders.
  const session = await getSessionUser();
  if (!canAccessSlug(session, slug)) redirect("/");
  const staff = isStaff(session);

  /*
   * Stale-while-revalidate: if the last Meta sync is older than 15 minutes,
   * refresh today's data in the background. Never blocks the render — the page
   * serves what is cached and picks up the new figures on the next load.
   */
  void refreshIfStale(client).catch(() => {});
  void refreshGoogleIfStale(client).catch(() => {});

  const platform: AdPlatform = sp.platform === "google" ? "google" : "meta";

  const days = sp.days ? Number(sp.days) : 30;
  const range =
    sp.start && sp.end
      ? { startKey: sp.start, endKey: sp.end }
      : (() => {
          const w = trailingWindowInclusive(
            Number.isFinite(days) && days > 0 ? days : 30,
            client.timezone,
          );
          return { startKey: w.startKey, endKey: w.endKey };
        })();

  const [data, googleAccounts] = await Promise.all([
    loadDashboard(client, range, platform),
    activeGoogleAccounts(client.id),
  ]);
  const { current, deltas, daily } = data;
  const currency = data.client.currency;
  // The toggle only appears once Google is actually connected — a Meta-only
  // client keeps the single, un-switched dashboard it had before.
  const hasGoogle = googleAccounts.length > 0;
  const spendLabel = platform === "google" ? "Google" : "Meta";

  // Preserve the active date range when switching platforms.
  const platformHref = (p: AdPlatform) => {
    const params = new URLSearchParams();
    if (sp.days) params.set("days", String(sp.days));
    if (sp.start) params.set("start", sp.start);
    if (sp.end) params.set("end", sp.end);
    if (p !== "meta") params.set("platform", p);
    const qs = params.toString();
    return qs ? `/c/${slug}?${qs}` : `/c/${slug}`;
  };

  // Shared campaign identity (color + name), keyed by Meta campaign id, so the
  // same campaign reads identically in the explorer and the campaign table.
  const campaignIds = Array.from(
    new Set([
      ...data.campaigns.map((c) => c.campaignId).filter((x): x is string => Boolean(x)),
      ...data.leads.map((l) => l.campaignId).filter((x): x is string => Boolean(x)),
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

  return (
    <div className="min-h-full">
      <header
        className="sticky top-0 z-10 border-b"
        style={{
          borderColor: "var(--border)",
          background: "color-mix(in srgb, var(--surface-page) 80%, transparent)",
          backdropFilter: "saturate(180%) blur(14px)",
          WebkitBackdropFilter: "saturate(180%) blur(14px)",
        }}
      >
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3.5 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] text-[15px] font-bold text-white"
              style={{
                background: "linear-gradient(135deg, #3f90ea 0%, #1c5cab 100%)",
                boxShadow: "0 2px 8px -2px rgba(28, 92, 171, 0.5), inset 0 1px 0 rgba(255,255,255,0.25)",
              }}
            >
              {data.client.name.trim().charAt(0).toUpperCase() || "•"}
            </div>
            <div className="min-w-0">
              <Link
                href="/"
                className="text-[11px] font-medium tracking-wide transition-colors hover:underline"
                style={{ color: "var(--text-muted)" }}
              >
                Clients
              </Link>
              <h1
                className="truncate text-[17px] leading-tight font-semibold"
                style={{ color: "var(--text-primary)", letterSpacing: "-0.012em" }}
              >
                {data.client.name}
              </h1>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasGoogle && (
              <div
                role="group"
                aria-label="Ad platform"
                className="inline-flex items-center rounded-[9px] border p-0.5"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--surface-2)",
                }}
              >
                {(["meta", "google"] as const).map((p) => {
                  const active = platform === p;
                  return (
                    <Link
                      key={p}
                      href={platformHref(p)}
                      aria-current={active ? "page" : undefined}
                      className="rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors"
                      style={{
                        background: active ? "var(--surface-1)" : "transparent",
                        color: active ? "var(--text-primary)" : "var(--text-muted)",
                        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                      }}
                    >
                      {p === "meta" ? "Facebook" : "Google"}
                    </Link>
                  );
                })}
              </div>
            )}
            <DateRangePicker currentLabel={data.range.label} />
            {staff && (
              <Link
                href={`/c/${slug}/setup`}
                className="rounded-[9px] border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)]"
                style={{
                  borderColor: "var(--border-strong)",
                  color: "var(--text-secondary)",
                }}
              >
                Setup
              </Link>
            )}
            <SignOut />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-7 sm:px-6">
        {/* Diagnostic banners are operator concerns and link to Setup, which a
            client can't reach — staff only. */}
        {staff && !data.client.firstWebhookAt && <NoWebhookBanner slug={slug} />}
        {staff && data.attributionGap && (
          <AttributionBanner slug={slug} platform={platform} />
        )}
        <LeadFilterNote
          filter={data.leadFilter}
          slug={slug}
          platform={platform}
          staff={staff}
        />

        {/* Headline KPIs */}
        <section
          className="grid grid-cols-2 gap-3.5 lg:grid-cols-3 xl:grid-cols-6"
          aria-label="Headline metrics"
        >
          <StatTile
            label="Ad spend"
            value={formatCurrency(current.ads.spend, currency)}
            numeric={current.ads.spend}
            format="currency"
            currency={currency}
            metricKey="spend"
            change={deltas.spend}
            spark={sparkSpend}
          />
          <StatTile
            label="New leads"
            value={formatNumber(current.funnel.new_lead)}
            numeric={current.funnel.new_lead}
            format="number"
            metricKey="new_lead"
            change={deltas.new_lead}
            spark={sparkLeads}
            emphasis
          />
          <StatTile
            label="Cost per lead"
            value={formatCurrency(current.derived.cpLead, currency)}
            numeric={current.derived.cpLead}
            format="currency"
            currency={currency}
            metricKey="cpLead"
            change={deltas.cpLead}
            footnote={
              current.derived.cpLead === null && current.funnel.new_lead > 0
                ? "No spend recorded"
                : undefined
            }
          />
          <StatTile
            label="Appointments"
            value={formatNumber(current.funnel.appointment_booked)}
            numeric={current.funnel.appointment_booked}
            format="number"
            metricKey="appointment_booked"
            change={deltas.appointment_booked}
            spark={sparkAppts}
            footnote={`${formatPercent(current.derived.bookPct, 1)} of leads`}
          />
          <StatTile
            label="Showed"
            value={formatNumber(current.funnel.showed)}
            numeric={current.funnel.showed}
            format="number"
            metricKey="showed"
            change={deltas.showed}
            footnote={`${formatPercent(current.derived.showPct, 1)} of appts`}
          />
          <StatTile
            label="Closed / won"
            value={formatNumber(current.funnel.closed_won)}
            numeric={current.funnel.closed_won}
            format="number"
            metricKey="closed_won"
            change={deltas.closed_won}
            spark={sparkWon}
            footnote={`${formatCurrency(current.derived.cpWon, currency)} each`}
          />
        </section>

        {/* Speed to lead — first outbound call vs lead-in */}
        <SpeedToLeadWidget data={data.speedToLead} />

        {/* Where leads are now — filter by campaign, click a stage to see who */}
        <PipelineExplorer
          leads={data.leads}
          currency={currency}
          timezone={data.client.timezone}
          campaignColors={campaignColors}
          campaignNames={campaignNames}
        />

        {/* Which campaign brought the leads */}
        <CampaignTable
          campaigns={data.campaigns}
          currency={currency}
          campaignColors={campaignColors}
          spendLabel={spendLabel}
        />

        {/* Flow funnel (entries in the period) + spend/leads trend */}
        <div className="grid gap-5 xl:grid-cols-2">
          <Funnel
            steps={data.funnel}
            exits={{
              no_show: current.funnel.no_show,
              lost: current.funnel.lost,
            }}
          />
          <TrendCharts daily={daily} currency={currency} />
        </div>

        {/* The four report views from the source sheet */}
        <MetricsTable
          title="90-day moving averages"
          subtitle="Trailing windows ending yesterday — today is excluded because it is partial"
          firstColumnLabel="Window"
          rows={data.movingAverages.map((m, i) => ({
            label: `${MOVING_AVERAGE_DAYS[i]} Days`,
            funnel: m.funnel,
            ads: m.ads,
            derived: m.derived,
          }))}
          currency={currency}
        />

        <MetricsTable
          title="7-day change"
          subtitle="Last 7 days against the 7 before"
          firstColumnLabel="Period"
          rows={[
            {
              label: "Last 7 days",
              ...pick(data.sevenDayChange.current),
              emphasis: true,
            },
            { label: "Previous period", ...pick(data.sevenDayChange.previous) },
          ]}
          currency={currency}
        />

        <MetricsTable
          title="14-day daily report"
          subtitle="One row per day, most recent first"
          firstColumnLabel="Date"
          rows={data.fourteenDayDaily.map((d) => ({
            label: d.label,
            funnel: d.funnel,
            ads: d.ads,
            derived: d.derived,
          }))}
          currency={currency}
          defaultOpen={false}
        />

        <MetricsTable
          title="Month on month"
          subtitle="Trailing 12 calendar months in the client's timezone"
          firstColumnLabel="Month"
          rows={data.monthOnMonth.map((m) => ({
            label: m.label,
            funnel: m.funnel,
            ads: m.ads,
            derived: m.derived,
          }))}
          currency={currency}
          defaultOpen={false}
        />

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
          {platform === "meta" && (
            <span>
              Figures inside 28 days are provisional — Meta restates spend and
              conversions as attribution windows fill.
            </span>
          )}
        </footer>
      </main>
    </div>
  );
}

/** Strip a PeriodMetrics down to what MetricsTable needs. */
function pick(m: PeriodMetrics) {
  return { funnel: m.funnel, ads: m.ads, derived: m.derived };
}

const CAMPAIGN_DOTS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-7)",
];

function CampaignTable({
  campaigns,
  currency,
  campaignColors,
  spendLabel,
}: {
  campaigns: Array<{
    campaignId: string;
    campaignName: string;
    platform: "meta" | "google";
    spend: number;
    impressions: number;
    linkClicks: number;
    leads: number;
    cpLead: number | null;
  }>;
  currency: string;
  campaignColors: Record<string, string>;
  spendLabel: string;
}) {
  if (campaigns.length === 0) return null;

  const maxLeads = campaigns.reduce((m, c) => Math.max(m, c.leads), 0);
  const totalLeads = campaigns.reduce((s, c) => s + c.leads, 0);
  const colorFor = (id: string) => (id ? campaignColors[id] ?? "var(--series-1)" : "var(--text-muted)");

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-4">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Which campaign brought the leads
        </h2>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {spendLabel} spend joined to CRM leads by campaign attribution ·{" "}
          <span className="tnum">{formatNumber(totalLeads)}</span> attributed leads
        </p>
      </div>
      <div className="table-scroll border-t" style={{ borderColor: "var(--border)" }}>
        <table className="w-full text-[13px]">
          <thead>
            <tr style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold tracking-wider uppercase">
                Campaign
              </th>
              <th className="px-4 py-2.5 text-right text-[11px] font-semibold tracking-wider uppercase">
                Spend
              </th>
              <th className="hidden px-4 py-2.5 text-right text-[11px] font-semibold tracking-wider uppercase sm:table-cell">
                Link clicks
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold tracking-wider uppercase">
                Leads
              </th>
              <th className="px-4 py-2.5 text-right text-[11px] font-semibold tracking-wider uppercase">
                CP-Lead
              </th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => {
              const key = c.campaignId || "unattributed";
              return (
                <tr key={key} className="row-hover border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="px-4 py-3" style={{ color: c.campaignId ? "var(--text-primary)" : "var(--text-muted)" }}>
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: colorFor(c.campaignId) }}
                        aria-hidden="true"
                      />
                      <span className="max-w-[240px] truncate" title={c.campaignName}>
                        {c.campaignName}
                      </span>
                      <span
                        className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide uppercase"
                        style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
                      >
                        {c.platform === "google" ? "Google" : "Meta"}
                      </span>
                    </span>
                  </td>
                  <td className="tnum px-4 py-3 text-right" style={{ color: "var(--text-secondary)" }}>
                    {formatCurrency(c.spend, currency)}
                  </td>
                  <td className="tnum hidden px-4 py-3 text-right sm:table-cell" style={{ color: "var(--text-secondary)" }}>
                    {formatNumber(c.linkClicks)}
                  </td>
                  {/* Leads with an inline share bar — the visual answer to "which campaign". */}
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <span
                        className="tnum w-6 shrink-0 text-right font-semibold"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {formatNumber(c.leads)}
                      </span>
                      <span className="hidden min-w-0 flex-1 sm:block">
                        <span
                          className="block h-2 rounded-full"
                          style={{
                            width: `${maxLeads > 0 ? Math.max((c.leads / maxLeads) * 100, c.leads > 0 ? 4 : 0) : 0}%`,
                            background: colorFor(c.campaignId),
                          }}
                        />
                      </span>
                    </span>
                  </td>
                  <td className="tnum px-4 py-3 text-right font-semibold" style={{ color: "var(--text-primary)" }}>
                    {formatCurrency(c.cpLead, currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The most consequential warning in the app.
 *
 * Until the webhook fires, no funnel history is being recorded — and GHL has no
 * stage-history API, so that data cannot be recovered later by any means.
 */
function NoWebhookBanner({ slug }: { slug: string }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-[10px] border p-4"
      style={{
        borderColor: "var(--status-critical)",
        background: "color-mix(in srgb, var(--status-critical) 8%, transparent)",
      }}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
        style={{ background: "var(--status-critical)" }}
      >
        ✕
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          No GHL webhook events received yet — funnel history is not being recorded
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          GoHighLevel has no stage-history API. Every day this stays unconnected
          is a day of pipeline history that cannot be recovered later.
        </p>
      </div>
      <Link
        href={`/c/${slug}/setup`}
        className="shrink-0 rounded-[8px] px-3 py-2 text-[13px] font-medium text-white"
        style={{ background: "var(--status-critical)" }}
      >
        Finish setup
      </Link>
    </div>
  );
}

function AttributionBanner({
  slug,
  platform,
}: {
  slug: string;
  platform: AdPlatform;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-[10px] border p-4"
      style={{
        borderColor: "var(--status-warning)",
        background: "color-mix(in srgb, var(--status-warning) 10%, transparent)",
      }}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
        style={{ background: "var(--status-warning)", color: "#0b0b0b" }}
      >
        !
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          Spend recorded, but no leads qualified as paid
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          {platform === "google"
            ? "Cost metrics will show a dash. Either the gclid isn't being captured in the ad URLs, or these clicks aren't reaching the CRM as leads."
            : "Cost metrics will show a dash. Either URL parameters are missing from the ads, or the Facebook lead tag is not being applied."}
        </p>
      </div>
      <Link
        href={`/c/${slug}/setup`}
        className="shrink-0 rounded-[8px] border px-3 py-2 text-[13px] font-medium"
        style={{
          borderColor: "var(--border-strong)",
          color: "var(--text-secondary)",
        }}
      >
        Check settings
      </Link>
    </div>
  );
}

/**
 * Always states which leads these numbers describe.
 *
 * Without this the filter is invisible: a viewer sees "12 leads" with no way to
 * know whether that is the whole pipeline or only the Facebook-sourced share.
 * Showing the excluded count makes the difference explicit rather than a thing
 * you have to remember.
 */
function LeadFilterNote({
  filter,
  slug,
  platform,
  staff,
}: {
  filter: {
    mode: "all" | "attributed" | "tagged" | "either";
    tag: string;
    total: number;
    paid: number;
  };
  slug: string;
  platform: AdPlatform;
  staff: boolean;
}) {
  const excluded = filter.total - filter.paid;

  // Google leads are matched by their own attribution (a Google click id or
  // campaign id) and ignore the Meta mode/tag entirely, so describe that rather
  // than the Facebook filter the numbers were NOT computed from.
  const description =
    platform === "google"
      ? "Counting leads with a Google click ID (gclid) or Google campaign ID"
      : filter.mode === "all"
        ? "Counting every lead in the pipeline — cost metrics include organic and referral leads"
        : filter.mode === "attributed"
          ? "Counting only leads with a Facebook campaign ID"
          : filter.mode === "tagged"
            ? `Counting only leads tagged "${filter.tag}"`
            : `Counting leads with a Facebook campaign ID or tagged "${filter.tag}"`;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[8px] border px-3 py-2 text-xs"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
    >
      <span style={{ color: "var(--text-secondary)" }}>{description}</span>
      {excluded > 0 && filter.mode !== "all" && (
        <span className="tnum" style={{ color: "var(--text-muted)" }}>
          · {excluded} non-paid lead{excluded === 1 ? "" : "s"} excluded
        </span>
      )}
      {staff && (
        <Link
          href={`/c/${slug}/setup`}
          className="ml-auto hover:underline"
          style={{ color: "var(--text-muted)" }}
        >
          Change
        </Link>
      )}
    </div>
  );
}
