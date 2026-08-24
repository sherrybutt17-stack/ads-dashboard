"use client";

import { Funnel } from "@/components/Funnel";
import { TrendCharts } from "@/components/TrendCharts";
import { changeSentiment, formatCurrency, formatNumber } from "@/lib/metrics/compute";
import {
  describeTarget,
  formatMetricValue,
  monthLabel,
  nextMonthKey,
  VERDICT_LABEL,
  type CommitmentStatus,
} from "@/lib/commentary/model";
import { formatValue, type Slide } from "@/lib/present/slides";

/**
 * One slide.
 *
 * ── The typographic rule ───────────────────────────────────────────────
 *
 * The number is the largest thing on the screen and everything else is smaller
 * than it by a lot. On a shared screen at meeting distance there is exactly one
 * thing a room can read at a glance, and letting a label or a delta compete for
 * that is what turns a presentation back into a dashboard.
 *
 * ── The two honesty carry-overs ────────────────────────────────────────
 *
 * **The basis line is not decoration.** "Cost per lead: $47" gets asked "per
 * lead of what?" on roughly every call, and BOOK% / SHOW% / CLOSE% each use a
 * different denominator. The line under the number answers it before it is
 * asked.
 *
 * **A delta inside the dead band is grey.** Via `changeSentiment`, the same
 * function the dashboard tiles use — so a 1% move cannot be green here and
 * neutral there, which is the sort of thing a client spots and remembers.
 */

const SENTIMENT_COLOR = {
  good: "var(--delta-good)",
  bad: "var(--delta-bad)",
  neutral: "var(--text-muted)",
} as const;

function Stage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-4xl">{children}</div>;
}

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-[13px] tracking-[0.14em] uppercase sm:text-[15px]"
      style={{ color: "var(--text-muted)" }}
    >
      {children}
    </p>
  );
}

