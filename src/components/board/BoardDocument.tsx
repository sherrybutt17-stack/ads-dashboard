import type { CSSProperties, ReactNode } from "react";
import type { Client } from "@/db/schema";
import type { ClientBranding } from "@/lib/branding";
import { accentFor } from "@/lib/branding";
import { getAgencyLogoDataUri, type AgencySettings } from "@/lib/branding-store";
import { rangeLabel, windowFromKeys } from "@/lib/dates";
import { comparisonBasis } from "@/lib/dashboard/range";
import { ROWS_PER_PAGE, boxHeightPx, cellRect, paginate } from "@/lib/board/grid";
import { leadPlatforms } from "@/lib/board/leads";
import { buildRegistry, type CustomMetric } from "@/lib/board/registry";
import type { BoardData, BoardWidget as Widget, WidgetData } from "@/lib/board/types";
import { leadFilterDescription } from "@/lib/metrics/lead-filter-copy";
import { PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";
import { BoardWidget } from "./BoardWidget";
import { StatsProvider } from "./StatsContext";

/** US Letter, landscape, in CSS pixels at 96 per inch — the sheet both the renderer and Cmd-P lay out. */
export const PAGE_W = 1056;
export const PAGE_H = 816;
const PAD = 32;
const CONTENT_W = PAGE_W - PAD * 2;
/**
 * The sheet, top to bottom: 32px margin, a 40px header, an 8px gap, twelve
 * board rows (656px), and what is left — 48px — for a footer of at most two
 * short lines, then the bottom margin. A footer that needed more would be
 * clipped on a full page, so it is written to fit, not stretched to taste.
 */
const GRID_H = boxHeightPx(ROWS_PER_PAGE);

const MISSING: WidgetData = { kind: "unavailable", tone: "problem", title: "This widget could not be loaded" };

/**
 * A board as a document: landscape pages, each widget at an exact pixel size.
 *
 * One component behind the share link, the print view and the PDF, so what a
 * client is sent, what they print and what the renderer captures are the same
 * page — the rule `ReportDocument` follows for the report.
 *
 * Pages are cut by `paginate`, which never cuts through a widget: a chart
 * split across two sheets is two wrong charts. When no clean cut fits a page
 * (two tall widgets staggered side by side), that page is drawn at its natural
 * size and scaled down to fit, rather than sliced.
 *
 * Logos are inlined as data URIs: the asset route needs a session, and a share
 * link's reader and the PDF renderer have none.
 */
export async function BoardDocument({
  client,
  branding,
  agency,
  logo,
  widgets,
  data,
  rangeStart,
  rangeEnd,
  toolbar,
  metrics,
  syncedAt,
}: {
  client: Client;
  branding: ClientBranding;
  agency: AgencySettings;
  /** The client's logo as a data URI — see `loadBoardDocument`. */
  logo: string | null;
  widgets: readonly Widget[];
  data: BoardData;
  rangeStart: string;
  rangeEnd: string;
  /** Rendered above the pages and never printed — a print button, an expiry note. */
  toolbar?: ReactNode;
  /** The agency metrics the numbers were computed with (`loadBoardDocument`). */
  metrics: readonly CustomMetric[];
  /**
   * When the ad figures last synced, across every platform the client has
   * (`loadBoardDocument`). Required, so a new caller cannot quietly fall back
   * to `client.lastSyncedAt` — Meta's alone, and empty for a client without it.
   */
  syncedAt: Date | null;
}) {
  // Skipped when the mark is off: reading a logo to discard it is work for nothing.
  const agencyLogo =
    agency.hasLogo && agency.agencyMarkMode !== "none" ? await getAgencyLogoDataUri(client.agencyId) : null;

  const brandName = branding.displayName ?? client.name;
  const accent = accentFor(client.id, branding);
  const accentVars = { "--accent": accent.color, "--accent-glow": accent.glow } as CSSProperties;
  const basis = comparisonBasis(windowFromKeys(rangeStart, rangeEnd, client.timezone), client.timezone);
  const range = { start: rangeStart, end: rangeEnd };
  const period = rangeLabel(rangeStart, rangeEnd);
  const showPlatform = new Set(widgets.flatMap((w) => ("platform" in w ? [w.platform] : []))).size > 1;
  const leadFilter = { mode: client.paidLeadFilter, tag: client.paidLeadTag };
  const leads = leadPlatforms(widgets, buildRegistry(metrics)).map((p) => ({
    platform: p,
    text: leadFilterDescription(p, leadFilter),
  }));
  // A section heading starts the next sheet rather than ending this one.
  const pages = paginate(widgets, ROWS_PER_PAGE, {
    keepWithNext: (w) => w.kind === "text" && w.size === "heading",
  });
  /*
   * 🔴 Not `client.lastSyncedAt`, which this read. That column is written by
   * the Meta sync alone, so every sheet of a TikTok-only client's board — in
   * print, in the PDF and behind a share link — dropped its "as at" line, as if
   * the figures on it had never been synced. One time for the document because
   * the footer has one line for it; see `BoardContext.syncedAt` for why the
   * newest.
   */
  const lastSynced = syncedAt?.toISOString() ?? null;

  return (
    /*
     * `paper`: always the light theme, as the PDF is — see the rule in
     * globals.css. The page ground is painted here too, so a reader whose
     * dashboard is dark does not see the sheets floating on a dark page.
     */
    <div
      className="paper flex min-h-full flex-1 flex-col"
      style={{ ...accentVars, background: "var(--surface-page)" }}
    >
      {/* This document's sheets are landscape; the report's stay portrait. */}
      <style>{"@page { size: 11in 8.5in; margin: 0; }"}</style>
      {toolbar}
      <StatsProvider metrics={[...metrics]}>
      <div className="overflow-x-auto">
        <main
          className="board-doc-pages mx-auto flex w-full flex-col items-center gap-6 px-4 py-6"
          style={{ minWidth: PAGE_W + 32 }}
        >
          {pages.length === 0 ? (
            <Sheet>
              <SheetHeader logo={logo} brandName={brandName} period={period} first page={1} of={1} />
              <p className="m-auto text-[14px]" style={{ color: "var(--text-muted)" }}>
                This board is empty.
              </p>
            </Sheet>
          ) : (
            pages.map((page, i) => {
              // A page that needed more than twelve rows is drawn at its natural
              // size and scaled to fit, never cut.
              const width = CONTENT_W / page.zoom;
              const height = boxHeightPx(page.rows);
              return (
                <Sheet key={page.start}>
                  <SheetHeader
                    logo={logo}
                    brandName={brandName}
                    period={period}
                    first={i === 0}
                    page={i + 1}
                    of={pages.length}
                  />
                  <div
                    className="relative mt-2 shrink-0"
                    style={{ width: CONTENT_W, height: Math.min(GRID_H, height * page.zoom) }}
                  >
                    <div
                      className="absolute top-0 left-0"
                      style={{
                        width,
                        height,
                        ...(page.zoom < 1
                          ? { transform: `scale(${page.zoom})`, transformOrigin: "0 0" }
                          : {}),
                      }}
                    >
                      {page.boxes.map((box) => {
                        const rect = cellRect(box, width);
                        return (
                          <div
                            key={box.id}
                            className="absolute"
                            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                          >
                            <BoardWidget
                              widget={box}
                              data={data[box.id] ?? MISSING}
                              slug={client.slug}
                              range={range}
                              basis={basis}
                              showPlatform={showPlatform}
                              fixed={{ width: rect.width, height: rect.height }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <SheetFooter
                    leads={leads}
                    agency={agency}
                    agencyLogo={agencyLogo}
                    contactLine={branding.reportContactLine}
                    syncedAt={lastSynced}
                  />
                </Sheet>
              );
            })
          )}
        </main>
      </div>
      </StatsProvider>
    </div>
  );
}

function Sheet({ children }: { children: ReactNode }) {
  return (
    <section
      className="board-page flex shrink-0 flex-col overflow-hidden rounded-[var(--radius-sm)] border"
      style={{
        width: PAGE_W,
        height: PAGE_H,
        padding: PAD,
        background: "var(--surface-app)",
        borderColor: "var(--border)",
      }}
    >
      {children}
    </section>
  );
}

function SheetHeader({
  logo,
  brandName,
  period,
  first,
  page,
  of,
}: {
  logo: string | null;
  brandName: string;
  period: string;
  first: boolean;
  page: number;
  of: number;
}) {
  const Name = first ? "h1" : "p";
  return (
    <header className="flex h-10 shrink-0 items-center gap-3">
      {logo ? (
        // Inlined bytes; see the component note.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt={brandName} className="h-9 w-auto max-w-[180px] shrink-0 object-contain" />
      ) : (
        <div
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] text-[16px] font-bold text-white"
          style={{
            background:
              "linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 50%, #0d1b30) 100%)",
          }}
        >
          {brandName.trim().charAt(0).toUpperCase() || "•"}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <Name
          className="truncate text-[18px] leading-tight font-semibold"
          style={{ color: "var(--text-primary)", letterSpacing: "-0.012em" }}
        >
          {brandName}
        </Name>
        <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
          Performance board · <span className="tnum">{period}</span>
        </p>
      </div>
      {of > 1 && (
        <span className="tnum shrink-0 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Page {page} of {of}
        </span>
      )}
    </header>
  );
}

/**
 * The foot of every sheet: which leads the figures count, who prepared the
 * board, and when the ad figures were last synced — on every page, because a
 * sheet separated from the stack still has to say what it is.
 *
 * The agency mark follows the report's rules (`agencyMarkMode`): "none" is a
 * real choice to leave the document unsigned, and the wordmark replaces the
 * name rather than repeating it.
 */
function SheetFooter({
  leads,
  agency,
  agencyLogo,
  contactLine,
  syncedAt,
}: {
  leads: Array<{ platform: AdPlatform; text: string }>;
  agency: AgencySettings;
  agencyLogo: string | null;
  contactLine: string | null;
  syncedAt: string | null;
}) {
  const markName = agency.agencyName?.trim() || null;
  const showMark = agency.agencyMarkMode !== "none" && markName !== null;
  return (
    <div
      className="mt-auto flex flex-wrap items-end justify-between gap-x-6 gap-y-1 pt-2 text-[10.5px] leading-snug"
      style={{ color: "var(--text-muted)" }}
    >
      <p className="min-w-0 flex-1">
        {leads.map((l, i) => (
          <span key={l.platform}>
            {i > 0 && " · "}
            {leads.length > 1 && `${PLATFORM_LABEL[l.platform]}: `}
            {l.text}
          </span>
        ))}
      </p>
      <p className="flex shrink-0 items-center gap-1.5">
        {showMark && (
          <>
            {agency.agencyMarkMode === "prepared_by" ? "Prepared by " : ""}
            {agencyLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={agencyLogo} alt={markName ?? ""} className="inline-block h-3.5 w-auto max-w-[120px] object-contain" />
            ) : (
              <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{markName}</strong>
            )}
          </>
        )}
        {contactLine && <span>{showMark ? " · " : ""}{contactLine}</span>}
        {syncedAt && (
          <span className="tnum">
            {showMark || contactLine ? " · " : ""}Ad figures as at {syncedAt.slice(0, 16).replace("T", " ")} UTC
          </span>
        )}
      </p>
    </div>
  );
}
