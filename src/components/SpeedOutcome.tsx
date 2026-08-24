"use client";

import { useState } from "react";
import {
  FAST_THRESHOLD_SECONDS,
  OUTCOME_QUESTION,
  OUTCOME_STAGES,
  type BucketOutcome,
  type CallingWindow,
  type OutcomeStage,
  type SpeedOutcome,
  type StageOutcome,
  type Verdict,
} from "@/lib/metrics/speed-outcome";
import { formatNumber, formatPercent, DASH } from "@/lib/metrics/compute";
import { Icon } from "@/components/Icon";

/**
 * Does answering faster actually book more — for this client, from their data.
 *
 * The panel refuses three things that every version of this chart elsewhere
 * does:
 *
 * · **It does not quote the industry's 21× statistic.** That number is from a
 *   2007 study of a different industry at a different scale, and a client whose
 *   own data says otherwise is entitled to their own data.
 * · **It does not print a bare rate.** Every rate carries the interval it could
 *   plausibly be, because at these volumes "100% of leads called within five
 *   minutes booked" is routinely one lead.
 * · **It does not say "call faster" when the evidence is a coin flip.** The
 *   inconclusive state is written out in full, with what is missing, because a
 *   confident recommendation from twelve leads is how a client is talked into
 *   restructuring their sales process on noise.
 */

const HOURS = [
  "12am", "1am", "2am", "3am", "4am", "5am", "6am", "7am", "8am", "9am", "10am", "11am",
  "12pm", "1pm", "2pm", "3pm", "4pm", "5pm", "6pm", "7pm", "8pm", "9pm", "10pm", "11pm",
];
const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function hourLabel(h: number): string {
  return HOURS[Math.max(0, Math.min(23, h))];
}

/** "Mon–Fri", or "Mon, Wed, Fri" when the working days are not contiguous. */
function daysLabel(days: readonly number[]): string {
  if (days.length === 0) return "no days";
  if (days.length === 7) return "every day";
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  return contiguous && days.length > 2
    ? `${DAY_SHORT[days[0]]}–${DAY_SHORT[days[days.length - 1]]}`
    : days.map((d) => DAY_SHORT[d]).join(", ");
}

const STRENGTH: Record<
  Verdict["strength"],
  { tone: string; icon: "check" | "alert" | "help" }
> = {
  fast_clear: { tone: "var(--status-good)", icon: "check" },
  fast_leaning: { tone: "var(--seq-450)", icon: "help" },
  inconclusive: { tone: "var(--text-muted)", icon: "help" },
  slow_leaning: { tone: "var(--seq-450)", icon: "help" },
  slow_clear: { tone: "var(--status-warning)", icon: "alert" },
};

/**
 * The verdict as a sentence, never as a score.
 *
 * 🔴 The reversed cases are spelled out rather than folded into "inconclusive".
 * A panel built to recommend calling faster that can only ever report "yes" or
 * "not sure" is not measuring anything — it is confirming its own premise, which
 * is the failure mode of every dashboard that ships a thesis.
 */
function verdictSentence(v: Verdict, s: StageOutcome): string {
  const fast = formatPercent(v.fast.rate, 0);
  const slow = formatPercent(v.slow.rate, 0);
  const gap = Math.abs(Math.round(v.gapPoints ?? 0));
  const conf = Math.round(v.probFastBetter * 100);

  switch (v.strength) {
    case "fast_clear":
      return `Leads called within an hour ${s.verb} at ${fast}, against ${slow} for the ones called later — ${gap} points better, and unlikely to be luck (${conf}% confident).`;
    case "fast_leaning":
      return `Leads called within an hour ${s.verb} at ${fast} against ${slow} later. The gap points the expected way but is not yet firm (${conf}% confident) — it would still turn over.`;
    case "slow_leaning":
      return `Leads called later ${s.verb} slightly more often (${slow} against ${fast}). Probably noise at this sample size, but it is not evidence for calling faster.`;
    case "slow_clear":
      return `Leads called later ${s.verb} at ${slow}, ahead of ${fast} for those called within the hour. That is the opposite of the expected result and worth understanding before acting on response times.`;
    case "inconclusive":
      return `Leads called within an hour ${s.verb} at ${fast}; those called later, ${slow}. The difference is inside what this many leads can distinguish, so it is not yet evidence either way.`;
  }
}