/** A bare-bones sparkline. No axes, no grid — a shape, at a glance. */
function Spark({ values }: { values: number[] }) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return null;
  const max = Math.max(...clean);
  const min = Math.min(...clean);
  const span = max - min || 1;
  const points = clean
    .map((v, i) => {
      const x = (i / (clean.length - 1)) * 100;
      const y = 30 - ((v - min) / span) * 28;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className="mt-6 h-16 w-full"
      role="presentation"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--text-muted)"
        strokeWidth="0.8"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const STATUS_LOOK: Record<CommitmentStatus, { label: string; color: string }> = {
  met: { label: "Met", color: "var(--status-good)" },
  missed: { label: "Missed", color: "var(--status-critical)" },
  unmeasurable: { label: "Not measurable", color: "var(--text-muted)" },
  done: { label: VERDICT_LABEL.done, color: "var(--status-good)" },
  partly: { label: VERDICT_LABEL.partly, color: "var(--status-warning)" },
  not_done: { label: VERDICT_LABEL.not_done, color: "var(--status-critical)" },
  dropped: { label: VERDICT_LABEL.dropped, color: "var(--text-muted)" },
  unanswered: { label: "Not answered", color: "var(--status-warning)" },
};

export function SlideView({ slide, currency }: { slide: Slide; currency: string }) {
  switch (slide.kind) {
    case "title":
      return (
        <Stage>
          <Kicker>{slide.periodLabel}</Kicker>
          <h1
            className="mt-4 text-[44px] leading-[1.05] font-semibold sm:text-[72px]"
            style={{ color: "var(--text-primary)", letterSpacing: "-0.03em" }}
          >
            {slide.brandName}
          </h1>
          <p
            className="mt-5 text-[15px] sm:text-[18px]"
            style={{ color: "var(--text-secondary)" }}
          >
            {slide.platformLabel} advertising, matched to pipeline outcomes.
          </p>
          <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
            All figures in {slide.timezone.replace(/_/g, " ")}.
          </p>
        </Stage>
      );

    case "metric": {
      const tone = changeSentiment(slide.polarityKey, slide.delta);
      return (
        <Stage>
          <Kicker>{slide.label}</Kicker>
          <p
            className="tnum mt-3 text-[68px] leading-none font-semibold sm:text-[124px]"
            style={{ color: "var(--text-primary)", letterSpacing: "-0.04em" }}
          >
            {formatValue(slide.value, slide.format, currency)}
          </p>

          <div className="mt-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {slide.delta !== null && (
              <span
                className="tnum text-[17px] font-medium sm:text-[21px]"
                style={{ color: SENTIMENT_COLOR[tone] }}
              >
                {/*
                 * The arrow is direction, the colour is judgement, and they are
                 * separate on purpose: a falling cost per lead points down and
                 * reads good. Never colour alone.
                 */}
                {slide.delta >= 0 ? "▲" : "▼"}{" "}
                {Math.abs(slide.delta * 100).toFixed(1)}%
                <span
                  className="ml-2 text-[13px] font-normal sm:text-[15px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  vs the previous period
                </span>
              </span>
            )}
          </div>

          <p
            className="mt-4 text-[14px] sm:text-[16px]"
            style={{ color: "var(--text-secondary)" }}
          >
            {slide.basis}
          </p>
          {slide.note && (
            <p
              className="mt-2 text-[14px] sm:text-[16px]"
              style={{ color: "var(--status-warning)" }}
            >
              {slide.note}
            </p>
          )}

          <Spark values={slide.spark} />
        </Stage>
      );
    }

    case "funnel":
      return (
        <Stage>
          <Kicker>Where the leads go</Kicker>
          <div className="mt-4">
            <Funnel steps={slide.steps} />
          </div>
        </Stage>
      );

    case "trend":
      return (
        <Stage>
          <Kicker>Spend and leads, day by day</Kicker>
          <div className="mt-4">
            <TrendCharts
              daily={slide.daily}
              prevDaily={slide.prevDaily}
              currency={currency}
            />
          </div>
        </Stage>
      );

    case "campaigns":
      return (
        <Stage>
          <Kicker>Campaigns</Kicker>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-[14px] sm:text-[16px]">
              <thead>
                <tr style={{ color: "var(--text-muted)" }}>
                  <th className="py-2 text-left font-normal">Campaign</th>
                  <th className="py-2 text-right font-normal">Spend</th>
                  <th className="py-2 text-right font-normal">Leads</th>
                  <th className="py-2 text-right font-normal">Cost per lead</th>
                </tr>
              </thead>
              <tbody>
                {slide.rows.map((r) => (
                  <tr
                    key={r.campaignId}
                    className="border-t"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <td
                      className="max-w-[22ch] truncate py-2.5 sm:max-w-[38ch]"
                      style={{ color: "var(--text-primary)" }}
                      title={r.campaignName}
                    >
                      {r.campaignName}
                    </td>
                    <td className="tnum py-2.5 text-right" style={{ color: "var(--text-secondary)" }}>
                      {formatCurrency(r.spend, currency)}
                    </td>
                    <td className="tnum py-2.5 text-right" style={{ color: "var(--text-secondary)" }}>
                      {formatNumber(r.leads)}
                    </td>
                    <td className="tnum py-2.5 text-right" style={{ color: "var(--text-primary)" }}>
                      {formatCurrency(r.cpLead, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Stage>
      );

    case "accountability": {
      const a = slide.accountability;
      const judged = a.counts.met + a.counts.missed;
      return (
        <Stage>
          <Kicker>What we said we&rsquo;d do in {monthLabel(slide.month)}</Kicker>
          <ul className="mt-5 grid gap-3">
            {a.items.map((item) => {
              const look = STATUS_LOOK[item.status];
              return (
                <li
                  key={item.commitment.id}
                  className="flex items-start justify-between gap-4 border-t pt-3"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="min-w-0">
                    <p
                      className="text-[16px] leading-snug sm:text-[19px]"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {item.commitment.text}
                    </p>
                    {item.commitment.target && (
                      <p
                        className="tnum mt-1 text-[13px] sm:text-[15px]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {describeTarget(item.commitment.target, slide.currency)} ·{" "}
                        {item.status === "unmeasurable"
                          ? "no figure recorded"
                          : `actual ${formatMetricValue(item.commitment.target.metric, item.actual, slide.currency)}`}
                      </p>
                    )}
                  </div>
                  <span
                    className="shrink-0 rounded-full px-3 py-1 text-[13px] font-medium sm:text-[15px]"
                    style={{
                      color: look.color,
                      border: `1px solid ${look.color}`,
                      background: `color-mix(in srgb, ${look.color} 10%, transparent)`,
                    }}
                  >
                    {look.label}
                  </span>
                </li>
              );
            })}
          </ul>
          {/*
           * The coverage line stays on the slide the room sees. An unanswered
           * commitment is the thing an agency has most reason to leave off, so
           * it is not a presenter-only note.
           */}
          <p className="mt-5 text-[14px] sm:text-[16px]" style={{ color: "var(--text-muted)" }}>
            {judged > 0 && `${a.counts.met} of ${judged} measured targets met`}
            {judged > 0 && a.unanswered > 0 && " · "}
            {a.unanswered > 0 && (
              <span style={{ color: "var(--status-warning)" }}>
                {a.unanswered} of {a.total} not answered
              </span>
            )}
          </p>
        </Stage>
      );
    }

    case "prose":
      return (
        <Stage>
          <Kicker>{slide.heading}</Kicker>
          <div className="mt-5 grid gap-4">
            {slide.body
              .split(/\n{2,}/)
              .map((p) => p.trim())
              .filter(Boolean)
              .map((p, i) => (
                <p
                  key={i}
                  className="text-[18px] leading-relaxed whitespace-pre-line sm:text-[24px]"
                  style={{ color: "var(--text-primary)" }}
                >
                  {p}
                </p>
              ))}
          </div>
        </Stage>
      );

    case "plan":
      return (
        <Stage>
          <Kicker>{slide.heading}</Kicker>
          <ul className="mt-5 grid gap-4">
            {slide.commitments.map((c) => (
              <li
                key={c.id}
                className="border-t pt-3"
                style={{ borderColor: "var(--border)" }}
              >
                <p
                  className="text-[18px] leading-snug sm:text-[24px]"
                  style={{ color: "var(--text-primary)" }}
                >
                  {c.text}
                </p>
                {c.target && (
                  <p
                    className="tnum mt-1 text-[14px] sm:text-[16px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Target: {describeTarget(c.target, slide.currency)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Stage>
      );

    case "close":
      return (
        <Stage>
          <h1
            className="text-[40px] leading-tight font-semibold sm:text-[64px]"
            style={{ color: "var(--text-primary)", letterSpacing: "-0.03em" }}
          >
            Questions?
          </h1>
          <p
            className="mt-4 text-[15px] sm:text-[18px]"
            style={{ color: "var(--text-secondary)" }}
          >
            Every figure in this deck is live on {slide.brandName}&rsquo;s
            dashboard, with the same definitions.
          </p>
        </Stage>
      );
  }
}

/** Exported for the deck's "next up" hint and for tests. */
export function slideTitle(slide: Slide): string {
  switch (slide.kind) {
    case "title":
      return slide.brandName;
    case "metric":
      return slide.label;
    case "funnel":
      return "Funnel";
    case "trend":
      return "Trend";
    case "campaigns":
      return "Campaigns";
    case "accountability":
      return `${monthLabel(slide.month)} plan`;
    case "prose":
    case "plan":
      return slide.heading;
    case "close":
      return "Questions";
  }
}

/** The month a plan slide is committing to, for the deck's own labelling. */
export function planMonthLabel(month: string): string {
  return monthLabel(nextMonthKey(month));
}
