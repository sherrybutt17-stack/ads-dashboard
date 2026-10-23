import { REPORT_SECTIONS, SECTIONS, type SectionId } from "@/lib/dashboard/registry";

/**
 * What a shared or exported dashboard includes: which sections, and which of
 * the headline numbers.
 *
 * One definition behind every surface that produces a client document — the
 * Export menu (CSV, Excel, PDF), share links and the report preview — so "what I
 * ticked" means the same thing in all of them.
 *
 * Pure and dependency-free apart from the section registry (itself import-free),
 * so the pickers can use it in the browser and the routes can validate with it.
 */

/** The headline tiles, in the order the dashboard shows them. */
export const KPI_OPTIONS = [
  { id: "spend", label: "Ad spend" },
  { id: "new_lead", label: "New leads" },
  { id: "cpLead", label: "Cost per lead" },
  { id: "appointment_booked", label: "Appointments" },
  { id: "showed", label: "Showed" },
  { id: "closed_won", label: "Closed / won" },
  { id: "revenue", label: "Revenue" },
  { id: "roas", label: "ROAS" },
  { id: "results", label: "Results" },
  { id: "cpResult", label: "Cost per result" },
] as const;

export type KpiId = (typeof KPI_OPTIONS)[number]["id"];

const KPI_IDS: readonly KpiId[] = KPI_OPTIONS.map((k) => k.id);

export function isKpiId(v: unknown): v is KpiId {
  return typeof v === "string" && (KPI_IDS as readonly string[]).includes(v);
}

/**
 * Sections that have a CSV/Excel form. The rest are charts or prose whose
 * meaning is the picture; they appear in PDFs and share links only, and the
 * picker says so rather than quietly leaving them out of a spreadsheet.
 */
export const TABULAR_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>([
  "lead_filter_note",
  "insights",
  "anomalies",
  "kpis",
  "forecast",
  "funnel",
  "trend",
  "campaigns",
  "creatives",
  "breakdowns",
  "lead_sources",
  "uncalled",
  "pipeline",
  "report_tables",
]);

/**
 * Always included. It is what tells a reader WHICH leads the numbers count;
 * a document that can omit it reports figures nobody can interpret.
 */
export const ALWAYS_INCLUDED: SectionId = "lead_filter_note";

export interface ViewSectionOption {
  id: SectionId;
  label: string;
  description: string;
  /** Lists people by name and contact details. */
  personal: boolean;
  /** Has a CSV/Excel form. */
  tabular: boolean;
  /** Cannot be unticked. */
  always: boolean;
}

/**
 * Every section a document may include, in dashboard order.
 *
 * Agency-only sections are left out: they are working tools (budget plans,
 * keep/stop verdicts, the summary and commentary editors) rather than results,
 * and the written summary and commentary already appear in a report once they
 * are published.
 */
export const VIEW_SECTION_OPTIONS: readonly ViewSectionOption[] = SECTIONS.map(
  (s, index) => ({ s, index }),
)
  .filter(({ s }) => !s.staffOnly)
  .sort((a, b) => a.s.defaultOrder - b.s.defaultOrder || a.index - b.index)
  .map(({ s }) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    personal: Boolean(s.containsLeadPii),
    tabular: TABULAR_SECTIONS.has(s.id),
    always: s.id === ALWAYS_INCLUDED,
  }));

const SECTION_ORDER = new Map(VIEW_SECTION_OPTIONS.map((o, i) => [o.id, i]));

export interface ReportView {
  /** In dashboard order, always starting with the lead-source note. */
  sections: SectionId[];
  /** Headline numbers to show when `kpis` is among the sections. */
  kpis: KpiId[];
}

/** What every report and share link showed before a choice existed. */
export const DEFAULT_VIEW: ReportView = {
  sections: [...REPORT_SECTIONS],
  kpis: [...KPI_IDS],
};

/**
 * Validate and canonicalise a view from anywhere: a request body, the database,
 * a decoded URL. Unknown ids are dropped, order is fixed to dashboard order, the
 * lead-source note is added, and an empty headline-number choice removes the
 * headline section rather than leaving an empty block.
 *
 * Null when nothing usable remains (no section besides the note).
 */
export function normalizeView(raw: unknown): ReportView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { sections?: unknown; kpis?: unknown };
  if (!Array.isArray(r.sections)) return null;

  const kpis = Array.isArray(r.kpis)
    ? KPI_IDS.filter((k) => (r.kpis as unknown[]).includes(k))
    : [...KPI_IDS];

  const picked = new Set(
    r.sections.filter(
      (s): s is SectionId => typeof s === "string" && SECTION_ORDER.has(s as SectionId),
    ),
  );
  picked.add(ALWAYS_INCLUDED);
  if (kpis.length === 0) picked.delete("kpis");

  const sections = [...picked].sort(
    (a, b) => SECTION_ORDER.get(a)! - SECTION_ORDER.get(b)!,
  );
  if (sections.length <= 1) return null;
  return { sections, kpis };
}

/**
 * Compact, URL- and token-safe form: `s=a,b,c;k=x,y`. Ids are `[a-zA-Z_]`, so
 * the separators cannot collide with them.
 */
export function encodeView(view: ReportView): string {
  return `s=${view.sections.join(",")};k=${view.kpis.join(",")}`;
}

export function decodeView(raw: string | null | undefined): ReportView | null {
  if (!raw || raw.length > 2000) return null;
  const parts = Object.fromEntries(
    raw.split(";").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
    }),
  ) as Record<string, string>;
  if (parts.s === undefined) return null;
  const list = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);
  return normalizeView({
    sections: list(parts.s),
    kpis: parts.k === undefined ? undefined : list(parts.k),
  });
}

export function isDefaultView(view: ReportView): boolean {
  return encodeView(view) === encodeView(DEFAULT_VIEW);
}

/** True when any chosen section lists people by name or contact details. */
export function viewHasPersonal(view: ReportView): boolean {
  return view.sections.some(
    (id) => VIEW_SECTION_OPTIONS.find((o) => o.id === id)?.personal,
  );
}

/** "6 sections · 5 of 10 headline numbers", for the share list. */
export function describeView(view: ReportView): string {
  const n = view.sections.filter((s) => s !== ALWAYS_INCLUDED).length;
  const parts = [`${n} section${n === 1 ? "" : "s"}`];
  if (view.sections.includes("kpis") && view.kpis.length < KPI_IDS.length) {
    parts.push(`${view.kpis.length} of ${KPI_IDS.length} headline numbers`);
  }
  if (viewHasPersonal(view)) parts.push("includes lead names");
  return parts.join(" · ");
}
