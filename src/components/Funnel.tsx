"use client";

import { STAGE_LABELS, type CanonicalStage } from "@/lib/stages";
import {
  formatPercent,
  formatNumber,
  type FunnelStep,
} from "@/lib/metrics/compute";

/**
 * The pipeline funnel with drop-off annotated between stages.
 *
 * This is the view the source spreadsheet could not produce at all: it reported
 * stage totals in separate columns but never showed where people were being
 * lost. 391 leads → 13 appointments → 3 won was in the data; that the 3.3%
 * booking rate was the bottleneck was not visible anywhere.
 *
 * Bars use an ORDINAL blue ramp (one hue, stepped) rather than categorical
 * hues, because the stages are an ordered sequence, not unrelated identities.
 * Steps start at 250 on light to clear the 2:1 contrast floor.
 *
 * Every bar carries a direct label, which also satisfies the relief rule for
 * the lower-contrast steps.
 */

const RAMP = [
  "var(--seq-600)",
  "var(--seq-550)",
  "var(--seq-500)",
  "var(--seq-450)",
  "var(--seq-400)",
];

export function Funnel({
  steps,
  exits,
}: {
  steps: FunnelStep[];
  exits?: { no_show: number; lost: number };
}) {
  const top = steps[0]?.count ?? 0;

  return (
    <div className="card p-5">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2
          className="text-sm font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          Pipeline funnel
        </h2>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          Entered each stage in this period
        </span>
      </div>

      {top === 0 ? (
        <EmptyFunnel />
      ) : (
        <div className="mt-4 flex flex-col">
          {steps.map((step, i) => {
            const pctOfTop = top > 0 ? step.count / top : 0;
            return (
              <div key={step.stage}>
                <div
                  className="grid items-center gap-3 py-1.5"
                  style={{
                    gridTemplateColumns: "minmax(96px, 150px) 1fr auto",
                  }}
                >
                  <div
                    className="truncate text-xs sm:text-[13px]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {STAGE_LABELS[step.stage as CanonicalStage]}
                  </div>

                  <div className="min-w-0">
                    <div
                      className="h-8 rounded-r-[5px] transition-[width] duration-500"
                      style={{
                        width: `${Math.max(pctOfTop * 100, step.count > 0 ? 2 : 0)}%`,
                        // Top-lit sheen over the ordinal step — dimension, not a
                        // new hue. The ramp identity is preserved; the gradient
                        // only lightens the upper edge.
                        background: `linear-gradient(180deg, color-mix(in srgb, ${
                          RAMP[Math.min(i, RAMP.length - 1)]
                        } 82%, #ffffff) 0%, ${RAMP[Math.min(i, RAMP.length - 1)]} 100%)`,
                        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
                      }}
                    />
                  </div>

                  {/* Value in its own column — never spills past the card. */}
                  <span
                    className="tnum shrink-0 pl-1 text-right text-[13px] font-semibold whitespace-nowrap"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {formatNumber(step.count)}
                  </span>
                </div>

                {/* Drop-off between this stage and the next. */}
                {i < steps.length - 1 && (
                  <div
                    className="grid gap-3"
                    style={{ gridTemplateColumns: "minmax(96px, 150px) 1fr" }}
                  >
                    <div />
                    <div
                      className="flex items-center gap-2 border-l pl-3 text-[11px]"
                      style={{
                        borderColor: "var(--border)",
                        color: "var(--text-muted)",
                        minHeight: 22,
                      }}
                    >
                      <span className="tnum">
                        {formatPercent(steps[i + 1].conversionFromPrevious, 1)}{" "}
                        continue
                      </span>
                      {steps[i + 1].droppedFromPrevious !== null &&
                        steps[i + 1].droppedFromPrevious! > 0 && (
                          <span className="tnum">
                            · {formatNumber(steps[i + 1].droppedFromPrevious)}{" "}
                            lost
                          </span>
                        )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {exits && (
        <div
          className="mt-4 flex gap-6 border-t pt-3 text-xs"
          style={{ borderColor: "var(--border)" }}
        >
          <ExitStat label="No show" value={exits.no_show} />
          <ExitStat label="Lost" value={exits.lost} />
        </div>
      )}
    </div>
  );
}

function ExitStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span
        className="tnum font-semibold"
        style={{ color: "var(--text-secondary)" }}
      >
        {formatNumber(value)}
      </span>
    </div>
  );
}

/**
 * Honest empty state.
 *
 * "No leads entered the pipeline" is a real, meaningful answer — distinct from
 * "we cannot reach your CRM", which the health checklist reports separately.
 * Conflating the two is how the old sheet misled for months.
 */
function EmptyFunnel() {
  return (
    <div
      className="mt-4 rounded-[10px] border border-dashed p-6 text-center"
      style={{ borderColor: "var(--border-strong)" }}
    >
      <p
        className="text-sm font-medium"
        style={{ color: "var(--text-secondary)" }}
      >
        No leads entered the pipeline in this period
      </p>
      <p
        className="mx-auto mt-1 max-w-md text-xs"
        style={{ color: "var(--text-muted)" }}
      >
        This reflects real recorded activity, not a connection problem. Check
        the setup page if you expected leads here.
      </p>
    </div>
  );
}
