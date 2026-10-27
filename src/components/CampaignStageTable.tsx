"use client";

import { Fragment, useState } from "react";
import {
  COST_STAGES,
  type CampaignStages,
  type CostAtStage,
  type CostStage,
  type StageOption,
} from "@/lib/metrics/campaign-stages";
import { formatCurrency, formatNumber, DASH } from "@/lib/metrics/compute";
import { DataState, PipeNotice, type DataStateProps } from "@/components/DataState";
import { CategoryChart } from "@/components/CategoryChart";

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

  /*
   * Ad sets open under their campaign, one campaign at a time or all at once.
   * The chart stays per campaign: ad sets are the drill-down, not the summary.
   */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const splittable = (r: (typeof rows)[number]) => (r.adsets ?? []).some((a) => a.adsetId !== "");
  const anySplit = rows.some(splittable);
  const allOpen = anySplit && rows.filter(splittable).every((r) => open.has(r.campaignId));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--section-ink, var(--text-primary))" }}>
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

        <div className="flex flex-wrap items-center gap-2">
        {anySplit && (
          <button
            type="button"
            onClick={() => setOpen(allOpen ? new Set() : new Set(rows.filter(splittable).map((r) => r.campaignId)))}
            aria-pressed={allOpen}
            className="rounded-[var(--radius-sm)] px-2.5 py-1 text-[12px] font-medium"
            style={{ background: "var(--surface-2)", color: "var(--text-secondary)" }}
          >
            {allOpen ? "Hide ad sets" : "Show all ad sets"}
          </button>
        )}
        <div
          className="flex flex-wrap gap-1 rounded-[var(--radius-sm)] p-0.5"
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
                className="rounded-[var(--radius-xs)] px-2.5 py-1 text-[12px] font-medium transition-colors"
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
          {/*
            The selected stage, as a shape. It redraws when the stage control
            changes, which is the whole argument for that control — the table
            re-ranks and the chart changes shape at the same time, so the fact
            that the biggest source of leads is not the biggest source of closed
            deals is something you SEE rather than something you reconstruct by
            reading two orderings.

            Colours come from `campaignColors`, not from the chart's own ramp,
            so a campaign is the same hue here as in the dot beside its name in
            the table below and in the explorer on the Overview tab.
          */}
          <div className="border-t px-5 pt-4" style={{ borderColor: "var(--border)" }}>
            <CategoryChart
              storageKey="campaignStages"
              measure={option.label}
              format={{ kind: "count" }}
              height={200}
              data={rows.map((r) => ({
                key: r.campaignId || r.campaignName,
                label: r.campaignName,
                value: r.counts[stage],
                color: colorFor(r.campaignId),
              }))}
              empty={`No campaign reached ${option.noun} in this period`}
            />
          </div>

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
                  const key = r.campaignId || "unattributed";
                  const canOpen = splittable(r);
                  const isOpen = canOpen && open.has(r.campaignId);
                  const adsets = isOpen
                    ? [...(r.adsets ?? [])].sort((a, b) =>
                        // Same order as the campaigns, the remainder always last.
                        a.adsetId === "" ? 1 : b.adsetId === "" ? -1 :
                        b.counts[stage] - a.counts[stage] || b.spend - a.spend,
                      )
                    : [];
                  return (
                    <Fragment key={key}>
                    <tr className="row-hover border-t" style={{ borderColor: "var(--border)" }}>
                      <td
                        className="px-4 py-3"
                        style={{
                          color: r.campaignId
                            ? "var(--text-primary)"
                            : "var(--text-muted)",
                        }}
                      >
                        <span className="flex items-center gap-2">
                          {anySplit &&
                            (canOpen ? (
                              <button
                                type="button"
                                onClick={() => toggle(r.campaignId)}
                                aria-expanded={isOpen}
                                aria-label={`${isOpen ? "Hide" : "Show"} ad sets for ${r.campaignName}`}
                                className="-ml-1 grid h-5 w-5 shrink-0 place-items-center rounded-[var(--radius-xs)]"
                                style={{ color: "var(--text-muted)" }}
                              >
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 10 10"
                                  aria-hidden="true"
                                  style={{ transform: isOpen ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
                                >
                                  <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </button>
                            ) : (
                              <span className="-ml-1 inline-block h-5 w-5 shrink-0" aria-hidden="true" />
                            ))}
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
                            className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide uppercase"
                            style={{
                              background: "var(--surface-2)",
                              color: "var(--text-muted)",
                            }}
                          >
                            {r.platform === "google" ? "Google" : "Meta"}
                          </span>
                        </span>
                      </td>
                      <StageCells
                        spend={r.spend}
                        counts={r.counts}
                        cost={r.costs[stage]}
                        stage={stage}
                        max={max}
                        color={colorFor(r.campaignId)}
                        currency={currency}
                        options={data.options}
                      />
                    </tr>
                    {adsets.map((a) => (
                      <tr
                        key={`${key}:${a.adsetId || "rest"}`}
                        className="border-t"
                        style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
                      >
                        <td
                          className="py-2 pr-4 pl-14"
                          style={{ color: a.adsetId ? "var(--text-secondary)" : "var(--text-muted)" }}
                        >
                          <span className="flex items-center gap-2">
                            <span
                              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ background: colorFor(r.campaignId), opacity: a.adsetId ? 1 : 0.4 }}
                              aria-hidden="true"
                            />
                            <span
                              className="max-w-[240px] truncate"
                              title={
                                a.adsetId
                                  ? a.adsetName
                                  : "Spend from days without ad-level detail, and leads whose ad set wasn't recorded"
                              }
                            >
                              {a.adsetName}
                            </span>
                          </span>
                        </td>
                        <StageCells
                          spend={a.spend}
                          counts={a.counts}
                          cost={a.costs[stage]}
                          stage={stage}
                          max={max}
                          color={colorFor(r.campaignId)}
                          currency={currency}
                          options={data.options}
                          child
                        />
                      </tr>
                    ))}
                    </Fragment>
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
            {data.adsetSplit && rows.some((r) => r.campaignId) && (
              data.adsetSplit.since === null ? (
                <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  No ad-level history yet, so campaigns can&rsquo;t be split by ad set. Import
                  ad-level detail on the Connections page to add it.
                </p>
              ) : data.adsetSplit.partial ? (
                <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  Some spend isn&rsquo;t split by ad set — days without ad-level detail (it starts{" "}
                  {dayLabel(data.adsetSplit.since)}). Import ad-level detail on the Connections page
                  to fill them in.
                </p>
              ) : null
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** `2026-10-03` → `Oct 3, 2026`, without a timezone shift. */
function dayLabel(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Spend, funnel, selected stage and its cost — the same four cells for a campaign or an ad set. */
function StageCells({
  spend,
  counts,
  cost,
  stage,
  max,
  color,
  currency,
  options,
  child = false,
}: {
  spend: number;
  counts: Record<CostStage, number>;
  cost: CostAtStage;
  stage: CostStage;
  max: number;
  color: string;
  currency: string;
  options: StageOption[];
  child?: boolean;
}) {
  const py = child ? "py-2" : "py-3";
  return (
    <>
      <td className={`tnum px-4 ${py} text-right`} style={{ color: "var(--text-secondary)" }}>
        {formatCurrency(spend, currency)}
      </td>

      {/* Every stage at once, so the selector de-emphasises rather than hides —
          and the drop-off is where the eye already is. */}
      <td
        className={`tnum hidden px-4 ${py} whitespace-nowrap md:table-cell`}
        style={{ color: "var(--text-muted)" }}
      >
        {COST_STAGES.map((s, i) => (
          <span key={s}>
            {i > 0 && <span aria-hidden> › </span>}
            <span
              style={{
                color: s === stage ? "var(--text-primary)" : "var(--text-muted)",
                fontWeight: s === stage ? 600 : 400,
              }}
              title={options.find((o) => o.stage === s)!.label}
            >
              {formatNumber(counts[s])}
            </span>
          </span>
        ))}
      </td>

      <td className={`px-4 ${py}`}>
        <span className="flex items-center gap-2">
          <span
            className={`tnum w-6 shrink-0 text-right ${child ? "font-medium" : "font-semibold"}`}
            style={{ color: "var(--text-primary)" }}
          >
            {formatNumber(counts[stage])}
          </span>
          <span className="hidden min-w-0 flex-1 sm:block">
            <span
              className="block h-2 rounded-full"
              style={{
                width: `${
                  max > 0 ? Math.max((counts[stage] / max) * 100, counts[stage] > 0 ? 4 : 0) : 0
                }%`,
                background: color,
                opacity: child ? 0.6 : 1,
              }}
            />
          </span>
        </span>
      </td>

      <td className={`tnum px-4 ${py} text-right`}>
        {cost.cost === null ? (
          <span style={{ color: "var(--text-muted)" }}>{DASH}</span>
        ) : (
          <>
            <span style={{ color: "var(--text-primary)" }}>{formatCurrency(cost.cost, currency)}</span>
            {/*
             * 🔴 The denominator, always, never suppressed. "$1,345" from one
             * deal is not a rate; "$1,345 from 1" is a fact the reader can
             * weigh. Hiding small samples instead would make the tool look like
             * it knows less than it does.
             */}
            <span className="ml-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
              from {formatNumber(cost.conversions)}
            </span>
          </>
        )}
      </td>
    </>
  );
}
