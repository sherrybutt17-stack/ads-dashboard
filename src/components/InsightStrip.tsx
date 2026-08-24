import type { Insight } from "@/lib/metrics/insights";

/**
 * "What changed" — the one-line story above the KPIs.
 *
 * Turns six tiles the viewer would otherwise have to scan and interpret into a
 * named narrative. Tone is polarity-aware and never colour-alone: each insight
 * carries a small directional caret plus its text.
 */

const TONE: Record<Insight["tone"], { color: string; caret: string }> = {
  good: { color: "var(--delta-good)", caret: "▲" },
  bad: { color: "var(--delta-bad)", caret: "▼" },
  neutral: { color: "var(--text-muted)", caret: "•" },
};

export function InsightStrip({ insights }: { insights: Insight[] }) {
  /*
   * 🔴 An empty strip renders a REASON, not nothing.
   *
   * Two failures collapse into `return null`. First: with the section list now
   * configurable, a reader who switches "What changed" on and sees no change at
   * all files a bug — and the honest answer, that there was not enough volume to
   * say anything, is genuinely useful.
   *
   * Second, and worse: `buildInsights` is gated on absolute counts (≥5 leads in
   * both periods, ≥$250 spend for cost metrics) precisely because at low volume
   * 3 leads → 5 leads is "+67%" and announcing that would be noise dressed as a
   * headline. Vanishing silently makes "we are below the threshold where a
   * comparison means anything" indistinguishable from "nothing changed" — which
   * is exactly the kind of quiet, confident emptiness this product exists to
   * replace.
   */
  if (insights.length === 0) {
    return (
      <section
        className="rounded-[12px] border px-4 py-3 text-xs"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface-1)",
          color: "var(--text-muted)",
        }}
        aria-label="What changed this period"
      >
        <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>
          Not enough activity to compare periods.
        </span>{" "}
        Headlines appear once there are at least a handful of leads in both this
        period and the one before it — below that, a percentage swing says more
        about the small numbers than about the advertising.
      </section>
    );
  }

  return (
    <section
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[12px] border px-4 py-3"
      style={{
        borderColor: "var(--border)",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--accent) 5%, var(--surface-1)) 0%, var(--surface-1) 100%)",
      }}
      aria-label="What changed this period"
    >
      <span
        className="shrink-0 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
        style={{ color: "var(--accent)" }}
      >
        What changed
      </span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {insights.map((ins, i) => {
          const t = TONE[ins.tone];
          return (
            <span key={i} className="flex items-center gap-2 text-[13px]">
              <span
                aria-hidden="true"
                className="text-[9px]"
                style={{ color: t.color }}
              >
                {t.caret}
              </span>
              <span style={{ color: "var(--text-secondary)" }}>{ins.text}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}
