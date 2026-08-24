"use client";

import { useState } from "react";
import {
  COST_STAGES,
  type CampaignStages,
  type CostStage,
  type StageOption,
} from "@/lib/metrics/campaign-stages";
import { formatCurrency, formatNumber, DASH } from "@/lib/metrics/compute";
import { DataState, PipeNotice, type DataStateProps } from "@/components/DataState";

/**
 * Which campaign brought the *business*, not just the leads.
 *
 * ---
 *
 * WHY A SELECTOR AND NOT SIX MORE COLUMNS
 *
 * The obvious build is appointments, shows, closes and a cost beside each,
 * bolted onto the existing five columns. That is eleven columns of
 * undifferentiated numbers — which is a description of the spreadsheet this
 * product replaced, and the reason nobody noticed six of its blocks were empty.
 *
 * One selector keeps the table at its current width and makes the *comparison*
 * the subject: the same campaigns, re-ranked by how far down the funnel you
 * want to look. Switching from Leads to Closed and watching the order change is
 * the insight; a wide table shows the same data and hides it.
 *
 * The per-row funnel column carries the counts that are not currently selected,
 * so nothing is actually hidden — only de-emphasised.
 */

function LagNote({ option, unmeasurable }: { option: StageOption; unmeasurable: number }) {
  if (option.stage === "new_lead") return null;

  /*
   * 🔴 The caveat that makes a deep-stage cost honest.
   *
   * This column divides the selected period's spend by conversions whose leads
   * arrived earlier. For cost per lead that gap is hours; for cost per closed
   * deal it can be months, and in a period where spend changed sharply the
   * figure moves for reasons that have nothing to do with the advertising.
   */
  const lag =
    option.lagDays === null
      ? unmeasurable > 0
        ? `Most of this account's history arrived as a one-off backfill, so the lag from lead to ${option.noun} cannot be measured yet — it accumulates forward from the first live webhook.`
        : `Too few reached ${option.noun} to measure the lag from lead.`
      : `${option.label} in this period came from leads a median of ${Math.round(option.lagDays)} day${Math.round(option.lagDays) === 1 ? "" : "s"} old.`;

  return (
    <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
      {lag} This column divides <em>this period&rsquo;s</em> spend by them, so it
      moves when budget changes even if the advertising does not.
    </p>
  );
}

