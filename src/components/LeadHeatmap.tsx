"use client";

import { useState } from "react";
import type { LeadHeatmap as LeadHeatmapData } from "@/lib/metrics/queries";

/**
 * When paid leads arrive — weekday × hour.
 *
 * A single-hue SEQUENTIAL scale (surface → accent), because the encoded quantity
 * is magnitude, not identity: darker = more leads. Never a rainbow. The busiest
 * cells are called out directly so the actionable read ("run ads Tue evening")
 * survives even without studying the grid.
 *
 * Bucketed in the client's timezone upstream, so "7pm" means 7pm where the ads
 * run. Distinct-opportunity counts, so the totals reconcile with the New leads
 * KPI rather than counting a bounced lead twice.
 */

// Display Monday-first — a business week reads better than Sun-first.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_TICKS: Record<number, string> = { 0: "12a", 6: "6a", 12: "12p", 18: "6p" };

function hourLabel(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base}${period}`;
}

function cellColor(n: number, max: number): string {
  if (n <= 0 || max <= 0) return "var(--surface-2)";
  // 14%→96% accent over the surface — a clean light→dark single-hue ramp.
  const pct = 14 + Math.round((n / max) * 82);
  return `color-mix(in srgb, var(--accent) ${pct}%, var(--surface-2))`;
}

export function LeadHeatmap({ data }: { data: LeadHeatmapData }) {
  const [hover, setHover] = useState<{ d: number; h: number; n: number } | null>(
    null,
  );

  // Peak cell, for the headline callout.
  let peak = { d: -1, h: -1, n: 0 };
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (data.grid[d][h] > peak.n) peak = { d, h, n: data.grid[d][h] };
    }
  }

  return (
    <section className="card p-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          When leads arrive
        </h2>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          Paid leads by weekday and hour, in the client&apos;s timezone
        </span>
      </div>

      {data.total === 0 ? (
        <div
          className="mt-4 rounded-[10px] border border-dashed p-6 text-center text-sm"
          style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}
        >
          No paid leads arrived in this period.
        </div>
      ) : (
        <>
          {peak.n > 0 && (
            <p className="mb-3 text-[13px]" style={{ color: "var(--text-secondary)" }}>
              Busiest:{" "}
              <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                {DAY_LABELS[peak.d]} {hourLabel(peak.h)}–{hourLabel((peak.h + 1) % 24)}
              </span>{" "}
              · <span className="tnum">{peak.n}</span> lead{peak.n === 1 ? "" : "s"}
            </p>
          )}

          <div className="table-scroll">
            <div style={{ minWidth: 620 }}>
              {/* Grid: day-label column + 24 hour columns. */}
              <div
                className="grid gap-[3px]"
                style={{ gridTemplateColumns: "34px repeat(24, 1fr)" }}
              >
                {DAY_ORDER.map((d) => (
                  <div key={`row-${d}`} className="contents">
                    <div
                      className="flex items-center pr-1 text-[11px] font-medium"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {DAY_LABELS[d]}
                    </div>
                    {Array.from({ length: 24 }, (_, h) => {
                      const n = data.grid[d][h];
                      const active = hover?.d === d && hover?.h === h;
                      return (
                        <div
                          key={`${d}-${h}`}
                          onMouseEnter={() => setHover({ d, h, n })}
                          onMouseLeave={() => setHover(null)}
                          className="rounded-[3px]"
                          style={{
                            aspectRatio: "1 / 1",
                            minHeight: 16,
                            background: cellColor(n, data.max),
                            boxShadow: active
                              ? "0 0 0 1.5px var(--text-primary)"
                              : n > 0
                                ? "inset 0 0 0 0.5px rgba(255,255,255,0.05)"
                                : "none",
                            transition: "box-shadow .12s ease",
                          }}
                          aria-label={`${DAY_LABELS[d]} ${hourLabel(h)}: ${n} leads`}
                        />
                      );
                    })}
                  </div>
                ))}

                {/* Hour axis ticks. */}
                <div />
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={`tick-${h}`}
                    className="pt-1 text-center text-[9px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {HOUR_TICKS[h] ?? ""}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Legend + live hover readout. */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
              <span>Less</span>
              {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                <span
                  key={t}
                  className="inline-block h-3 w-3 rounded-[3px]"
                  style={{ background: cellColor(t * data.max, data.max) }}
                />
              ))}
              <span>More</span>
            </div>
            <div className="text-xs tnum" style={{ color: "var(--text-secondary)", minHeight: 16 }}>
              {hover && (
                <>
                  {DAY_LABELS[hover.d]} {hourLabel(hover.h)} ·{" "}
                  <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    {hover.n}
                  </span>{" "}
                  lead{hover.n === 1 ? "" : "s"}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
