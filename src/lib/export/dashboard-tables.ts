import type { DashboardData, DeferredTables } from "@/lib/metrics/dashboard";
import type { BreakdownKey } from "@/db/schema";
import { buildInsights } from "@/lib/metrics/insights";
import { DIMENSION_LABEL } from "@/lib/metrics/lead-sources";
import { STAGE_LABELS } from "@/lib/stages";
import { PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";
import { rangeLabel } from "@/lib/dates";
import {
  KPI_OPTIONS,
  VIEW_SECTION_OPTIONS,
  type KpiId,
  type ReportView,
} from "@/lib/report/view";
import type { SectionId } from "@/lib/dashboard/registry";
import { money, num, percent, text, type Cell, type CsvTable } from "./csv";
import { campaignsTable, dailyTable, leadsTable, periodsTable } from "./datasets";

/**
 * The "Dashboard" export as spreadsheet tables: one per chosen section that has
 * a tabular form, in the order the dashboard shows them.
 *
 * Sections whose meaning is a picture (a heatmap, a speed-to-lead curve) have
 * no honest table, so they are listed on the first sheet as "in the PDF and
 * share link only" rather than dropped without a word.
 *
 * Built from the SAME `DashboardData` the dashboard renders, so a number in the
 * spreadsheet is the number on the screen — never a second query that could
 * disagree with it.
 */

export interface DashboardSheet {
  name: string;
  table: CsvTable;
}

const BREAKDOWN_LABEL: Record<BreakdownKey, string> = {
  region: "Region",
  placement: "Placement",
  device: "Device",
  age: "Age",
  gender: "Gender",
};

const platformName = (p: AdPlatform) => (p === "meta" ? "Facebook" : PLATFORM_LABEL[p]);

/** The rule deciding which leads count, in the dashboard's own words. */
function leadRule(platform: AdPlatform, filter: DashboardData["leadFilter"]): string {
  if (platform === "google") return "Leads with a Google click ID (gclid) or Google campaign ID";
  if (platform === "tiktok") return "Leads with a TikTok click ID or TikTok campaign ID";
  switch (filter.mode) {
    case "all":
      return "Every lead in the pipeline";
    case "attributed":
      return "Leads with a Facebook campaign ID";
    case "tagged":
      return `Leads tagged "${filter.tag}"`;
    default:
      return `Leads with a Facebook campaign ID or tagged "${filter.tag}"`;
  }
}

function aboutTable(
  data: DashboardData,
  view: ReportView,
  platform: AdPlatform,
): CsvTable {
  const label = (id: SectionId) =>
    VIEW_SECTION_OPTIONS.find((o) => o.id === id)?.label ?? id;
  const chosen = view.sections.filter((s) => s !== "lead_filter_note");
  const pdfOnly = chosen.filter(
    (s) => !VIEW_SECTION_OPTIONS.find((o) => o.id === s)?.tabular,
  );
  const rows: Cell[][] = [
    [text("Client"), text(data.client.name)],
    [text("Period"), text(rangeLabel(data.range.startKey, data.range.endKey))],
    [text("Platform"), text(platformName(platform))],
    [text("Timezone"), text(data.client.timezone)],
    [text("Currency"), text(data.client.currency)],
    [text("Leads counted"), text(leadRule(platform, data.leadFilter))],
    [text("Sections"), text(chosen.map(label).join(", "))],
  ];
  if (pdfOnly.length > 0) {
    rows.push([
      text("In the PDF and share link only"),
      text(`${pdfOnly.map(label).join(", ")} (charts with no table form)`),
    ]);
  }
  return { headers: ["Item", "Detail"], rows };
}

function kpiTable(data: DashboardData, kpis: readonly KpiId[]): CsvTable {
  const { current, previous, deltas, results } = data;
  const missing = (p: typeof current) =>
    (p.revenue?.wonOpps ?? 0) > 0 && (p.revenue?.wonWithValue ?? 0) === 0;
  // The platform's results are one type for both periods (see `summarizeResults`).
  const counted = results.type !== null;
  const decimals = results.type?.decimals ?? 0;
  const pick: Record<KpiId, (p: typeof current, which: "cur" | "prev") => Cell> = {
    spend: (p) => money(p.ads.spend),
    new_lead: (p) => num(p.funnel.new_lead),
    cpLead: (p) => money(p.derived.cpLead),
    results: (_p, which) =>
      num(!counted ? null : which === "cur" ? results.count : results.previousCount, decimals),
    cpResult: (_p, which) => money(which === "cur" ? results.costPer : results.previousCostPer),
    appointment_booked: (p) => num(p.funnel.appointment_booked),
    showed: (p) => num(p.funnel.showed),
    closed_won: (p) => num(p.funnel.closed_won),
    // Blank, not $0, when deals closed without a value — see the dashboard tile.
    revenue: (p) => money(missing(p) ? null : (p.revenue?.revenue ?? null)),
    roas: (p) => num(p.derived.roas, 2),
  };
  // "Results (Website leads)": a count needs its kind beside it in a sheet too.
  const label = (k: (typeof KPI_OPTIONS)[number]) =>
    (k.id === "results" || k.id === "cpResult") && results.type && data.platform !== "google"
      ? `${k.label} (${results.type.label})`
      : k.label;
  return {
    headers: ["Metric", "This period", "Previous period", "Change %"],
    rows: KPI_OPTIONS.filter((k) => kpis.includes(k.id)).map((k) => [
      text(label(k)),
      pick[k.id](current, "cur"),
      pick[k.id](previous, "prev"),
      percent(k.id === "revenue" && missing(current) ? null : (deltas[k.id] ?? null)),
    ]),
  };
}

function insightsTable(data: DashboardData): CsvTable {
  return {
    headers: ["What changed"],
    rows: buildInsights(data).map((i) => [text(i.text)]),
  };
}

function anomaliesTable(data: DashboardData): CsvTable {
  return {
    headers: ["From", "To", "Metric", "Value", "Usual", "Direction", "Note"],
    rows: data.anomalies.findings.map((a) => [
      text(a.startKey),
      text(a.endKey),
      text(a.label),
      num(a.value, 2),
      num(a.baseline, 2),
      text(a.direction),
      text(a.text),
    ]),
  };
}

function forecastTable(data: DashboardData): CsvTable {
  const f = data.forecast;
  const rows: Cell[][] = f.metrics.map((m) => [
    text(m.label),
    m.key === "spend" ? money(m.observed) : num(m.observed),
    m.key === "spend" ? money(m.projected) : num(m.projected),
    m.key === "spend" ? money(m.low) : num(m.low),
    m.key === "spend" ? money(m.high) : num(m.high),
    m.key === "spend" ? money(m.previous) : num(m.previous),
  ]);
  rows.push([
    text("Cost per lead"),
    money(f.observedCpl),
    money(f.projectedCpl),
    text(null),
    text(null),
    text(null),
  ]);
  return {
    headers: [`${f.monthKey} — metric`, "So far", "Projected month", "Low", "High", "Previous month"],
    rows,
  };
}

function funnelTable(data: DashboardData): CsvTable {
  return {
    headers: ["Stage", "Entered in period", "% of previous stage"],
    rows: data.funnel.map((s) => [
      text(STAGE_LABELS[s.stage]),
      num(s.count),
      percent(s.conversionFromPrevious),
    ]),
  };
}

function creativesTable(data: DashboardData): CsvTable {
  return {
    headers: [
      "Ad",
      "Type",
      "Spend",
      "Impressions",
      "Link clicks",
      "Leads",
      "Appointments",
      "Won",
      "Revenue",
      "Campaigns",
    ],
    rows: data.creatives.map((c) => [
      text(c.adName ?? c.title ?? c.creativeKey),
      text(c.creativeType),
      money(c.totals.spend),
      num(c.totals.impressions),
      num(c.totals.linkClicks),
      num(c.totals.leads),
      num(c.outcome?.appointments ?? null),
      num(c.outcome?.deals ?? null),
      money(c.outcome?.revenue ?? null),
      text(c.campaignNames.join(", ")),
    ]),
  };
}

function breakdownsTable(data: DashboardData): CsvTable {
  const rows: Cell[][] = [];
  for (const g of data.breakdowns.groups) {
    if (g.missing) continue;
    for (const s of g.segments) {
      rows.push([
        text(BREAKDOWN_LABEL[g.key] ?? g.key),
        text(s.value),
        money(s.spend),
        num(s.impressions),
        num(s.linkClicks),
        num(s.leads),
        money(s.cpLead),
        percent(s.shareOfSegmented),
      ]);
    }
  }
  return {
    headers: [
      "Breakdown",
      "Segment",
      "Spend",
      "Impressions",
      "Link clicks",
      "Leads",
      "Cost per lead",
      "Share of spend",
    ],
    rows,
  };
}

function leadSourcesTable(data: DashboardData): CsvTable {
  const rows: Cell[][] = [];
  for (const g of data.leadSources.groups) {
    for (const r of g.rows) {
      rows.push([
        text(DIMENSION_LABEL[g.dimension]),
        text(r.title || r.value),
        num(r.leads),
        num(r.appts),
        num(r.won),
        percent(r.bookRate),
      ]);
    }
  }
  return {
    headers: ["Grouped by", "Source", "Leads", "Appointments", "Won", "Book %"],
    rows,
  };
}

function callListTable(data: DashboardData): CsvTable {
  return {
    headers: ["Name", "Phone", "Lead arrived", "Working days waiting", "Stage", "Campaign"],
    rows: data.uncalled.rows.map((r) => [
      text(r.name),
      text(r.phone),
      text(r.leadAt),
      num(r.workingDaysWaiting),
      text(r.stageLabel ?? r.ghlStageName),
      text(r.campaignName),
    ]),
  };
}

/**
 * Every table for a view, in dashboard order. `deferred` is needed only when
 * the report tables are chosen; pass null otherwise.
 */
export function buildDashboardSheets(input: {
  data: DashboardData;
  deferred: DeferredTables | null;
  view: ReportView;
  platform: AdPlatform;
}): DashboardSheet[] {
  const { data, deferred, view, platform } = input;
  const out: DashboardSheet[] = [];
  for (const id of view.sections) {
    switch (id) {
      case "lead_filter_note":
        out.push({ name: "About", table: aboutTable(data, view, platform) });
        break;
      case "kpis":
        out.push({ name: "Headline numbers", table: kpiTable(data, view.kpis) });
        break;
      case "insights":
        out.push({ name: "What changed", table: insightsTable(data) });
        break;
      case "anomalies":
        out.push({ name: "Unusual days", table: anomaliesTable(data) });
        break;
      case "forecast":
        out.push({ name: "Where this month lands", table: forecastTable(data) });
        break;
      case "funnel":
        out.push({ name: "Funnel", table: funnelTable(data) });
        break;
      case "trend":
        out.push({ name: "Daily", table: dailyTable(data.daily) });
        break;
      case "campaigns":
        out.push({ name: "Campaigns", table: campaignsTable(data.campaignStages.rows) });
        break;
      case "creatives":
        out.push({ name: "Creatives", table: creativesTable(data) });
        break;
      case "breakdowns":
        out.push({ name: "Where the money went", table: breakdownsTable(data) });
        break;
      case "lead_sources":
        out.push({ name: "Lead sources", table: leadSourcesTable(data) });
        break;
      case "uncalled":
        out.push({ name: "Call these people", table: callListTable(data) });
        break;
      case "pipeline":
        out.push({ name: "Leads", table: leadsTable(data.leads) });
        break;
      case "report_tables":
        if (deferred) {
          out.push(
            { name: "Moving averages", table: periodsTable(deferred.movingAverages, "Window") },
            {
              name: "7-day change",
              table: periodsTable(
                [deferred.sevenDayChange.current, deferred.sevenDayChange.previous],
                "Period",
              ),
            },
            { name: "14-day daily", table: dailyTable(deferred.fourteenDayDaily) },
            { name: "Month on month", table: periodsTable(deferred.monthOnMonth, "Month") },
          );
        }
        break;
      default:
        // Charts and prose: listed on the About sheet, no table of their own.
        break;
    }
  }
  return out;
}
