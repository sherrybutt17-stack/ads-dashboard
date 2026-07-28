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
  if (insights.length === 0) return null;

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
