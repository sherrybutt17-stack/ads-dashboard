import {
  VERDICT_LABEL,
  type Assessment,
  type KeepKillReport,
  type Verdict,
} from "@/lib/metrics/keepkill";
import { formatCurrency, DASH } from "@/lib/metrics/compute";
import { Icon } from "@/components/Icon";

/**
 * Keep / kill — what the engine concluded, and why.
 *
 * **Recommend only.** There is no button here that pauses anything. That is a
 * product decision, not an unfinished feature: a wrong automatic pause costs a
 * client a working campaign and costs the agency the relationship, and the
 * asymmetry is bad enough that a human should always be the one to click.
 *
 * Every row shows its confidence as a number. A verdict without one invites the
 * reader to treat "consider stopping" and "keep" as equally certain, when the
 * whole point of the engine is that they usually are not.
 */

const STYLE: Record<Verdict, { color: string; icon: "alert" | "check" | "help" | "x" }> = {
  kill: { color: "var(--status-critical)", icon: "x" },
  scale: { color: "var(--status-good)", icon: "check" },
  watch: { color: "var(--status-warning)", icon: "alert" },
  keep: { color: "var(--text-muted)", icon: "check" },
  too_early: { color: "var(--text-muted)", icon: "help" },
  no_benchmark: { color: "var(--text-muted)", icon: "help" },
};

/** Verdicts worth a row of their own; the rest collapse into a count. */
const NOTABLE: Verdict[] = ["kill", "scale", "watch", "too_early"];

function Row({ a, currency }: { a: Assessment; currency: string }) {
  const s = STYLE[a.verdict];
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="mt-0.5 shrink-0" style={{ color: s.color }} aria-hidden>
        <Icon name={s.icon} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span
            className="text-[13px] font-medium"
            style={{ color: "var(--text-primary)" }}
          >
            {a.name}
          </span>
          {/* Never colour alone: the verdict is spelled out next to its icon. */}
          <span className="text-[11px] font-semibold" style={{ color: s.color }}>
            {VERDICT_LABEL[a.verdict]}
          </span>
          <span className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
            {formatCurrency(a.spend, currency)} ·{" "}
            {a.costPer == null ? DASH : formatCurrency(a.costPer, currency)} each
          </span>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {a.reason}
        </p>
      </div>
    </li>
  );
}

export function KeepKill({
  report,
  currency,
}: {
  report: KeepKillReport;
  currency: string;
}) {
  const { stage, stageReason, assessments, judged } = report;
  const notable = assessments.filter((a) => NOTABLE.includes(a.verdict));
  const quiet = assessments.length - notable.length;

  return (
    <section className="card p-5" aria-label="Keep or stop">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Keep or stop
        </h2>
        <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
          {judged === 0
            ? "nothing to judge"
            : `${judged} campaign${judged === 1 ? "" : "s"} judged`}
        </span>
      </div>

      {/*
       * 🔴 The stage is stated before any verdict is read. "Worse" measured on
       * closed deals and "worse" measured on raw leads are different claims,
       * and a reader who assumes the first when we computed the second has been
       * misled by omission rather than by a wrong number.
       */}
      <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {stageReason}
      </p>

      {stage === null ? null : notable.length > 0 ? (
        <>
          <ul className="mt-2 divide-y" style={{ borderColor: "var(--border)" }}>
            {notable.map((a) => (
              <Row key={a.id} a={a} currency={currency} />
            ))}
          </ul>
          {quiet > 0 && (
            <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
              {quiet} other campaign{quiet === 1 ? " is" : "s are"} performing
              indistinguishably from the rest of the account — nothing to act on.
            </p>
          )}
        </>
      ) : (
        <div className="mt-4 flex items-start gap-2.5">
          <span style={{ color: "var(--status-good)" }} className="mt-0.5">
            <Icon name="check" size={14} />
          </span>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            No campaign is far enough from the others to call. That is a result,
            not an absence of one — at these volumes most differences between
            campaigns are the sample rather than the advertising.
          </p>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Recommendations only — nothing here changes a budget or pauses anything.
        Confidence is the probability a campaign is genuinely worse than the rest
        of this account, not a p-value, and it is computed against the account
        itself rather than an industry benchmark.
      </p>
    </section>
  );
}
