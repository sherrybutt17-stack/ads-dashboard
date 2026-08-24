import {
  pctChange,
  type AdTotals,
  type DerivedMetrics,
  type FunnelCounts,
} from "./compute";

/**
 * The report tables' column set, and the pure logic over it.
 *
 * Deliberately NOT in `MetricsTable.tsx`. That file is a `"use client"` module,
 * and a server component that imports a plain FUNCTION from it and calls it
 * crosses React's client/server boundary — "Attempted to call changesBetween()
 * from the server". That error passes typecheck, passes `next build`, and only
 * fires at render, where it took out the entire report-tables Suspense boundary:
 * the four tables rendered as a permanent skeleton and the 7-day change table
 * never showed a single delta.
 *
 * The rule this file encodes: data and pure functions live in `lib/`, components
 * live in `components/`. Crossing that boundary is a runtime failure, not a
 * style preference.
 */

export interface MetricValues {
  funnel: FunnelCounts;
  ads: AdTotals;
  derived: DerivedMetrics;
}

export type ColumnKind = "currency" | "number" | "percent";

export interface ColumnDef {
  key: string;
  label: string;
  kind: ColumnKind;
}

export const COLUMNS: readonly ColumnDef[] = [
  { key: "spend", label: "Spend", kind: "currency" },
  { key: "new_lead", label: "Leads", kind: "number" },
  { key: "contacted", label: "Contacted", kind: "number" },
  { key: "appointment_booked", label: "Appts", kind: "number" },
  { key: "showed", label: "Shown", kind: "number" },
  { key: "no_show", label: "No Show", kind: "number" },
  { key: "closed_won", label: "Won", kind: "number" },
  { key: "cpLead", label: "CP-Lead", kind: "currency" },
  { key: "cpAppt", label: "CP-Appt", kind: "currency" },
  { key: "cpShow", label: "CP-Show", kind: "currency" },
  { key: "cpWon", label: "CP-Won", kind: "currency" },
  { key: "bookPct", label: "Book %", kind: "percent" },
  { key: "showPct", label: "Show %", kind: "percent" },
  { key: "closePct", label: "Close %", kind: "percent" },
  { key: "optinPct", label: "Optin %", kind: "percent" },
  { key: "ctr", label: "CTR", kind: "percent" },
  { key: "cpm", label: "CPM", kind: "currency" },
  { key: "cpc", label: "CPC", kind: "currency" },
] as const;

/** Columns that begin a new conceptual group (cost block, then rate block). A
 *  faint left rule here lets the eye find "the cost columns" without counting. */
export const GROUP_STARTS = new Set(["cpLead", "bookPct"]);

export function valueFor(row: MetricValues, key: string): number | null {
  if (key === "spend") return row.ads.spend;
  if (key === "linkClicks") return row.ads.linkClicks;
  if (key in row.funnel) return row.funnel[key as keyof FunnelCounts];
  return row.derived[key as keyof DerivedMetrics] ?? null;
}

/**
 * Period-over-period change for every column.
 *
 * Derived from `COLUMNS` so it cannot drift: a column added above automatically
 * gets a change value instead of silently rendering blank in the change row.
 *
 * This exists because the "7-day change" table shipped showing **no changes at
 * all** — `MetricsTable` supported `showChanges`/`changes` and the page passed
 * neither, so a table whose entire purpose is the comparison displayed two rows
 * of raw values and nothing else.
 */
export function changesBetween(
  current: MetricValues,
  previous: MetricValues,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const c of COLUMNS) {
    out[c.key] = pctChange(valueFor(current, c.key), valueFor(previous, c.key));
  }
  return out;
}
