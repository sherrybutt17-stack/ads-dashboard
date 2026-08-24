import {
  FEATURE_ACTION,
  MIN_LEADS_PER_LEVEL,
  describeSignal,
  type FeatureResult,
  type QualityReport,
} from "@/lib/metrics/quality";
import { OUTCOME_NOUN, OUTCOME_VERB } from "@/lib/metrics/speed-outcome";
import { formatNumber, formatPercent } from "@/lib/metrics/compute";

/**
 * What kinds of leads convert.
 *
 * ── 🔴 The sentence at the bottom is load-bearing ──────────────────────
 *
 * "These are findings about where leads come from, not a running order for the
 * phone." Without it this panel gets used as a triage list, the team stops
 * calling the segment it names as weak, that segment stops converting, and the
 * finding gets stronger every month while the pipeline gets worse. A lead score
 * changes the outcome it predicts, which is why there is no per-lead score
 * anywhere in this product and why the framing here has to push at the source —
 * the ad schedule, the form, the campaign mix.
 *
 * ── Why so much of this reads "not enough yet" ─────────────────────────
 *
 * Because it usually is. A segment needs volume on BOTH sides before it can be
 * compared, and at agency volumes most splits do not have it. The counts render
 * regardless — a reader can see 8 of 100 and draw their own provisional
 * conclusion — but the panel will not call it a difference, and it will not
 * rank two segments that are within noise of each other.
 */

function Row({
  label,
  leads,
  converted,
  rate,
  verdict,
}: {
  label: string;
  leads: number;
  converted: number;
  rate: number | null;
  verdict: FeatureResult["levels"][number]["verdict"];
}) {
  const tone =
    verdict === "better"
      ? "var(--status-good)"
      : verdict === "worse"
        ? "var(--status-critical)"
        : "var(--text-secondary)";
  return (
    <li className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-t pt-2" style={{ borderColor: "var(--border)" }}>
      <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
        {label}
        {verdict === "better" && (
          <span className="ml-2 text-[11.5px]" style={{ color: tone }}>
            converts better
          </span>
        )}
        {verdict === "worse" && (
          <span className="ml-2 text-[11.5px]" style={{ color: tone }}>
            converts worse
          </span>
        )}
        {verdict === "not_enough" && leads > 0 && (
          <span className="ml-2 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
            too few to compare
          </span>
        )}
      </span>
      <span className="tnum text-[12.5px]" style={{ color: "var(--text-secondary)" }}>
        {/*
         * 🔴 Counts always, percentage always — but the VERDICT only where the
         * volume earns it. Hiding the ratio would make the tool look like it
         * knows less than it does; colouring it would make noise look decided.
         */}
        {formatNumber(converted)} of {formatNumber(leads)}
        {rate !== null && (
          <span style={{ color: verdict === "same" ? "var(--text-secondary)" : tone }}>
            {" "}
            · {formatPercent(rate, 0)}
          </span>
        )}
      </span>
    </li>
  );
}

export function LeadQualityPanel({ report }: { report: QualityReport }) {
  const { stage, features, signals, judged, converted, baseRate, maturing } = report;
  const noun = OUTCOME_NOUN[stage];
  const verb = OUTCOME_VERB[stage];

  return (
    <section className="card p-5" aria-label="What kinds of leads convert">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            What kinds of leads convert
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            Every paid lead that arrived in this range, split by when it came in
            and where from, followed forward until it {verb} or ran out of road.
          </p>
        </div>
        {baseRate !== null && (
          <span className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
            {formatPercent(baseRate, 0)} overall
          </span>
        )}
      </div>

      {judged === 0 ? (
        <p
          className="mt-4 rounded-[10px] border px-3 py-2.5 text-[13px] leading-relaxed"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: "var(--text-secondary)",
          }}
        >
          {maturing > 0 ? (
            <>
              All {formatNumber(maturing)} leads in this range are still too
              recent to judge — a lead that has not {verb} yet has not
              necessarily failed to. They enter this once they are older than{" "}
              {report.maturationDays.toFixed(0)} days.
            </>
          ) : (
            <>No paid leads arrived in this range.</>
          )}
        </p>
      ) : (
        <>
          {/* ── The findings, largest gap first ──────────────────────── */}
          <div
            className="mt-4 rounded-[10px] border px-3 py-2.5 text-[13px] leading-relaxed"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface-1)",
              color: "var(--text-secondary)",
            }}
          >
            {signals.length === 0 ? (
              <>
                <strong style={{ color: "var(--text-primary)" }}>
                  No group of leads converts differently from the others.
                </strong>{" "}
                Across {formatNumber(judged)} leads and {formatNumber(converted)}{" "}
                {noun}, the splits below are within what this volume produces by
                chance. That is a real answer, not a missing one — where the lead
                came from is not what decides the outcome here.
              </>
            ) : (
              <ul className="grid gap-1.5">
                {signals.map((s) => (
                  <li key={`${s.feature}-${s.key}`}>
                    <span style={{ color: "var(--text-primary)" }}>
                      {describeSignal(s, stage)}
                    </span>{" "}
                    <span style={{ color: "var(--text-muted)" }}>
                      — {FEATURE_ACTION[s.feature]}.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── The working ──────────────────────────────────────────── */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {features.map((f) => (
              <div key={f.feature}>
                <p
                  className="text-[12.5px] font-medium"
                  style={{ color: "var(--text-primary)" }}
                >
                  {f.label}
                </p>
                <ul className="mt-1.5 grid gap-1.5">
                  {f.levels.slice(0, 6).map((l) => (
                    <Row
                      key={l.key}
                      label={l.label}
                      leads={l.leads}
                      converted={l.converted}
                      rate={l.rate}
                      verdict={l.verdict}
                    />
                  ))}
                </ul>
                {f.levels.length > 6 && (
                  <p className="mt-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {formatNumber(f.levels.length - 6)} smaller{" "}
                    {f.feature === "campaign" ? "campaigns" : "groups"} not shown.
                  </p>
                )}
              </div>
            ))}
          </div>

          {maturing > 0 && (
            <p className="mt-4 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
              {formatNumber(maturing)} more lead{maturing === 1 ? "" : "s"} arrived
              too recently to judge and {maturing === 1 ? "is" : "are"} not
              counted above — a lead younger than{" "}
              {report.maturationDays.toFixed(0)} days that has not {verb} yet has
              not necessarily failed to.{" "}
              {report.maturationMeasured
                ? "That window is measured from this client's own conversions."
                : "That window is a default, until enough conversions exist here to measure one."}
            </p>
          )}
        </>
      )}

      <p className="mt-4 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {/*
         * 🔴 The framing that keeps this from becoming a triage list. See the
         * header of `quality.ts` for why no per-lead score exists anywhere in
         * this product.
         */}
        <strong style={{ color: "var(--text-secondary)" }}>
          These are findings about where leads come from, not a running order for
          the phone.
        </strong>{" "}
        Calling a group less because it scores worse is what makes it score worse
        — so there is deliberately no per-lead score here, and these splits are
        meant for the ad schedule, the form and the budget rather than for the
        queue. A group needs {MIN_LEADS_PER_LEVEL} leads on each side of a split
        before it is called a difference; below that the counts still show and
        the verdict does not.
      </p>
    </section>
  );
}