export function CampaignStageTable({
  data,
  currency,
  campaignColors,
  spendLabel,
  lagUnmeasurable,
  emptyState,
}: {
  data: CampaignStages;
  currency: string;
  campaignColors: Record<string, string>;
  spendLabel: string;
  lagUnmeasurable: number;
  emptyState?: DataStateProps | null;
}) {
  const [stage, setStage] = useState<CostStage>(data.defaultStage);
  const option = data.options.find((o) => o.stage === stage)!;

  const rows = [...data.rows].sort((a, b) => {
    // Ranked by the selected stage's conversions, then by spend, so switching
    // stage visibly re-orders the table — which is the point of the control.
    const d = b.counts[stage] - a.counts[stage];
    return d !== 0 ? d : b.spend - a.spend;
  });

  const max = rows.reduce((m, r) => Math.max(m, r.counts[stage]), 0);
  const total = rows.reduce((s, r) => s + r.counts[stage], 0);
  const colorFor = (id: string) =>
    id ? (campaignColors[id] ?? "var(--series-1)") : "var(--text-muted)";

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Which campaign brought the {option.noun}
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            {spendLabel} spend joined to CRM outcomes by campaign attribution
            {total > 0 && (
              <>
                {" · "}
                <span className="tnum">{formatNumber(total)}</span> attributed
              </>
            )}
          </p>
        </div>

        <div
          className="flex flex-wrap gap-1 rounded-[9px] p-0.5"
          style={{ background: "var(--surface-2)" }}
          role="group"
          aria-label="Funnel stage"
        >
          {COST_STAGES.map((s) => {
            const o = data.options.find((x) => x.stage === s)!;
            const active = s === stage;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStage(s)}
                aria-pressed={active}
                /*
                 * A stage with nothing in it stays clickable. Disabling it would
                 * hide the difference between "nobody showed up" and "no GHL
                 * stage is mapped to shows" — and the second is a broken setup
                 * that has to be reachable to be noticed.
                 */
                className="rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors"
                style={{
                  background: active ? "var(--surface-1)" : "transparent",
                  color: active
                    ? "var(--text-primary)"
                    : o.total === 0
                      ? "var(--text-muted)"
                      : "var(--text-secondary)",
                  boxShadow: active ? "var(--shadow-sm)" : undefined,
                }}
              >
                {o.label}
                {o.total === 0 && (
                  <span className="ml-1 text-[10px] opacity-70" aria-hidden>
                    0
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="border-t px-5 pb-5" style={{ borderColor: "var(--border)" }}>
          <div className="pt-5">
            <DataState
              {...(emptyState ?? {
                title: `No ${spendLabel} campaigns ran in this period`,
                detail:
                  "The account is connected and reporting — there was no spend in this date range.",
                tone: "neutral" as const,
              })}
              size="compact"
            />
          </div>
        </div>
      ) : (
        emptyState && (
          <div className="px-5 pb-1">
            <PipeNotice {...emptyState} />
          </div>
        )
      )}

      {rows.length > 0 && (
        <>
          <div className="table-scroll border-t" style={{ borderColor: "var(--border)" }}>
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold tracking-wider uppercase">
                    Campaign
                  </th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold tracking-wider uppercase">
                    Spend
                  </th>
                  <th className="hidden px-4 py-2.5 text-left text-[11px] font-semibold tracking-wider uppercase md:table-cell">
                    Funnel
                  </th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold tracking-wider uppercase">
                    {option.label}
                  </th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold tracking-wider uppercase">
                    {option.costLabel}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cost = r.costs[stage];
                  return (
                    <tr
                      key={r.campaignId || "unattributed"}
                      className="row-hover border-t"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <td
                        className="px-4 py-3"
                        style={{
                          color: r.campaignId
                            ? "var(--text-primary)"
                            : "var(--text-muted)",
                        }}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: colorFor(r.campaignId) }}
                            aria-hidden="true"
                          />
                          <span
                            className="max-w-[240px] truncate"
                            title={r.campaignName}
                          >
                            {r.campaignName}
                          </span>
                          <span
                            className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide uppercase"
                            style={{
                              background: "var(--surface-2)",
                              color: "var(--text-muted)",
                            }}
                          >
                            {r.platform === "google" ? "Google" : "Meta"}
                          </span>
                        </span>
                      </td>

                      <td
                        className="tnum px-4 py-3 text-right"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {formatCurrency(r.spend, currency)}
                      </td>

                      {/* Every stage at once, so the selector de-emphasises
                          rather than hides — and the drop-off is where the eye
                          already is. */}
                      <td
                        className="tnum hidden px-4 py-3 whitespace-nowrap md:table-cell"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {COST_STAGES.map((s, i) => (
                          <span key={s}>
                            {i > 0 && <span aria-hidden> › </span>}
                            <span
                              style={{
                                color:
                                  s === stage
                                    ? "var(--text-primary)"
                                    : "var(--text-muted)",
                                fontWeight: s === stage ? 600 : 400,
                              }}
                              title={
                                data.options.find((o) => o.stage === s)!.label
                              }
                            >
                              {formatNumber(r.counts[s])}
                            </span>
                          </span>
                        ))}
                      </td>

                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2">
                          <span
                            className="tnum w-6 shrink-0 text-right font-semibold"
                            style={{ color: "var(--text-primary)" }}
                          >
                            {formatNumber(r.counts[stage])}
                          </span>
                          <span className="hidden min-w-0 flex-1 sm:block">
                            <span
                              className="block h-2 rounded-full"
                              style={{
                                width: `${
                                  max > 0
                                    ? Math.max(
                                        (r.counts[stage] / max) * 100,
                                        r.counts[stage] > 0 ? 4 : 0,
                                      )
                                    : 0
                                }%`,
                                background: colorFor(r.campaignId),
                              }}
                            />
                          </span>
                        </span>
                      </td>

                      <td className="tnum px-4 py-3 text-right">
                        {cost.cost === null ? (
                          <span style={{ color: "var(--text-muted)" }}>{DASH}</span>
                        ) : (
                          <>
                            <span style={{ color: "var(--text-primary)" }}>
                              {formatCurrency(cost.cost, currency)}
                            </span>
                            {/*
                             * 🔴 The denominator, always, never suppressed.
                             * "$1,345" from one deal is not a rate; "$1,345
                             * from 1" is a fact the reader can weigh. Hiding
                             * small samples instead would make the tool look
                             * like it knows less than it does.
                             */}
                            <span
                              className="ml-1.5 text-[11px]"
                              style={{ color: "var(--text-muted)" }}
                            >
                              from {formatNumber(cost.conversions)}
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-1.5 px-5 py-3.5">
            {option.emptyReason && (
              <p
                className="text-xs leading-relaxed"
                style={{ color: "var(--status-warning)" }}
              >
                {option.emptyReason}
              </p>
            )}
            <LagNote option={option} unmeasurable={lagUnmeasurable} />
          </div>
        </>
      )}
    </section>
  );
}
