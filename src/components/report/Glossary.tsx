import {
  METRIC_DEFINITIONS,
  REPORT_GLOSSARY,
  REPORT_GLOSSARY_LABEL,
  type MetricDefinition,
} from "@/lib/metrics/definitions";

/**
 * What every number on this report means, in words.
 *
 * ── Why the report needs this and the dashboard does not ──────────────
 *
 * In the app a definition is one tap on an ⓘ, rendered by `MetricInfo`. A
 * report is read on paper, in a PDF, or in a mail client — none of which can
 * open a popover. The definitions were therefore reachable only by the audience
 * that needed them least: the agency staff who already know what a show rate
 * is. The client, for whom this document is the entire product, got an icon
 * that does nothing.
 *
 * ── The specific misreading this defuses ──────────────────────────────
 *
 * The funnel's stacked percentages each divide by the row above them, not by
 * leads. Nothing on the chart says so, and the natural reading — "62% of my
 * leads showed up" — is both wrong and much more flattering than the truth. The
 * correction currently arrives in a meeting rather than on the page.
 *
 * ── Presentation ──────────────────────────────────────────────────────
 *
 * Last, deliberately: it is reference material, consulted when a figure
 * surprises someone, not an introduction to be read first. Definitions with a
 * caveat are visually distinguished, because the caveat is the part that is
 * worth the page — where a metric has no trap it has no caveat, and padding
 * them would train people to skip the ones that matter.
 */
export function Glossary() {
  const entries = REPORT_GLOSSARY.map((key) => ({
    key,
    name: REPORT_GLOSSARY_LABEL[key] ?? key,
    def: METRIC_DEFINITIONS[key] as MetricDefinition | undefined,
  })).filter((e): e is { key: string; name: string; def: MetricDefinition } =>
    Boolean(e.def),
  );

  if (entries.length === 0) return null;

  return (
    <section
      className="avoid-break border-t pt-5"
      style={{ borderColor: "var(--border)" }}
      aria-labelledby="glossary-heading"
    >
      <h2
        id="glossary-heading"
        className="text-[13px] font-semibold"
        style={{ color: "var(--text-primary)" }}
      >
        How to read these numbers
      </h2>
      <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Every figure above, and what it is counting.
      </p>

      <dl className="mt-3 flex flex-col gap-3">
        {entries.map((e) => (
          <div key={e.key} className="avoid-break">
            <dt
              className="text-[12px] font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              {e.name}
            </dt>
            <dd className="mt-0.5 text-[11.5px] leading-relaxed">
              <span style={{ color: "var(--text-secondary)" }}>{e.def.what}</span>{" "}
              <span style={{ color: "var(--text-muted)" }}>{e.def.formula}</span>
              {e.def.caveat && (
                /*
                 * Set apart rather than run on. The caveat is the sentence that
                 * changes a reader's conclusion — a denominator that is not
                 * what they assumed, a quantity that cannot be summed — and
                 * losing it in a paragraph would defeat the point of printing
                 * any of this.
                 */
                <span
                  className="mt-1 block border-l-2 pl-2"
                  style={{
                    borderColor: "var(--border-strong)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {e.def.caveat}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
