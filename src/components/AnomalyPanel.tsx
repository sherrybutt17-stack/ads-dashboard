import type { Anomaly, AnomalyReport } from "@/lib/metrics/anomaly";
import { BASELINE_DAYS } from "@/lib/metrics/anomaly";
import { dayLabel } from "@/lib/dates";
import { Icon } from "@/components/Icon";

/**
 * Unusual days — the question neither the deltas nor the health checklist asks.
 *
 * The KPI row compares two whole periods, so a month that is flat on both ends
 * hides the Tuesday spend tripled on. The health checklist asks whether the pipe
 * is working, which by design says nothing about whether the numbers coming
 * through it look right. This is the third question: *what happened on the
 * 14th?* — asked of the client's own history rather than a benchmark, because
 * "unusual" only means anything relative to what that account normally does.
 *
 * ---
 *
 * THE EMPTY STATES ARE THE DESIGN.
 *
 * Most days this panel has nothing to report, and that is the intended
 * behaviour, not a failure — an alert layer that always has something to say is
 * one people stop reading. But an empty list has three different causes, and
 * collapsing them into one sentence is how a dashboard misleads quietly:
 *
 *   · nothing was unusual                 → genuine reassurance
 *   · not enough history to judge yet     → no basis for reassurance at all
 *   · the range holds no finished days    → nothing has happened yet to judge
 *
 * Telling a two-week-old client "nothing unusual" is the same class of quiet,
 * confident emptiness as a spreadsheet reporting SHOWN = 0 for a year.
 */

const TONE: Record<Anomaly["tone"], { color: string; mark: string }> = {
  good: { color: "var(--delta-good)", mark: "▲" },
  bad: { color: "var(--delta-bad)", mark: "▼" },
  neutral: { color: "var(--text-muted)", mark: "•" },
};

function Row({ a }: { a: Anomaly }) {
  const tone = TONE[a.tone];
  const when =
    a.startKey === a.endKey
      ? dayLabel(a.startKey)
      : `${dayLabel(a.startKey)}–${dayLabel(a.endKey)}`;

  return (
    <li className="flex items-start gap-3 py-2.5">
      {/*
       * Never colour alone. The mark carries the direction for anyone who
       * cannot separate the two greens, and it is the same vocabulary the
       * insight strip uses so the page reads as one voice.
       */}
      <span
        aria-hidden
        className="mt-px w-3 shrink-0 text-center text-[11px] leading-5"
        style={{ color: tone.color }}
      >
        {a.kind === "gap" ? "!" : tone.mark}
      </span>

      <span
        className="w-[86px] shrink-0 text-xs leading-5 tabular-nums"
        style={{ color: "var(--text-muted)" }}
      >
        {when}
      </span>

      <span className="text-sm leading-5" style={{ color: "var(--text-secondary)" }}>
        {a.text}
      </span>
    </li>
  );
}

export function AnomalyPanel({
  report,
  rangeLabel,
}: {
  report: AnomalyReport;
  rangeLabel: string;
}) {
  const { findings, judgedDays, testedDays } = report;

  return (
    <section className="card p-5" aria-label="Unusual days">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Unusual days
        </h2>
        <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
          {findings.length > 0
            ? `${findings.length} found`
            : `${judgedDays} day${judgedDays === 1 ? "" : "s"} checked`}
        </span>
      </div>

      {findings.length > 0 ? (
        <>
          <ul className="mt-1 divide-y" style={{ borderColor: "var(--border)" }}>
            {findings.map((a) => (
              <Row key={`${a.metric}-${a.startKey}-${a.direction}`} a={a} />
            ))}
          </ul>
          <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
            Compared against this account&rsquo;s own trailing {BASELINE_DAYS} days,
            not an industry benchmark. Today is never included — a day is judged
            once it has finished.
          </p>
        </>
      ) : testedDays === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          No finished days in this range yet. Today is deliberately not judged: its
          figures only cover the hours so far, so every morning would look like a
          collapse.
        </p>
      ) : judgedDays === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          Not enough history yet to tell an unusual day from an ordinary one. This
          needs about {BASELINE_DAYS} days of an account&rsquo;s own record before it
          can say anything — until then, silence here means{" "}
          <em>we cannot tell</em>, not <em>all clear</em>.
        </p>
      ) : (
        <div className="mt-4 flex items-start gap-2.5">
          <span style={{ color: "var(--status-good)" }} className="mt-0.5">
            <Icon name="check" size={14} />
          </span>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Nothing unusual in {rangeLabel}. Every day sat inside this
            account&rsquo;s normal range for spend, leads, appointments and cost per
            lead.
          </p>
        </div>
      )}
    </section>
  );
}
