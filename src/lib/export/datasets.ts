import { COLUMNS, valueFor, type MetricValues } from "@/lib/metrics/table-columns";
import type { DailyPoint, LeadRow, PeriodMetrics } from "@/lib/metrics/queries";
import type { CampaignStageRow } from "@/lib/metrics/campaign-stages";
/*
 * Type-only, and it has to stay that way. `ExportMenu` is a server component
 * that imports `DATASETS` from this file to render the menu; a value import of
 * `dashboard.ts` here would drag the entire metrics layer into that render for
 * four labels and four descriptions.
 */
import type { DashboardData, DeferredTables } from "@/lib/metrics/dashboard";
import { STAGE_LABELS } from "@/db/schema";
import { money, num, percent, text, type Cell, type CsvTable } from "./csv";

/**
 * The exportable datasets.
 *
 * ── The rule this file follows: export what is on the screen ──────────
 *
 * Every dataset here reuses the same `COLUMNS` array the report tables render
 * from, and reads its values through the same `valueFor`. Not similarity —
 * identity. The alternative is a second list of metrics that drifts from the
 * first, and then a client reconciling their spreadsheet against the dashboard
 * finds a column that disagrees and has no way to tell which one is wrong.
 *
 * The consequence is worth stating: a column added to the report tables appears
 * in the export automatically, and one removed disappears. That is the intent.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────
 *
 * · **Nothing is rounded for display.** Money carries two decimals because
 *   money has two decimals; counts carry none because a lead is an integer.
 *   Percentages carry two because that is what the dashboard shows. Beyond
 *   that, no formatting — no `$`, no thousands separators, no `%`. Those turn a
 *   number into a string on import and the column stops summing.
 * · **No totals row.** A spreadsheet sums a column in one keystroke, and a
 *   totals row inside the data breaks sorting and filtering for everyone who
 *   does. More importantly it would have to sum `reach`, which is not additive.
 */

export type DatasetId = "daily" | "monthly" | "campaigns" | "leads";

export const DATASETS: ReadonlyArray<{
  id: DatasetId;
  label: string;
  description: string;
  /** True when the rows carry personal data — see the route's audit entry. */
  personal?: boolean;
}> = [
  {
    id: "daily",
    label: "Daily",
    description: "One row per day in the selected range, every metric.",
  },
  {
    id: "monthly",
    label: "Month on month",
    description: "One row per calendar month, trailing 12. Ignores the date range.",
  },
  {
    id: "campaigns",
    label: "Campaigns",
    description: "One row per campaign, with cost at each funnel stage.",
  },
  {
    id: "leads",
    label: "Leads",
    description: "One row per paid lead: who they are and where they sit now.",
    personal: true,
  },
];

export const DATASET_IDS = DATASETS.map((d) => d.id);

export function isDatasetId(v: string): v is DatasetId {
  return (DATASET_IDS as readonly string[]).includes(v);
}

/** The metric columns, shared by the daily and monthly datasets. */
function metricCells(row: MetricValues): Cell[] {
  return COLUMNS.map((c) => {
    const v = valueFor(row, c.key);
    if (c.kind === "currency") return money(v);
    if (c.kind === "percent") return percent(v);
    return num(v);
  });
}

const METRIC_HEADERS = COLUMNS.map((c) => c.label);

export function dailyTable(daily: readonly DailyPoint[]): CsvTable {
  return {
    headers: ["Date", ...METRIC_HEADERS],
    rows: daily.map((d) => [text(d.dateKey), ...metricCells(d)]),
  };
}

/**
 * Month on month.
 *
 * 🔴 The label is the month, and the two date columns beside it are not
 * decoration. These rows come from `monthOnMonth`, which is a fixed trailing 12
 * months and does NOT respond to the date picker — so a file exported with a
 * 7-day range selected still contains a year. Without the bounds spelled out
 * per row, a reader has every reason to assume the export honours the range
 * they were looking at.
 */
export function monthlyTable(months: readonly PeriodMetrics[]): CsvTable {
  return {
    headers: ["Month", "From", "To", ...METRIC_HEADERS],
    rows: months.map((m) => [
      text(m.label),
      text(m.window.startKey),
      text(m.window.endKey),
      ...metricCells(m),
    ]),
  };
}

export function campaignsTable(rows: readonly CampaignStageRow[]): CsvTable {
  return {
    headers: [
      "Campaign",
      "Campaign ID",
      "Platform",
      "Spend",
      "Impressions",
      "Link clicks",
      "Leads",
      "Appointments",
      "Shows",
      "Won",
      "CP-Lead",
      "CP-Appt",
      "CP-Show",
      "CP-Won",
    ],
    rows: rows.map((r) => [
      text(r.campaignName),
      /*
       * As TEXT, not a number. Meta campaign ids are 17-digit integers, and a
       * spreadsheet parsing one as a number rounds it to 15 significant digits
       * and renders it `1.20363E+16` — so the id both looks wrong and no longer
       * matches Ads Manager, which is the one thing this column is for.
       */
      text(r.campaignId),
      text(r.platform),
      money(r.spend),
      num(r.impressions),
      num(r.linkClicks),
      num(r.counts.new_lead),
      num(r.counts.appointment_booked),
      num(r.counts.showed),
      num(r.counts.closed_won),
      money(r.costs.new_lead.cost),
      money(r.costs.appointment_booked.cost),
      money(r.costs.showed.cost),
      money(r.costs.closed_won.cost),
    ]),
  };
}

