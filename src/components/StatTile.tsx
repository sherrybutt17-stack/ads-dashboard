"use client";

import { useEffect, useRef, useState } from "react";
import {
  changeSentiment,
  formatChange,
  formatCurrency,
  formatNumber,
} from "@/lib/metrics/compute";

/**
 * A headline metric: large value, its trend, and a period-over-period delta.
 *
 * Layout: the value owns a full-width line of its own so it can never be
 * squeezed by the sparkline (the bug where "$1,932.71" rendered as "$1,9…").
 * The sparkline drops to the footer row beside the delta, where it conveys
 * shape without competing for the value's width.
 *
 * On mount the number counts up from zero — the small motion that makes a
 * dashboard feel alive rather than static. It honours prefers-reduced-motion
 * and only animates a real numeric value (a "–" or null never counts up).
 *
 * The delta colour is POLARITY-AWARE — a 20% fall in cost-per-lead is good news
 * and renders green; a 20% fall in leads is bad and renders red. Sentiment is
 * never colour-alone: an arrow glyph always accompanies it.
 */

export interface StatTileProps {
  label: string;
  value: string;
  metricKey: string;
  change: number | null;
  spark?: number[];
  footnote?: string;
  emphasis?: boolean;
  /** When set (and finite), the value counts up on mount, formatted per `format`. */
  numeric?: number | null;
  format?: "currency" | "number";
  currency?: string;
}

/**
 * Count up from 0 → target once on mount, easing out. State is only ever set
 * inside the rAF callback (never synchronously in the effect body); `anim`
 * holds the in-flight value and is released to null on completion so the tile
 * always falls through to the live target afterwards.
 */
function useCountUp(target: number | null | undefined, canAnimate: boolean): number {
  const isNum = typeof target === "number" && Number.isFinite(target);
  const [anim, setAnim] = useState<number | null>(canAnimate && isNum ? 0 : null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!canAnimate || !isNum || doneRef.current) return;
    const t = target as number;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      const raf = requestAnimationFrame(() => {
        setAnim(null);
        doneRef.current = true;
      });
      return () => cancelAnimationFrame(raf);
    }
    const duration = 850;
    let raf = 0;
    let startTs = 0;
    const step = (ts: number) => {
      if (!startTs) startTs = ts;
      const p = Math.min(1, (ts - startTs) / duration);
      setAnim(t * (1 - Math.pow(1 - p, 3)));
      if (p < 1) {
        raf = requestAnimationFrame(step);
      } else {
        setAnim(null);
        doneRef.current = true;
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, canAnimate, isNum]);

  return anim ?? (isNum ? (target as number) : 0);
}

export function StatTile({
  label,
  value,
  metricKey,
  change,
  spark,
  footnote,
  emphasis,
  numeric,
  format,
  currency = "USD",
}: StatTileProps) {
  const canAnimate =
    typeof numeric === "number" && Number.isFinite(numeric) && Boolean(format);
  const animated = useCountUp(numeric, canAnimate);
  const display = canAnimate
    ? format === "currency"
      ? formatCurrency(animated, currency)
      : formatNumber(animated)
    : value;

  const sentiment = changeSentiment(metricKey, change);
  const color =
    sentiment === "good"
      ? "var(--delta-good)"
      : sentiment === "bad"
        ? "var(--delta-bad)"
        : "var(--text-muted)";
  const arrow = change === null || change === 0 ? "" : change > 0 ? "↑" : "↓";

  return (
    <div
      className={`card card-interactive flex flex-col gap-2.5 p-4 sm:p-5${
        emphasis ? " card-accent" : ""
      }`}
    >
      <span
        className="text-[10.5px] font-semibold tracking-[0.08em] uppercase"
        style={{ color: emphasis ? "var(--accent)" : "var(--text-muted)" }}
      >
        {label}
      </span>

      {/* Value owns its own line — never truncated by the sparkline. */}
      <div
        className="num-display text-[27px] leading-none font-semibold whitespace-nowrap sm:text-[33px]"
        style={{ color: "var(--text-primary)" }}
      >
        {display}
      </div>

      {footnote && (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {footnote}
        </div>
      )}

      <div className="mt-auto flex items-end justify-between gap-3 pt-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="tnum font-semibold" style={{ color }}>
            {arrow && <span aria-hidden="true">{arrow} </span>}
            {formatChange(change)}
          </span>
          <span className="hidden sm:inline" style={{ color: "var(--text-muted)" }}>
            vs prev
          </span>
        </div>

        {spark && spark.length > 1 && (
          <Sparkline data={spark} sentiment={sentiment} idKey={metricKey} />
        )}
      </div>
    </div>
  );
}

/**
 * Sparkline with a soft area fill and an emphasized endpoint — shape, not value.
 * The number above carries the value; this is deliberately axis-free.
 */
function Sparkline({
  data,
  sentiment,
  idKey,
}: {
  data: number[];
  sentiment: "good" | "bad" | "neutral";
  idKey: string;
}) {
  const w = 76;
  const h = 30;
  const pad = 3;
  const max = Math.max(...data, 0);
  const min = Math.min(...data, 0);
  const span = max - min || 1;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (w - pad * 2) + pad;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return [x, y] as const;
  });

  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${points[points.length - 1][0].toFixed(1)},${h} L${points[0][0].toFixed(1)},${h} Z`;

  const stroke =
    sentiment === "good"
      ? "var(--delta-good)"
      : sentiment === "bad"
        ? "var(--delta-bad)"
        : "var(--series-1)";
  const gid = `spark-${idKey}`;
  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r={2.6} fill={stroke} stroke="var(--surface-1)" strokeWidth={1.5} />
    </svg>
  );
}
