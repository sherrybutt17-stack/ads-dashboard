import {
  DAYTIME_END,
  DAYTIME_START,
  MIN_ATTEMPTS_TO_COMPARE,
  hourLabel,
  hourRangeLabel,
  type CallTimingReport,
} from "@/lib/metrics/calltime";
import { formatNumber, formatPercent } from "@/lib/metrics/compute";

/**
 * When calls actually reach someone.
 *
 * ── The headline is about evidence, not about an hour ──────────────────
 *
 * The question asked was "what hour should we call?", and for most accounts the
 * true answer is "you cannot know yet, because you only ever call in two of
 * them". That sentence is the panel's main claim; the hourly bars are the
 * working underneath it.
 *
 * A bar chart with a tall bar at 6am on five attempts would be read as advice,
 * acted on, and would be noise. So a percentage appears only where enough
 * attempts back it, the counts show either way, and no hour is named as best
 * unless it beats the rest of the day on a real posterior.
 *
 * ── Why there is no close-rate-by-hour chart, said out loud ────────────
 *
 * Because it would be a re-plot of speed-to-lead. The note at the bottom says
 * so: a chart that is missing without explanation is indistinguishable from one
 * nobody got round to building.
 */

function Bar({
  attempts,
  connected,
  max,
}: {
  attempts: number;
  connected: number;
  max: number;
}) {
  const w = max > 0 ? (attempts / max) * 100 : 0;
  const inner = attempts > 0 ? (connected / attempts) * 100 : 0;
  return (
    <div
      className="h-2.5 w-full overflow-hidden rounded-full"
      style={{ background: "var(--surface-2)" }}
    >
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: "var(--seq-250)" }}>
        {/* The filled portion is the connected share — one bar carries both
            "how much we called" and "how often it worked". */}
        <div
          className="h-full rounded-full"
          style={{ width: `${inner}%`, background: "var(--seq-450)" }}
        />
      </div>
    </div>
  );
}

export function CallTimingPanel({ report }: { report: CallTimingReport }) {
  const { hours, totals, verdict, best, concentration, untried } = report;
  const max = Math.max(...hours.map((h) => h.attempts), 1);
  // Only the part of the day worth showing. A row of 24 empty bars, most of
  // them for hours nobody would ever dial, buries the ones that matter.
  const shown = hours.filter(
    (h) => h.attempts > 0 || (h.hour >= DAYTIME_START && h.hour < DAYTIME_END),
  );

  return (
    <section className="card p-5" aria-label="When calls connect">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            When calls connect
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            Every outbound call attempt, by the hour it was placed —{" "}
            {formatNumber(totals.attempts)} attempt
            {totals.attempts === 1 ? "" : "s"} in this range.
          </p>
        </div>
        {totals.rate !== null && (
          <span className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
            {formatPercent(totals.rate, 0)} reach someone
          </span>
        )}
      </div>

      {/* ── The claim ─────────────────────────────────────────────────── */}
      <div
        className="mt-4 rounded-[10px] border px-3 py-2.5 text-[13px] leading-relaxed"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface-1)",
          color: "var(--text-secondary)",
        }}
      >
        {verdict === "no_calls" && (
          <>
            No calls have been recorded yet. This builds from the call log
            forward — it cannot be filled in for the past.
          </>
        )}

        {verdict === "too_concentrated" && (
          <>
            <strong style={{ color: "var(--text-primary)" }}>
              There is not enough spread to say when is best.
            </strong>{" "}
            {concentration && (
              <>
                {formatPercent(concentration.share, 0)} of calls go out in{" "}
                {concentration.hours === 1
                  ? "a single hour"
                  : `${formatNumber(concentration.hours)} hours`}{" "}
                of the day.{" "}
              </>
            )}
            An hour cannot be compared with hours nobody has called in — at least
            two need {MIN_ATTEMPTS_TO_COMPARE} attempts before this can answer
            anything.
          </>
        )}

        {verdict === "no_hour_stands_out" && (
          <>
            <strong style={{ color: "var(--text-primary)" }}>
              No hour reaches people more often than the rest.
            </strong>{" "}
            Across the hours with enough attempts to compare, the differences are
            within what this volume would produce by chance. That is a real
            answer: the hour is not the lever.
          </>
        )}

        {verdict === "hour_stands_out" && best && (
          <>
            <strong style={{ color: "var(--text-primary)" }}>
              Calls placed {hourRangeLabel(best.hour)} reach someone{" "}
              {formatPercent(best.rate, 0)} of the time
            </strong>
            , against {formatPercent(best.restRate, 0)} across the rest of the
            day. That gap holds up at this volume — it is not a coincidence of
            small numbers.
          </>
        )}
      </div>

      {/* ── The hours ─────────────────────────────────────────────────── */}
      <ul className="mt-4 grid gap-1.5">
        {shown.map((h) => (
          <li key={h.hour} className="grid grid-cols-[52px_1fr_auto] items-center gap-3">
            <span
              className="tnum text-right text-[12px]"
              style={{ color: "var(--text-muted)" }}
            >
              {hourLabel(h.hour)}
            </span>
            <Bar attempts={h.attempts} connected={h.connected} max={max} />
            <span
              className="tnum w-[120px] text-right text-[12px]"
              style={{ color: "var(--text-secondary)" }}
            >
              {h.attempts === 0 ? (
                <span style={{ color: "var(--text-muted)" }}>never called</span>
              ) : (
                <>
                  {/*
                   * 🔴 Counts always; the percentage only where it means
                   * something. "3 of 5" is honest and useful — hiding it makes
                   * the tool look like it knows less than it does — but "60%"
                   * off five attempts reads as a finding and is a coin flip.
                   */}
                  {formatNumber(h.connected)} of {formatNumber(h.attempts)}
                  {h.rate !== null && (
                    <span style={{ color: "var(--text-primary)" }}>
                      {" "}
                      · {formatPercent(h.rate, 0)}
                    </span>
                  )}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>

      {/* ── Where the evidence is missing ─────────────────────────────── */}
      {untried.length > 0 && (
        <div className="mt-4">
          <p className="text-[12.5px] font-medium" style={{ color: "var(--text-primary)" }}>
            Hours worth trying
          </p>
          <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {/*
             * Framed as where evidence is missing, not as a failure to cover.
             * A lead arriving at 10pm should be called the next morning — this
             * only names DAYTIME hours with real arrivals and almost no
             * attempts, which is why the question above cannot be answered yet.
             */}
            Leads arrive in these hours and almost no calls go out in them, so
            there is nothing to compare against.{" "}
            {untried
              .map(
                (u) =>
                  `${hourRangeLabel(u.hour)} (${formatNumber(u.arrivals)} leads, ${formatNumber(u.attempts)} call${u.attempts === 1 ? "" : "s"})`,
              )
              .join(" · ")}
          </p>
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        &ldquo;Reached someone&rdquo; means a call lasting at least{" "}
        {report.connectedSeconds} seconds. The phone system reports every attempt
        as completed whether or not anyone picked up, so the length is the only
        signal there is — long enough to be past a voicemail greeting, and it is
        our judgement rather than something the system told us.
        {/*
         * 🔴 The absent chart, explained. A missing view with no reason given is
         * indistinguishable from one nobody built.
         */}{" "}
        There is deliberately no close-rate-by-hour view: the hour a lead is
        first called is mostly decided by the hour it arrived, so that chart
        would restate response time with the axis relabelled — see speed to lead
        above for the question it would actually be answering.
      </p>
    </section>
  );
}
