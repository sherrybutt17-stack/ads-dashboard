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
import { definitionFor } from "@/lib/metrics/definitions";
// COLUMNS / valueFor / changesBetween live in lib/ because SERVER components
// call them. Importing a plain function out of this "use client" module and
// invoking it server-side throws at render — it passes typecheck and passes
// `next build`, and it took out the whole report-tables boundary once already.
import { COLUMNS, GROUP_STARTS, valueFor } from "@/lib/metrics/table-columns";
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

/**
 * Every column's formula, on demand, in one place.
 *
 * A per-header popover is impossible here — the table scrolls inside
 * `overflow-x: auto`, which clips any absolutely-positioned panel. That
 * constraint turns out to favour the reader: eighteen columns, of which three
 * are percentages with three DIFFERENT denominators, are best understood side
 * by side rather than one hover at a time. Collapsed by default, so it costs
 * nothing to anyone who already knows.
 */
function ColumnDefinitions() {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t px-5" style={{ borderColor: "var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 py-2 text-[11px] font-medium"
        style={{ color: "var(--text-muted)" }}
      >
        <Icon name="help" size={12} />
        What these columns mean
      </button>
      {open && (
        <dl className="grid gap-x-6 gap-y-2.5 pb-4 sm:grid-cols-2 xl:grid-cols-3">
          {COLUMNS.map((c) => {
            const def = definitionFor(c.key);
            if (!def) return null;
            return (
              <div key={c.key}>
                <dt
                  className="text-[11px] font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  {c.label}{" "}
                  <span
                    className="font-mono font-normal"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    = {def.formula}
                  </span>
                </dt>
                {def.caveat && (
                  <dd
                    className="mt-0.5 text-[11px] leading-relaxed"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {def.caveat}
                  </dd>
                )}
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
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
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h2>
          {subtitle && (
            <p
              className="mt-0.5 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
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

      {open && <ColumnDefinitions />}

      {open && (
        /* Wide table scrolls inside its own container — the page never
           scrolls horizontally. */
        <div
          className="table-scroll border-t"
          style={{ borderColor: "var(--border)" }}
        >
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
                {COLUMNS.map((c) => {
                  const def = definitionFor(c.key);
                  return (
                    <th
                      key={c.key}
                      // Hover gives the formula immediately; the definitions
                      // panel above carries the same text for keyboard and
                      // touch, which a clipped popover could not.
                      title={
                        def
                          ? `${c.label} = ${def.formula}${def.caveat ? `\n\n${def.caveat}` : ""}`
                          : undefined
                      }
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
                  );
                })}
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
                    const change = showChanges
                      ? row.changes?.[c.key]
                      : undefined;
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
