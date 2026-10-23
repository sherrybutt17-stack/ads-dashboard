"use client";

import { useState } from "react";
import { METRICS, metricLabel, type MetricId } from "@/lib/board/catalog";
import { formatMetricValue } from "@/lib/board/format";
import type { TableRow } from "@/lib/board/types";
import type { AdPlatform } from "@/lib/platforms";

/**
 * A board table: one row per campaign, ad, audience segment or day, and the
 * chosen stats as columns.
 *
 * The totals row is computed by the aggregator from summed components — a
 * total CTR is all clicks over all impressions — and includes the rows past
 * the top N, which the footer says. Sorting here only reorders what is shown;
 * the order the board was saved with comes back on reload.
 */
export function BoardTable({
  columns,
  rows,
  totals,
  more,
  currency,
  platform,
  rowHeading,
  maxRows,
}: {
  columns: MetricId[];
  rows: TableRow[];
  totals: Array<number | null>;
  more: number;
  currency: string;
  platform: AdPlatform;
  rowHeading: string;
  /**
   * On paper there is no scrolling: rows past this fold into the total's
   * "includes N more" line, which the totals already count.
   */
  maxRows?: number;
}) {
  const [sort, setSort] = useState<{ index: number; desc: boolean } | null>(null);
  const shown = maxRows !== undefined && rows.length > maxRows ? rows.slice(0, maxRows) : rows;
  const hidden = more + (rows.length - shown.length);

  const ordered = sort
    ? [...shown].sort((a, b) => {
        const av = a.values[sort.index];
        const bv = b.values[sort.index];
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return sort.desc ? bv - av : av - bv;
      })
    : shown;

  const fmt = (m: MetricId, v: number | null) => formatMetricValue(METRICS[m].format, v, currency);

  return (
    // Its own height, scrolling once it outgrows the card — not `flex-1`, which
    // would stretch a four-row table and push its notes to the card's foot.
    <div className="table-scroll min-h-0 overflow-y-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr style={{ color: "var(--text-muted)" }}>
            <th
              scope="col"
              className="sticky left-0 z-[1] py-1.5 pr-3 text-left text-[10.5px] font-semibold tracking-[0.06em] uppercase"
              style={{ background: "var(--card-bg)" }}
            >
              {rowHeading}
            </th>
            {columns.map((m, i) => {
              const active = sort?.index === i;
              return (
                <th
                  key={m}
                  scope="col"
                  aria-sort={active ? (sort!.desc ? "descending" : "ascending") : "none"}
                  className="py-1.5 pl-3 text-right text-[10.5px] font-semibold tracking-[0.06em] whitespace-nowrap uppercase"
                >
                  <button
                    type="button"
                    className="uppercase hover:underline"
                    onClick={() =>
                      setSort((s) => (s?.index === i ? { index: i, desc: !s.desc } : { index: i, desc: true }))
                    }
                    title={`Sort by ${metricLabel(m, platform)}`}
                  >
                    {metricLabel(m, platform)}
                    {active ? (sort!.desc ? " ↓" : " ↑") : ""}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={r.key} className="border-t" style={{ borderColor: "var(--border)" }}>
              <th
                scope="row"
                className="sticky left-0 max-w-[260px] py-1.5 pr-3 text-left font-normal"
                style={{ background: "var(--card-bg)" }}
              >
                <span className="block truncate" style={{ color: "var(--text-primary)" }} title={r.label}>
                  {r.label}
                </span>
                {r.sub && (
                  <span className="block truncate text-[11px]" style={{ color: "var(--text-muted)" }} title={r.sub}>
                    {r.sub}
                  </span>
                )}
              </th>
              {r.values.map((v, i) => (
                <td key={columns[i]} className="tnum py-1.5 pl-3 text-right whitespace-nowrap" style={{ color: "var(--text-primary)" }}>
                  {fmt(columns[i], v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2" style={{ borderColor: "var(--border-strong)" }}>
            <th
              scope="row"
              className="sticky left-0 py-1.5 pr-3 text-left font-semibold"
              style={{ background: "var(--card-bg)", color: "var(--text-primary)" }}
            >
              Total
              {hidden > 0 && (
                <span className="block text-[11px] font-normal" style={{ color: "var(--text-muted)" }}>
                  includes {hidden} more not shown
                </span>
              )}
            </th>
            {totals.map((v, i) => (
              <td key={columns[i]} className="tnum py-1.5 pl-3 text-right font-semibold whitespace-nowrap" style={{ color: "var(--text-primary)" }}>
                {fmt(columns[i], v)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
