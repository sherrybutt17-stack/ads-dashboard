"use client";

import { useState } from "react";
import {
  HORIZON_DAYS,
  type CohortRow,
  type EqualAgeCheck,
  type MaturationReport,
  type StageCurve,
} from "@/lib/metrics/maturation";
import { OUTCOME_STAGES, type OutcomeStage } from "@/lib/metrics/speed-outcome";
import { formatNumber, formatPercent, DASH } from "@/lib/metrics/compute";
import { Icon } from "@/components/Icon";

/**
 * The panel that stops a working campaign being switched off.
 *
 * Its whole job is to make one comparison impossible to get wrong, so the
 * hierarchy is: the like-for-like verdict first (every figure counted), the
 * fill-in curve second (measured), and the projection last and clearly marked
 * as inference. A layout that led with the projected number would be a more
 * impressive screen and a worse decision.
 */

const days = (n: number | null) => (n === null ? DASH : `${Math.round(n)} days`);

/**
 * The fill-in curve, as a small area chart.
 *
 * Hand-drawn SVG rather than Recharts: it is ten points on a fixed 0–90 axis
 * with no interaction, and the chart library costs more to configure into this
 * shape than the path costs to write.
 */
function CurveChart({ c }: { c: StageCurve }) {
  const W = 320;
  const H = 72;
  const x = (d: number) => (d / HORIZON_DAYS) * W;
  const y = (s: number) => H - s * H;
  const pts = [{ day: 0, share: 0 }, ...c.curve];
  const line = pts.map((p) => `${x(p.day).toFixed(1)},${y(p.share).toFixed(1)}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ maxWidth: W, height: "auto" }}
      role="img"
      aria-label={`${c.noun}: share landed by day, over ${HORIZON_DAYS} days`}
    >
      <polygon
        points={`0,${H} ${line} ${W},${y(1)} ${W},${H}`}
        fill="color-mix(in srgb, var(--series-1) 16%, transparent)"
      />
      <polyline points={line} fill="none" stroke="var(--series-1)" strokeWidth={1.75} />
      {c.halfDays !== null && (
        <line
          x1={x(c.halfDays)}
          x2={x(c.halfDays)}
          y1={y(0.5)}
          y2={H}
          stroke="var(--text-muted)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      )}
    </svg>
  );
}

/**
 * 🔴 The finding, and the reason nothing here is a projection.
 *
 * Both cohorts cut to the same age means the only difference left between the
 * two numbers is the advertising. The raw pair is shown alongside precisely
 * because that is the pair the reader arrived with — hiding it would leave them
 * with two contradictory readings and no way to reconcile them.
 */
function EqualAge({ check, noun }: { check: EqualAgeCheck; noun: string }) {
  const tone = check.misleading ? "var(--status-warning)" : "var(--text-muted)";
  return (
    <div
      className="flex items-start gap-2.5 rounded-[10px] p-3.5"
      style={{ background: "var(--surface-2)" }}
    >
      <span className="mt-0.5 shrink-0" style={{ color: tone }}>
        <Icon name={check.misleading ? "alert" : "help"} size={14} />
      </span>
      <div className="text-[13px] leading-relaxed" style={{ color: "var(--text-primary)" }}>
        {check.misleading ? (
          <>
            <strong>{check.recent.label} is not the weaker month.</strong> Side by
            side it shows <span className="tnum">{formatNumber(check.rawRecent)}</span>{" "}
            {noun} against {check.prior.label}&rsquo;s{" "}
            <span className="tnum">{formatNumber(check.rawPrior)}</span> — but{" "}
            {check.prior.label} has had months to fill in and {check.recent.label}{" "}
            is {check.atDays} days old. At the same age,{" "}
            {check.prior.label} had{" "}
            <span className="tnum">{formatNumber(check.prior.converted)}</span> from{" "}
            <span className="tnum">{formatNumber(check.prior.leads)}</span> leads and{" "}
            {check.recent.label} has{" "}
            <span className="tnum">{formatNumber(check.recent.converted)}</span> from{" "}
            <span className="tnum">{formatNumber(check.recent.leads)}</span>.
          </>
        ) : (
          <>
            At {check.atDays} days old, {check.recent.label} has{" "}
            <span className="tnum">{formatNumber(check.recent.converted)}</span> {noun}{" "}
            from <span className="tnum">{formatNumber(check.recent.leads)}</span> leads.{" "}
            {check.prior.label} had{" "}
            <span className="tnum">{formatNumber(check.prior.converted)}</span> from{" "}
            <span className="tnum">{formatNumber(check.prior.leads)}</span> at the same
            point.{" "}
            <span style={{ color: "var(--text-muted)" }}>
              Both counted, neither projected — the only difference left between
              them is the advertising.
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function CohortTable({
  cohorts,
  stage,
  noun,
}: {
  cohorts: CohortRow[];
  stage: OutcomeStage;
  noun: string;
}) {
  return (
    <div className="table-scroll">
      <table className="w-full text-[13px]">
        <thead>
          <tr style={{ color: "var(--text-muted)" }}>
            <th className="py-1.5 pr-3 text-left text-[10.5px] font-semibold tracking-wider uppercase">
              Leads from
            </th>
            <th className="py-1.5 pr-3 text-right text-[10.5px] font-semibold tracking-wider uppercase">
              Leads
            </th>
            <th className="py-1.5 pr-3 text-right text-[10.5px] font-semibold tracking-wider uppercase">
              {noun} so far
            </th>
            <th className="py-1.5 pr-3 text-right text-[10.5px] font-semibold tracking-wider uppercase">
              Matured
            </th>
            <th className="py-1.5 text-right text-[10.5px] font-semibold tracking-wider uppercase">
              On track for
            </th>
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => {
            const s = c.stages[stage];
            const settled = s.maturity >= 0.99;
            return (
              <tr key={c.month} className="border-t" style={{ borderColor: "var(--border)" }}>
                <td className="py-2 pr-3" style={{ color: "var(--text-primary)" }}>
                  {c.label}
                  {!c.complete && (
                    <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                      part month
                    </span>
                  )}
                </td>
                <td className="tnum py-2 pr-3 text-right" style={{ color: "var(--text-secondary)" }}>
                  {formatNumber(c.leads)}
                </td>
                {/* Counted. Always the primary figure, never displaced by the
                    projection two columns over. */}
                <td className="tnum py-2 pr-3 text-right" style={{ color: "var(--text-primary)" }}>
                  {formatNumber(s.observed)}
                </td>
                <td className="tnum py-2 pr-3 text-right" style={{ color: "var(--text-muted)" }}>
                  {settled ? "settled" : formatPercent(s.maturity, 0)}
                </td>
                <td className="tnum py-2 text-right">
                  {settled ? (
                    <span style={{ color: "var(--text-muted)" }}>{DASH}</span>
                  ) : s.projected === null ? (
                    /* 🔴 Refused, not blank-by-accident. Under a quarter
                       matured the arithmetic multiplies one appointment into
                       twenty, and the honest output is the words. */
                    <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      too early
                    </span>
                  ) : (
                    <span style={{ color: "var(--text-secondary)" }}>
                      ≈ {formatNumber(s.projected)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function MaturationPanel({ data }: { data: MaturationReport }) {
  const [stageId, setStageId] = useState<OutcomeStage>("closed_won");
  const curve = data.curves.find((c) => c.stage === stageId)!;
  const check = data.checks.find((c) => c.stage === stageId);

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Is this month actually worse, or just younger?
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
          How long a month&rsquo;s leads take to turn into {curve.noun}, measured
          from months that have finished
        </p>
      </div>
      <div
        className="flex flex-wrap gap-1 rounded-[9px] p-0.5"
        style={{ background: "var(--surface-2)" }}
        role="group"
        aria-label="Outcome"
      >
        {OUTCOME_STAGES.map((id) => {
          const c = data.curves.find((x) => x.stage === id)!;
          const active = id === stageId;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setStageId(id)}
              aria-pressed={active}
              className="rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{
                background: active ? "var(--surface-1)" : "transparent",
                color: active
                  ? "var(--text-primary)"
                  : c.measured
                    ? "var(--text-secondary)"
                    : "var(--text-muted)",
                boxShadow: active ? "var(--shadow-sm)" : undefined,
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (data.cohorts.length === 0) {
    return (
      <section className="card p-5">
        {header}
        <p className="mt-5 text-sm" style={{ color: "var(--text-secondary)" }}>
          No lead history yet. This fills in as months complete.
        </p>
      </section>
    );
  }

  return (
    <section className="card p-5">
      {header}

      {check && <div className="mt-4">{<EqualAge check={check} noun={curve.noun} />}</div>}

      {curve.measured ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-[auto_1fr] lg:items-center">
          <div>
            <CurveChart c={curve} />
            <div
              className="mt-1 flex justify-between text-[10.5px]"
              style={{ color: "var(--text-muted)", maxWidth: 320 }}
            >
              <span>lead arrives</span>
              <span>{HORIZON_DAYS} days</span>
            </div>
          </div>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            Half of this account&rsquo;s {curve.noun} land within{" "}
            <strong style={{ color: "var(--text-primary)" }}>{days(curve.halfDays)}</strong>{" "}
            of the lead arriving, and nine in ten within{" "}
            <strong style={{ color: "var(--text-primary)" }}>{days(curve.ninetyDays)}</strong>.
            <span style={{ color: "var(--text-muted)" }}>
              {" "}
              Measured across {curve.basis} finished month
              {curve.basis === 1 ? "" : "s"} — months still filling in are left out
              of the measurement, because including them would report the fill-in
              as faster than it is and cancel the correction.
            </span>
          </p>
        </div>
      ) : (
        <p className="mt-5 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {/*
           * A stated reason, not a shrug. The curve needs months that have
           * finished filling in AND enough conversions in each to have a shape
           * at all — an account four months old has neither, and saying so is
           * more useful than an empty chart.
           */}
          Not enough finished months to measure how {curve.noun} fill in yet.{" "}
          {curve.basis === 0
            ? `No month is both older than ${HORIZON_DAYS} days and has enough ${curve.noun} to have a shape.`
            : `Only ${curve.basis} qualifies so far.`}{" "}
          The like-for-like comparison above needs none of this — it counts both
          months at the same age.
        </p>
      )}

      <div className="mt-5">
        <CohortTable cohorts={data.cohorts} stage={stageId} noun={curve.noun} />
      </div>

      <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        &ldquo;On track for&rdquo; is inference, not a count: this month&rsquo;s
        leads behaving like previous months&rsquo;. It is withheld below a quarter
        matured, where dividing by the maturity would turn a single appointment
        into a headline. {HORIZON_DAYS} days is the horizon — anything landing
        later is not counted here at all.
      </p>
    </section>
  );
}