/**
 * One row per lead.
 *
 * 🔴 **Name only — no email, no phone.** They are in the schema and they are
 * not in this file. A CSV is the least controlled artifact this product
 * produces: it leaves the session, lands in a downloads folder, and gets
 * forwarded. The dashboard itself never renders a lead's email or phone either,
 * so exporting them would put more personal data into a file on someone's
 * laptop than the product shows on screen — a strictly worse place for it to
 * live.
 *
 * The purpose this dataset actually serves is reconciliation: which leads are
 * counted, at which stage, from which campaign. Contact details are in GHL,
 * which is the system of record for them and has its own access control.
 */
export function leadsTable(leads: readonly LeadRow[]): CsvTable {
  return {
    headers: [
      "Lead",
      "Created",
      "Stage",
      "GHL stage",
      "Pipeline",
      "Status",
      "Campaign",
      "Campaign ID",
      "Value",
    ],
    rows: leads.map((l) => [
      text(l.name),
      text(l.createdAt),
      text(l.canonicalStage ? STAGE_LABELS[l.canonicalStage] : null),
      /*
       * Both the canonical stage and the client's own GHL stage name. They
       * differ — that mapping is what makes this multi-tenant — and a client
       * reconciling against their own GHL needs to see the name they use.
       */
      text(l.ghlStageName),
      text(l.ghlPipelineName),
      text(l.status),
      text(l.campaignName),
      text(l.campaignId),
      /*
       * Zero here means "no deal value recorded", which for most of this book is
       * every row — operators do not reliably set values in GHL. Left as the
       * stored number rather than blanked, because blanking would erase the
       * difference between a $0 deal and an unrecorded one, and the column
       * heading already says what it is.
       */
      money(l.value),
    ]),
  };
}

/**
 * Which rows each dataset is built from.
 *
 * ── 🔴 Why this is a Record and not a switch ──────────────────────────
 *
 * The route used to choose a builder with a nested ternary whose final branch
 * was `leadsTable` — the one dataset carrying people's names. That meant any
 * dataset id the ternary did not recognise served the LEAD LIST, under the
 * unrecognised dataset's filename, and recorded `personal: false` in the audit
 * log while doing it. Only `isDatasetId` stood in the way, and it stood in the
 * way of unknown strings, not of a new `DatasetId` whose branch someone forgot
 * to add.
 *
 * `Record<DatasetId, …>` makes that omission a compile error instead. Adding an
 * id to the union without adding a builder here does not build, which is the
 * only form of this guarantee that survives a hurried change.
 *
 * ── The two shapes, and why `monthly` needs its own ───────────────────
 *
 * Most datasets read the range the operator selected, so they come from
 * `loadDashboard` and the range is already known. `monthOnMonth` does not: it
 * is a fixed trailing twelve months regardless of the picker, so it loads from
 * `loadDeferredTables` and has to report the bounds it actually contains —
 * otherwise the filename claims a range the rows do not cover.
 */
export type DatasetBuilder =
  | { source: "dashboard"; build: (d: DashboardData) => CsvTable }
  | {
      source: "deferred";
      build: (t: DeferredTables) => CsvTable;
      /** The bounds the rows really span, for the filename and the footnote. */
      range: (t: DeferredTables) => readonly [string, string];
    };

export const DATASET_BUILDERS: Record<DatasetId, DatasetBuilder> = {
  daily: { source: "dashboard", build: (d) => dailyTable(d.daily) },
  campaigns: {
    source: "dashboard",
    build: (d) => campaignsTable(d.campaignStages.rows),
  },
  leads: { source: "dashboard", build: (d) => leadsTable(d.leads) },
  monthly: {
    source: "deferred",
    build: (t) => monthlyTable(t.monthOnMonth),
    /*
     * 🔴 Min and max, not first and last. `trailingMonths` returns the months
     * NEWEST FIRST, so first/last gave start = this month and end = eleven
     * months ago — start after end. For CSV that only garbled the filename;
     * once the bounds went into a render token it failed the render page's
     * `start > end` guard, so every month-on-month PDF was a PDF of a 404.
     * Order-independent, so a future change to `trailingMonths` cannot bring
     * it back. Date keys are ISO, so string comparison is date comparison.
     */
    range: (t) => {
      const starts = t.monthOnMonth.map((m) => m.window.startKey).sort();
      const ends = t.monthOnMonth.map((m) => m.window.endKey).sort();
      return [starts[0] ?? "", ends[ends.length - 1] ?? ""] as const;
    },
  },
};

/**
 * Where the source query stops, for datasets that have a ceiling.
 *
 * 🔴 `getLeads` is called with a hard `LIMIT 2000` and says nothing about it.
 * Past that the file simply ends, and a client reconciling a busy month against
 * their CRM finds a shortfall with no explanation available anywhere on the
 * page or in the file.
 *
 * In a codebase that writes four paragraphs on why an empty cell must not
 * become `0`, a silently truncated export is out of character. The route turns
 * a hit here into a response header and an audit field, and the PDF prints it
 * as a footnote.
 */
export const DATASET_ROW_CAP: Partial<Record<DatasetId, number>> = {
  leads: 2000,
};
