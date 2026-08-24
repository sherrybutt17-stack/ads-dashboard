import { Fragment } from "react";
import type { Client } from "@/db/schema";
import type { ClientBranding } from "@/lib/branding";
import { accentFor } from "@/lib/branding";
import {
  getAgencyLogoDataUri,
  getClientLogoDataUri,
  type AgencySettings,
} from "@/lib/branding-store";
import type { DashboardData } from "@/lib/metrics/dashboard";
import type { AdPlatform } from "@/lib/metrics/queries";
import { getAdPipeStatus, getCrmPipeStatus } from "@/lib/metrics/pipe-status";
import { adPipeState, crmPipeState } from "@/components/DataState";
import { buildInsights } from "@/lib/metrics/insights";
import { formatNumber } from "@/lib/metrics/compute";
import { rangeLabel } from "@/lib/dates";
import {
  renderSection,
  CAMPAIGN_DOTS,
  type SectionContext,
} from "@/lib/dashboard/sections";
import { REPORT_SECTIONS } from "@/lib/dashboard/registry";
import { getPublishedSummaries } from "@/lib/ai/store";
import { loadCommentaryForReport } from "@/lib/commentary/report";
import { monthKeyForDateKey } from "@/lib/commentary/model";
import { CommentaryBlock } from "@/components/report/CommentaryBlock";
import { Glossary } from "@/components/report/Glossary";
import { FRAMINGS, FRAMING_LABEL } from "@/lib/ai/framings";
import type { CSSProperties } from "react";

/**
 * The report — the client's document, not the agency's dashboard.
 *
 * One component behind two routes (a signed share link, and the authenticated
 * `/c/<slug>/report`) so the thing a client is sent and the thing staff preview
 * cannot drift apart. A report that renders differently from its preview is a
 * report nobody trusts twice.
 *
 * ── Why these sections and not the whole dashboard ──────────────────────
 *
 * 🔴 **The pipeline explorer is excluded, permanently.** It lists every lead by
 * name, email and phone. A share URL is a bearer credential that travels through
 * mail servers and reply chains, and a board pack does not need forty people's
 * contact details to answer "is the money working?". This is a list of sections
 * rather than "the dashboard minus the chrome" precisely so that adding a new
 * section to the dashboard cannot silently start publishing lead PII.
 *
 * The lead-source note stays, at the top, for everyone. It is what tells the
 * reader WHICH leads these figures count — omitting it to make the page tidier
 * would be the exact silent omission this product exists to replace.
 *
 * ── Why it is a fixed-width column ─────────────────────────────────────
 *
 * A document has a page width. Charts are rendered at a fixed pixel width
 * derived from it, so nothing needs measuring when the browser re-lays-out for
 * print — see `TrendCharts`' `fixedWidth` prop for what that prevents.
 */

/** Content width of a Letter/A4 page at 12mm margins, in CSS pixels. */
export const REPORT_WIDTH = 720;
/** The chart width inside a card, allowing for the card's own padding. */
const CHART_WIDTH = REPORT_WIDTH - 40 - 52;

export interface ReportDocumentProps {
  client: Client;
  branding: ClientBranding;
  agency: AgencySettings;
  data: DashboardData;
  platform: AdPlatform;
  /** Shown under the title. The period is fixed for a share link. */
  rangeStart: string;
  rangeEnd: string;
  /** Rendered above the document — a print button, an "expires" note. */
  toolbar?: React.ReactNode;
}

