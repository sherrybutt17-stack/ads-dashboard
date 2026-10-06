import type { Insight } from "@/lib/metrics/insights";

/**
 * "What changed" — the one-line story above the KPIs.
 *
 * Turns six tiles the viewer would otherwise have to scan and interpret into a
 * named narrative. Tone is polarity-aware and never colour-alone: each insight
 * carries a small directional caret plus its text.
 *
 * It is drawn as the notched dark panel — the one place in the product that
 * uses it. That is deliberate rationing: the panel is loud, and a second one on
 * the same screen would make neither read as the headline. The tab is the
 * section's own name, so the label costs no vertical space inside the panel.
 *
 * Tones come from the panel's own on-navy palette (`--panel-*`, declared on
 * `.panel-notched`), NOT from `--delta-*` — those are measured against the page
 * surfaces, and `--delta-good` is #006300 in light theme, which on navy is
 * unreadable.
 */

const TONE: Record<Insight["tone"], { color: string; caret: string }> = {
  good: { color: "var(--panel-good)", caret: "▲" },
  bad: { color: "var(--panel-bad)", caret: "▼" },
  neutral: { color: "var(--panel-ink-soft)", caret: "•" },
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
        className="rounded-[var(--radius)] border px-4 py-3 text-xs"
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
      className="panel-notched mt-[42px] flex flex-wrap items-center gap-x-5 gap-y-2.5 px-5 py-4"
      aria-label="What changed this period"
    >
      {/*
        The tab sits above the panel's top edge (`bottom: 100%`), which is what
        the 42px top margin on the panel is reserving — without it the tab
        overlaps whatever is above.
      */}
      <span className="panel-tab text-[11px] font-semibold tracking-[0.07em] uppercase">
        What changed
      </span>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
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
              <span style={{ color: "var(--panel-ink)" }}>{ins.text}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}
