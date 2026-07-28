"use client";

import { useState } from "react";
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatChange,
  changeSentiment,
  type DerivedMetrics,
  type FunnelCounts,
  type AdTotals,
} from "@/lib/metrics/compute";
import { Icon } from "./Icon";

/**
 * The dense report tables — the sheet's four views, properly typeset.
 *
 * Every figure uses tabular numerals and is right-aligned so columns scan
 * vertically. Undefined values render as an em-dash, never as 0.00 — the
 * distinction between "zero happened" and "we cannot compute this" is the
 * single most important thing these tables communicate, and the source sheet
 * lost it by printing $0.00 for both.
 */

export interface MetricRow {
  label: string;
  funnel: FunnelCounts;
  ads: AdTotals;
  derived: DerivedMetrics;
  /** Optional per-row change values, for the 7-day change view. */
  changes?: Record<string, number | null>;
  emphasis?: boolean;
}

const COLUMNS = [
  { key: "spend", label: "Spend", kind: "currency" as const },
  { key: "new_lead", label: "Leads", kind: "number" as const },
  { key: "contacted", label: "Contacted", kind: "number" as const },
  { key: "appointment_booked", label: "Appts", kind: "number" as const },
  { key: "showed", label: "Shown", kind: "number" as const },
  { key: "no_show", label: "No Show", kind: "number" as const },
  { key: "closed_won", label: "Won", kind: "number" as const },
  { key: "cpLead", label: "CP-Lead", kind: "currency" as const },
  { key: "cpAppt", label: "CP-Appt", kind: "currency" as const },
  { key: "cpShow", label: "CP-Show", kind: "currency" as const },
  { key: "cpWon", label: "CP-Won", kind: "currency" as const },
  { key: "bookPct", label: "Book %", kind: "percent" as const },
  { key: "showPct", label: "Show %", kind: "percent" as const },
  { key: "closePct", label: "Close %", kind: "percent" as const },
  { key: "optinPct", label: "Optin %", kind: "percent" as const },
  { key: "ctr", label: "CTR", kind: "percent" as const },
  { key: "cpm", label: "CPM", kind: "currency" as const },
  { key: "cpc", label: "CPC", kind: "currency" as const },
];

// Columns that begin a new conceptual group (cost block, then rate block). A
// faint left rule here lets the eye find "the cost columns" without counting.
const GROUP_STARTS = new Set(["cpLead", "bookPct"]);

function valueFor(row: MetricRow, key: string): number | null {
  if (key === "spend") return row.ads.spend;
  if (key === "linkClicks") return row.ads.linkClicks;
  if (key in row.funnel) return row.funnel[key as keyof FunnelCounts];
  return row.derived[key as keyof DerivedMetrics] ?? null;
}

function render(value: number | null, kind: string, currency: string): string {
  if (kind === "currency") return formatCurrency(value, currency);
  if (kind === "percent") return formatPercent(value);
  return formatNumber(value);
}

export function MetricsTable({
  title,
  subtitle,
  rows,
  currency = "USD",
  firstColumnLabel = "Period",
  defaultOpen = true,
  showChanges = false,
}: {
  title: string;
  subtitle?: string;
  rows: MetricRow[];
  currency?: string;
  firstColumnLabel?: string;
  defaultOpen?: boolean;
  showChanges?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
        aria-expanded={open}
      >
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
              {subtitle}
            </p>
          )}
        </div>
        <span
          className="flex shrink-0 items-center transition-transform"
          style={{
            color: "var(--text-muted)",
            transform: open ? "rotate(180deg)" : "none",
          }}
          aria-hidden="true"
        >
          <Icon name="chevronDown" size={16} />
        </span>
      </button>

      {open && (
        /* Wide table scrolls inside its own container — the page never
           scrolls horizontally. */
        <div className="table-scroll border-t" style={{ borderColor: "var(--border)" }}>
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ background: "var(--surface-2)" }}>
                <th
                  className="sticky left-0 z-10 px-4 py-2.5 text-left text-[11px] font-medium tracking-wider uppercase"
                  style={{
                    color: "var(--text-muted)",
                    background: "var(--surface-2)",
                  }}
                >
                  {firstColumnLabel}
                </th>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className="px-3 py-2.5 text-right text-[11px] font-medium tracking-wider whitespace-nowrap uppercase"
                    style={{
                      color: "var(--text-muted)",
                      borderLeft: GROUP_STARTS.has(c.key)
                        ? "1px solid var(--border)"
                        : undefined,
                    }}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={`${row.label}-${i}`}
                  className="border-t"
                  style={{
                    borderColor: "var(--border)",
                    background: row.emphasis ? "var(--surface-2)" : undefined,
                  }}
                >
                  <td
                    className="sticky left-0 z-10 px-4 py-2.5 font-medium whitespace-nowrap"
                    style={{
                      color: row.emphasis
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                      background: row.emphasis
                        ? "var(--surface-2)"
                        : "var(--surface-1)",
                      // Accent bar marks the row that matters (e.g. "Last 7 days").
                      boxShadow: row.emphasis
                        ? "inset 3px 0 0 0 var(--accent)"
                        : undefined,
                    }}
                  >
                    {row.label}
                  </td>
                  {COLUMNS.map((c) => {
                    const v = valueFor(row, c.key);
                    const change = showChanges ? row.changes?.[c.key] : undefined;
                    const sentiment =
                      change !== undefined && change !== null
                        ? changeSentiment(c.key, change)
                        : "neutral";
                    return (
                      <td
                        key={c.key}
                        className="tnum px-3 py-2.5 text-right whitespace-nowrap"
                        style={{
                          borderLeft: GROUP_STARTS.has(c.key)
                            ? "1px solid var(--border)"
                            : undefined,
                          color:
                            change !== undefined && change !== null
                              ? sentiment === "good"
                                ? "var(--delta-good)"
                                : sentiment === "bad"
                                  ? "var(--delta-bad)"
                                  : "var(--text-secondary)"
                              : v === null
                                ? "var(--text-muted)"
                                : "var(--text-primary)",
                        }}
                      >
                        {showChanges && change !== undefined
                          ? formatChange(change)
                          : render(v, c.kind, currency)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