export async function ReportDocument({
  client,
  branding,
  agency,
  data,
  platform,
  rangeStart,
  rangeEnd,
  toolbar,
}: ReportDocumentProps) {
  const [adPipe, logoDataUri, agencyLogoDataUri, written, commentary] = await Promise.all([
    getAdPipeStatus(client, platform),
    // Inlined, not linked — the asset route requires a session and a share
    // link's reader has none. See `getClientLogoDataUri`.
    branding.hasLogo ? getClientLogoDataUri(client.id) : Promise.resolve(null),
    /*
     * The agency's own wordmark, same inlining and for the same reason.
     *
     * Skipped entirely when the mark is switched off, rather than fetched and
     * then not rendered — `none` means the agency chose not to sign this, and
     * reading its logo out of the database to discard it is work done to
     * produce nothing.
     */
    agency.hasLogo && agency.agencyMarkMode !== "none"
      ? getAgencyLogoDataUri(client.agencyId)
      : Promise.resolve(null),
    /*
     * PUBLISHED summaries only. `getPublishedSummaries` reads the frozen
     * columns, never the working draft, so nothing a model wrote five minutes
     * ago can appear behind a live share link without a person having pressed
     * Publish. That is the whole guarantee of §6.2 and this is the surface it
     * protects.
     */
    getPublishedSummaries({
      clientId: client.id,
      platform,
      rangeStart,
      rangeEnd,
    }),
    /*
     * PUBLISHED commentary only, at both ends: this month's text, and the
     * previous month's published commitments that it answers. A plan that was
     * never published was never shown to this reader, so holding the agency to
     * it on their copy would present a promise they never received.
     *
     * The month is the one the range ENDS in. A report for a calendar month
     * lands on that month; a report for "the last 30 days" lands on the month it
     * finishes in, and the block names its month either way rather than letting
     * the reader assume it describes their window.
     */
    loadCommentaryForReport(client, platform, monthKeyForDateKey(rangeEnd)),
  ]);
  const crmPipe = getCrmPipeStatus(client);

  /*
   * `staff: false` throughout. A report reader is never staff, even when a staff
   * member is the one previewing it — otherwise the preview would show
   * diagnostic banners and setup links that the actual recipient never sees,
   * and the preview would stop being a preview.
   */
  const adState = adPipeState(adPipe, { staff: false, slug: client.slug });
  const crmState = (emptyPanel: boolean) =>
    crmPipeState(crmPipe, { staff: false, slug: client.slug, emptyPanel });

  const { current, daily } = data;
  const currency = data.client.currency;
  const spendLabel = platform === "google" ? "Google" : "Meta";
  const rangeDays = daily.length;
  const basis = rangeDays === 1 ? "previous day" : `previous ${rangeDays} days`;

  const campaignIds = Array.from(
    new Set(
      data.campaigns
        .map((c) => c.campaignId)
        .filter((x): x is string => Boolean(x)),
    ),
  ).sort();
  const campaignColors: Record<string, string> = {};
  campaignIds.forEach((id, i) => {
    campaignColors[id] = CAMPAIGN_DOTS[i % CAMPAIGN_DOTS.length];
  });
  const campaignNames: Record<string, string> = {};
  for (const c of data.campaigns) {
    if (c.campaignId) campaignNames[c.campaignId] = c.campaignName;
  }

  const wonOpps = current.revenue?.wonOpps ?? 0;
  const wonWithValue = current.revenue?.wonWithValue ?? 0;
  const valuesMissing = wonOpps > 0 && wonWithValue === 0;
  const revenueFootnote = valuesMissing
    ? `${formatNumber(wonOpps)} closed, no deal value set`
    : wonWithValue > 0 && wonWithValue < wonOpps
      ? `${formatNumber(wonWithValue)} of ${formatNumber(wonOpps)} deals valued`
      : undefined;

  /*
   * The brand colour reaches the report regardless of
   * `brandColorAppliesToDashboard` — that switch exists because a brand red
   * collides with the dashboard's own red/amber/green status encoding, and a
   * report has no status encoding to collide with. It is the client's document.
   */
  const accent = accentFor(client.id, { ...branding, appliesToDashboard: true });
  const brandName = branding.displayName ?? client.name;

  const ctx: SectionContext = {
    data,
    client,
    platform,
    slug: client.slug,
    staff: false,
    currency,
    spendLabel,
    basis,
    insights: buildInsights(data),
    campaignColors,
    campaignNames,
    adState,
    crmState,
    sparkSpend: daily.map((d) => d.ads.spend),
    sparkLeads: daily.map((d) => d.funnel.new_lead),
    sparkAppts: daily.map((d) => d.funnel.appointment_booked),
    sparkWon: daily.map((d) => d.funnel.closed_won),
    valuesMissing,
    revenueFootnote,
    printWidth: CHART_WIDTH,
  };

  const accentVars = {
    "--accent": accent.color,
    "--accent-glow": accent.glow,
  } as CSSProperties;

  return (
    <div style={accentVars}>
      {toolbar}
      <main
        className="mx-auto flex flex-col gap-5 px-4 py-8"
        style={{ maxWidth: REPORT_WIDTH }}
      >
        <header className="avoid-break flex items-start gap-4">
          {logoDataUri ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={logoDataUri}
              alt={brandName}
              className="h-12 w-auto max-w-[200px] shrink-0 object-contain"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[13px] text-[19px] font-bold text-white"
              style={{
                background:
                  "linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 50%, #0d1b30) 100%)",
              }}
            >
              {brandName.trim().charAt(0).toUpperCase() || "•"}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1
              className="truncate text-[22px] leading-tight font-semibold"
              style={{ color: "var(--text-primary)", letterSpacing: "-0.015em" }}
            >
              {brandName}
            </h1>
            <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
              Performance report ·{" "}
              <span className="tnum">{rangeLabel(rangeStart, rangeEnd)}</span>
            </p>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
              {spendLabel} advertising, matched to pipeline outcomes. All figures
              in {client.timezone.replace(/_/g, " ")}.
            </p>
          </div>
        </header>

        {written.length > 0 && (
          <section className="avoid-break">
            {written
              // A stable reading order regardless of the order they were
              // written in: the account, then what went well, then what needs
              // attention, then what happens next.
              .slice()
              .sort(
                (a, b) => FRAMINGS.indexOf(a.framing) - FRAMINGS.indexOf(b.framing),
              )
              .map((w) => (
                <div key={w.framing} className="mb-5 last:mb-0">
                  <p
                    className="text-[11px] tracking-wide uppercase"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {FRAMING_LABEL[w.framing]}
                  </p>
                  <p
                    className="mt-1 text-[15px] leading-snug font-semibold"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {w.headline}
                  </p>
                  {/*
                   * Rendered as plain text with line breaks preserved, not as
                   * markdown. This paragraph came from a model and is displayed
                   * to a third party; running it through an HTML renderer would
                   * turn generated text into an injection surface for the sake
                   * of bold type nobody asked for.
                   */}
                  <p
                    className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-line"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {w.body}
                  </p>
                </div>
              ))}
          </section>
        )}

        {/*
         * Below the written summary and above the figures. The summary reads
         * the period; the commentary answers for it and commits to the next
         * one — so a reader meets the account of the numbers, then the
         * accountability for them, then the numbers themselves.
         */}
        {commentary && <CommentaryBlock commentary={commentary} />}

        {REPORT_SECTIONS.map((id) => (
          <Fragment key={id}>{renderSection(id, ctx)}</Fragment>
        ))}

        {/*
          Last, above the footer. In the app every figure carries its definition
          behind an ⓘ; on paper, in a PDF and in a mail client nobody can open a
          popover, so the audience that most needs these — the client, for whom
          this document IS the product — was the only one who could not reach
          them. Reference material, so it sits after the numbers rather than
          delaying them.
        */}
        <Glossary />

        <ReportFooter
          agency={agency}
          agencyLogoDataUri={agencyLogoDataUri}
          contactLine={branding.reportContactLine}
          syncedAt={data.client.lastSyncedAt}
        />
      </main>
    </div>
  );
}

/**
 * The agency mark, in the one slot that belongs to the agency.
 *
 * `agencyMarkMode` is agency-controlled and has a `none` value, which is a real
 * decision rather than an oversight: an unattributed report is one a client can
 * pass off as in-house work, which weakens the renewal conversation. Shipping
 * all three modes and defaulting to `prepared_by` defers that call to whoever is
 * actually signing the contracts.
 */
function ReportFooter({
  agency,
  agencyLogoDataUri,
  contactLine,
  syncedAt,
}: {
  agency: AgencySettings;
  /** Inlined bytes; null when there is no wordmark or the mark is off. */
  agencyLogoDataUri: string | null;
  contactLine: string | null;
  /** ISO string, as `DashboardData` carries it across the RSC boundary. */
  syncedAt: string | null;
}) {
  /*
   * A mark with no name is not a mark.
   *
   * `agencyMarkMode` defaults to `prepared_by`, so without this an agency whose
   * name cannot be resolved prints the literal words "Prepared by " and then
   * stops — worse than printing nothing, because it reads as a rendering fault
   * on a document that goes to a client. `getAgencySettings` now resolves the
   * tenant's own name, so this is the genuinely-unknown case only.
   */
  const markName = agency.agencyName?.trim() || null;
  const showMark = agency.agencyMarkMode !== "none" && markName !== null;
  const supportEmail = agency.supportEmail?.trim() || null;

  if (!showMark && !contactLine && !supportEmail) return null;

  return (
    <footer
      className="avoid-break mt-2 flex flex-wrap items-baseline justify-between gap-2 border-t pt-4 text-[11px]"
      style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
    >
      <div className="flex flex-col gap-1">
        {showMark && (
          <span className="flex flex-wrap items-center gap-1.5">
            {agency.agencyMarkMode === "prepared_by" ? "Prepared by " : ""}
            {agencyLogoDataUri ? (
              /*
               * The wordmark REPLACES the name rather than sitting beside it.
               * A logo that reads "Peak Digital" next to the words "Peak
               * Digital" is a design mistake in print, and the alt text keeps
               * the name available to anything that cannot show the image —
               * including a plain-text email client rendering this document.
               */
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={agencyLogoDataUri}
                alt={markName ?? ""}
                className="inline-block h-4 w-auto max-w-[140px] object-contain align-middle"
              />
            ) : (
              <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>
                {markName}
              </strong>
            )}
          </span>
        )}
        {contactLine && <span>{contactLine}</span>}
        {supportEmail && (
          // The agency's own reply-to, distinct from the client's contact line
          // above it: one says who to contact about the account, the other is
          // whatever the client wanted printed on their own report.
          <span>
            Questions?{" "}
            <a
              href={`mailto:${supportEmail}`}
              style={{ color: "var(--text-secondary)" }}
            >
              {supportEmail}
            </a>
          </span>
        )}
      </div>
      {/*
        Dated, because a printed report outlives its context. Six weeks later
        nobody remembers whether the PDF on the desk is the July one, and a
        figure with no as-at date is a figure someone will quote as current.
      */}
      {syncedAt && (
        <span className="tnum">
          Ad figures as at {syncedAt.slice(0, 16).replace("T", " ")} UTC
        </span>
      )}
    </footer>
  );
}