/**
 * A rate, its interval, and the count it came from.
 *
 * The bar is the credible interval and the dot is the observed rate — not a bar
 * from zero, which draws a one-lead 100% at full width and a forty-lead 30% at
 * a third of it, exactly inverting how much each deserves to be believed.
 */
function RateBar({
  row,
  domain,
  accent,
}: {
  row: BucketOutcome;
  domain: number;
  accent: string;
}) {
  if (row.rate === null || row.lo === null || row.hi === null) {
    return <span style={{ color: "var(--text-muted)" }}>{DASH}</span>;
  }
  const pos = (v: number) => `${Math.min(100, (v / domain) * 100)}%`;
  return (
    <span className="relative block h-3 w-full">
      <span
        className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
        style={{
          left: pos(row.lo),
          width: `calc(${pos(row.hi)} - ${pos(row.lo)})`,
          background: `color-mix(in srgb, ${accent} 34%, transparent)`,
        }}
      />
      <span
        className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ left: pos(row.rate), background: accent }}
      />
    </span>
  );
}

function BucketTable({ stage }: { stage: StageOutcome }) {
  const domain = Math.max(
    0.1,
    ...stage.buckets.map((b) => b.hi ?? 0),
  );
  return (
    <div className="table-scroll">
      <table className="w-full text-[13px]">
        <thead>
          <tr style={{ color: "var(--text-muted)" }}>
            <th className="py-1.5 pr-3 text-left text-[10.5px] font-semibold tracking-wider uppercase">
              Answered
            </th>
            <th className="py-1.5 pr-3 text-right text-[10.5px] font-semibold tracking-wider uppercase">
              Leads
            </th>
            <th className="py-1.5 pr-3 text-right text-[10.5px] font-semibold tracking-wider uppercase">
              {stage.label}
            </th>
            <th className="py-1.5 pr-3 text-right text-[10.5px] font-semibold tracking-wider uppercase">
              Rate
            </th>
            <th className="w-[38%] py-1.5 text-left text-[10.5px] font-semibold tracking-wider uppercase">
              <span className="flex justify-between">
                <span>0%</span>
                <span>{formatPercent(domain, 0)}</span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {stage.buckets.map((b) => (
            <tr
              key={b.id}
              className="border-t"
              style={{ borderColor: "var(--border)" }}
            >
              <td
                className="py-2 pr-3 whitespace-nowrap"
                style={{
                  color: b.inComparison
                    ? "var(--text-primary)"
                    : "var(--text-muted)",
                }}
              >
                {b.label}
                {/*
                 * 🔴 Never-called leads are on the table but out of the test,
                 * and the marker is the only place a reader learns that. A team
                 * that skips the obvious junk makes this row convert at zero
                 * because of that judgement — folding it into "slow" would
                 * manufacture a speed effect out of triage.
                 */}
                {!b.inComparison && (
                  <span
                    className="ml-1.5 text-[10px] tracking-wide uppercase"
                    style={{ color: "var(--text-muted)" }}
                    title="Excluded from the comparison — leads nobody called may have been skipped deliberately, which measures triage rather than speed."
                  >
                    not compared
                  </span>
                )}
              </td>
              <td className="tnum py-2 pr-3 text-right" style={{ color: "var(--text-secondary)" }}>
                {formatNumber(b.leads)}
              </td>
              <td className="tnum py-2 pr-3 text-right" style={{ color: "var(--text-secondary)" }}>
                {b.leads > 0 ? formatNumber(b.converted) : DASH}
              </td>
              <td className="tnum py-2 pr-3 text-right" style={{ color: "var(--text-primary)" }}>
                {formatPercent(b.rate, 0)}
              </td>
              <td className="py-2">
                <RateBar
                  row={b}
                  domain={domain}
                  accent={
                    b.inComparison ? "var(--series-1)" : "var(--text-muted)"
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The confound, controlled or named — never quietly left out.
 *
 * A lead arriving at 2am gets a slow response through nobody's failure, and if
 * night leads are simply worse leads then the real finding is about arrival
 * time and the advice "call faster" is wrong. Re-running the same contrast over
 * leads that arrived inside the hours this client actually places calls is what
 * separates those. When the window cannot be measured, that is said plainly
 * rather than dressed as a pass.
 */
function ControlNote({
  stage,
  window,
}: {
  stage: StageOutcome;
  window: CallingWindow | null;
}) {
  if (!window) {
    return (
      <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Not enough recorded calls yet to work out when you are on the phone, so
        this cannot yet separate &ldquo;we answered slowly&rdquo; from
        &ldquo;the lead arrived at 2am&rdquo;. Both would look the same here.
      </p>
    );
  }

  const hours = `${daysLabel(window.days)} ${hourLabel(window.startHour)}–${hourLabel(window.endHour)}`;

  if (!stage.control) {
    return (
      <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        You place calls {hours} (measured from {formatNumber(window.calls)} of
        them). Too few leads arrived inside those hours to re-run the comparison
        there, so out-of-hours arrivals cannot be ruled out as the real cause.
      </p>
    );
  }

  const c = stage.control;
  const survives = c.probFastBetter >= 0.8;
  return (
    <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
      Among only the {formatNumber(c.fast.leads + c.slow.leads)} leads that
      arrived while you are on the phone ({hours}), {formatPercent(c.fast.rate, 0)}{" "}
      against {formatPercent(c.slow.rate, 0)}
      {survives
        ? ` — the gap holds once out-of-hours arrivals are taken out, so it is not simply that night leads are worse.`
        : ` — the gap does not clearly hold there, so some of it may be about when leads arrive rather than how fast you answer.`}
    </p>
  );
}

export function SpeedOutcomePanel({ data }: { data: SpeedOutcome }) {
  const [stageId, setStageId] = useState<OutcomeStage>(data.defaultStage);
  const stage = data.stages.find((s) => s.stage === stageId)!;

  const selector = (
    <div
      className="flex flex-wrap gap-1 rounded-[9px] p-0.5"
      style={{ background: "var(--surface-2)" }}
      role="group"
      aria-label="Outcome"
    >
      {OUTCOME_STAGES.map((id) => {
        const s = data.stages.find((x) => x.stage === id)!;
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
                : s.converted === 0
                  ? "var(--text-muted)"
                  : "var(--text-secondary)",
              boxShadow: active ? "var(--shadow-sm)" : undefined,
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Does answering faster {OUTCOME_QUESTION[stageId]}?
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
          Your own leads, split by how long they waited for the first call
        </p>
      </div>
      {selector}
    </div>
  );

  /* --- The four honest empty states ------------------------------------ */

  const empty = (title: string, detail: string) => (
    <section className="card p-5">
      {header}
      <div className="mt-5 flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0" style={{ color: "var(--text-muted)" }}>
          <Icon name="help" size={14} />
        </span>
        <div>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {title}
          </p>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {detail}
          </p>
        </div>
      </div>
    </section>
  );

  if (data.trackingStartedAt === null) {
    return empty(
      "No outbound-call events have arrived from GoHighLevel yet.",
      "This compares what happened to leads you answered quickly against the ones you did not — which needs call times. It starts measuring from the first call recorded and fills in going forward; nothing before that is recoverable.",
    );
  }

  if (data.cohort === 0) {
    return empty(
      "No leads in this range arrived after call tracking went live.",
      data.preTracking > 0
        ? `${formatNumber(data.preTracking)} lead${data.preTracking === 1 ? "" : "s"} in this range predate call tracking. Their response times are unknown — not slow, unknown — so they are left out rather than counted as never called.`
        : "Widen the date range, or wait for new leads to arrive.",
    );
  }

  if (!stage.mapped) {
    return empty(
      `No GHL stage is mapped to “${stage.label.toLowerCase()}”.`,
      `Nothing can be counted as ${stage.noun} whatever actually happened, so this comparison would read 0% for every response time — a broken setup wearing the clothes of a business result. Map the stage in Setup, or judge on a different outcome.`,
    );
  }

  if (stage.matured === 0) {
    return empty(
      `None of these leads is old enough to judge on ${stage.noun} yet.`,
      `${formatNumber(stage.maturing)} lead${stage.maturing === 1 ? " is" : "s are"} still inside the ${Math.round(stage.maturationDays)}-day window in which ${stage.noun} normally happen here. Counting them now would score every recent lead as a failure — and recent leads are the fast-answered ones, so the comparison would come out backwards.`,
    );
  }

  const v = stage.verdict;
  const tone = v ? STRENGTH[v.strength] : STRENGTH.inconclusive;

  return (
    <section className="card p-5">
      {header}

      {/* --- The verdict, as a sentence ---------------------------------- */}
      <div
        className="mt-4 flex items-start gap-2.5 rounded-[10px] p-3.5"
        style={{ background: "var(--surface-2)" }}
      >
        <span className="mt-0.5 shrink-0" style={{ color: tone.tone }}>
          <Icon name={tone.icon} size={14} />
        </span>
        <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-primary)" }}>
          {v ? (
            verdictSentence(v, stage)
          ) : (
            <>
              Every lead old enough to judge landed on the same side of the
              one-hour line, so there is nothing to compare it against. The rates
              below are still real; the comparison is not available.
            </>
          )}
        </p>
      </div>

      <div className="mt-4">
        <BucketTable stage={stage} />
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        <ControlNote stage={stage} window={data.callingWindow} />

        {/*
         * 🔴 The leads that are not here, and why.
         *
         * On a client onboarded mid-life this is most of them — GG ads reads 4
         * judged against 33 in the KPI tile. Without the line the reader finds
         * the gap themselves and concludes the panel is broken; with it, the
         * gap is the point: their response times before call tracking went live
         * are not slow, they are unknown, and no amount of querying recovers
         * them.
         */}
        {data.preTracking > 0 && (
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {formatNumber(data.preTracking)} other lead
            {data.preTracking === 1 ? "" : "s"} in this range arrived before call
            tracking went live, so how quickly they were answered is unknown —
            not slow, unknown. They are left out rather than counted as never
            called.
          </p>
        )}

        {/*
         * 🔴 The maturation rule, stated wherever its effect is visible. Leads
         * withheld here are not missing data — they are leads whose silence
         * does not mean anything yet, and saying so is what stops the reader
         * reconciling this denominator against the KPI tile and finding a gap.
         */}
        {stage.maturing > 0 && (
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {formatNumber(stage.maturing)} more recent lead
            {stage.maturing === 1 ? " is" : "s are"} left out — under{" "}
            {Math.round(stage.maturationDays)} days old, and{" "}
            {stage.maturationMeasured
              ? `9 in 10 of your ${stage.noun} happen within that`
              : `${stage.noun} typically take about that long`}
            . Counting them as failures now would penalise the leads you answered
            fastest, because those are the most recent ones.
          </p>
        )}

        <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {/*
           * The caveat is specific rather than a blanket "correlation is not
           * causation", and it names the one mechanism this measurement is
           * immune to — which is the part that makes the rest credible.
           */}
          This is a correlation over {formatNumber(stage.matured)} lead
          {stage.matured === 1 ? "" : "s"}, not a controlled test. It is measured
          from the first outbound <em>attempt</em>, so it cannot be explained by
          keener leads picking up the phone faster — the clock starts when you
          dial. Fast is under{" "}
          {FAST_THRESHOLD_SECONDS === 3600
            ? "an hour"
            : `${FAST_THRESHOLD_SECONDS}s`}
          , fixed for every client so no threshold is ever chosen to flatter the
          result.
        </p>
      </div>
    </section>
  );
}
