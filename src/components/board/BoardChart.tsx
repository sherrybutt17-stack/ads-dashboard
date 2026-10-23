"use client";

import type { ReactElement, ReactNode } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CategoryForm, DimensionId, MetricFormat, SeriesForm } from "@/lib/board/catalog";
import { barSlots, categorySlots, circleAllowed, shareLabel, tickLabel } from "@/lib/board/chart-rules";
import { formatMetricValue } from "@/lib/board/format";
import type { CategoryRow, SeriesPoint } from "@/lib/board/types";

/**
 * The board's two chart families: one stat over time, one stat split by a
 * dimension.
 *
 * New rather than built on `CategoryChart`/`TrendCharts`: those carry their own
 * form switch and remember the viewer's last choice, which on a board would
 * override the form the widget was saved with — a donut someone chose would
 * show as bars on a colleague's screen. Here the widget's saved form is the
 * form, full stop.
 *
 * The conventions are the dashboard's: one measure per plot and never a second
 * axis; the categorical ramp in fixed order, never cycled, with the eighth
 * slot left for status; bars in one colour, since each is named on its axis
 * (`barSlots`); "Other" and Meta's withheld remainder in neutral greys because
 * they are not entities; 4px rounded data ends with a square baseline; text in
 * text tokens, never the series colour.
 */

const RAMP = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
] as const;

const OTHER_COLOR = "var(--text-muted)";
const NOT_REPORTED_COLOR = "var(--border-strong)";
const SERIES_COLOR = "var(--series-1)";
const GHOST_COLOR = "var(--text-muted)";

const axisTick = { fill: "var(--text-muted)", fontSize: 10 };

export interface FixedSize {
  width: number;
  height: number;
}

/** Fills its box on screen; takes an exact size in a printed document. */
function Frame({ fixed, children }: { fixed?: FixedSize; children: ReactNode }) {
  if (fixed) {
    return <div style={{ width: fixed.width, height: fixed.height }}>{children}</div>;
  }
  return (
    <div className="min-h-0 flex-1">
      <ResponsiveContainer width="100%" height="100%" minHeight={120}>
        {children as ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

function TooltipBox({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs shadow-lg"
      style={{
        background: "var(--surface-raised)",
        border: "1px solid var(--border-strong)",
        color: "var(--text-primary)",
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One stat over time
 * ------------------------------------------------------------------ */

export function BoardSeriesChart({
  points,
  form,
  format,
  currency,
  measure,
  prevLabel,
  fixed,
}: {
  points: SeriesPoint[];
  form: SeriesForm;
  format: MetricFormat;
  currency: string;
  /** The stat's name, for the tooltip and the screen-reader table. */
  measure: string;
  prevLabel: string | null;
  fixed?: FixedSize;
}) {
  const fmt = (v: number | null) => formatMetricValue(format, v, currency);
  const hasPrev = prevLabel !== null && points.some((p) => p.prev !== null);
  const size = fixed ? { width: fixed.width, height: fixed.height - (hasPrev ? 22 : 0) } : {};

  const chart = (
    <ComposedChart
      data={points}
      {...size}
      margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
      accessibilityLayer
    >
      <CartesianGrid stroke="var(--gridline)" vertical={false} />
      <XAxis
        dataKey="label"
        tick={axisTick}
        tickLine={false}
        axisLine={{ stroke: "var(--baseline)" }}
        interval="preserveStartEnd"
        minTickGap={18}
      />
      <YAxis
        tick={axisTick}
        tickLine={false}
        axisLine={false}
        width={56}
        tickFormatter={(v) => tickLabel(format, Number(v), currency)}
      />
      <Tooltip
        cursor={{ stroke: "var(--baseline)", strokeWidth: 1 }}
        content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0]?.payload as SeriesPoint | undefined;
          if (!p) return null;
          return (
            <TooltipBox>
              <div className="tnum font-semibold">{fmt(p.value)}</div>
              <div style={{ color: "var(--text-muted)" }}>
                {measure} · {p.label}
              </div>
              {hasPrev && (
                <div className="tnum mt-0.5" style={{ color: "var(--text-muted)" }}>
                  {fmt(p.prev)} previous period
                </div>
              )}
            </TooltipBox>
          );
        }}
      />
      {form === "column" ? (
        <Bar
          dataKey="value"
          fill={SERIES_COLOR}
          radius={[4, 4, 0, 0]}
          maxBarSize={24}
          isAnimationActive={false}
        />
      ) : form === "area" ? (
        <Area
          type="monotone"
          dataKey="value"
          stroke={SERIES_COLOR}
          strokeWidth={2}
          fill={SERIES_COLOR}
          fillOpacity={0.1}
          dot={false}
          activeDot={{ r: 4, stroke: "var(--card-bg)", strokeWidth: 2 }}
          isAnimationActive={false}
        />
      ) : (
        <Line
          type="monotone"
          dataKey="value"
          stroke={SERIES_COLOR}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, stroke: "var(--card-bg)", strokeWidth: 2 }}
          isAnimationActive={false}
        />
      )}
      {hasPrev && (
        // The previous period as a ghost: the dashboard's own convention for
        // "what this would have been", drawn under no form switch.
        <Line
          type="monotone"
          dataKey="prev"
          stroke={GHOST_COLOR}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
      )}
    </ComposedChart>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Frame fixed={fixed}>{chart}</Frame>
      {hasPrev && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="14" y2="3" stroke={SERIES_COLOR} strokeWidth="2" />
            </svg>
            This period
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="14" y2="3" stroke={GHOST_COLOR} strokeWidth="1.5" strokeDasharray="3 3" />
            </svg>
            {prevLabel}
          </span>
        </div>
      )}
      {/* Every value without hovering, for a screen reader. */}
      <table className="sr-only">
        <caption>{measure} by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">{measure}</th>
            {hasPrev && <th scope="col">{prevLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <th scope="row">{p.label}</th>
              <td>{fmt(p.value)}</td>
              {hasPrev && <td>{fmt(p.prev)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One stat split by a dimension
 * ------------------------------------------------------------------ */

export function BoardCategoryChart({
  rows,
  form,
  format,
  currency,
  measure,
  total,
  dimension,
  fixed,
}: {
  rows: CategoryRow[];
  form: CategoryForm;
  format: MetricFormat;
  currency: string;
  measure: string;
  total: number | null;
  dimension: DimensionId;
  fixed?: FixedSize;
}) {
  const fmt = (v: number | null) => formatMetricValue(format, v, currency);

  // A circle needs a whole to be part of; anything else falls back to bars.
  const circle = (form === "pie" || form === "donut") && circleAllowed(rows);
  const shownForm: CategoryForm = circle ? form : form === "hbar" ? "hbar" : "bar";

  const slots = circle ? categorySlots(dimension, rows) : barSlots(dimension, rows);
  const points = rows.map((r, i) => {
    const s = slots[i];
    return {
      ...r,
      color: s === "other" ? OTHER_COLOR : s === "not_reported" ? NOT_REPORTED_COLOR : RAMP[s - 1],
    };
  });

  const tooltip = (
    <Tooltip
      cursor={{ fill: "var(--surface-2)" }}
      content={({ active, payload }) => {
        if (!active || !payload?.length) return null;
        const p = payload[0]?.payload as (typeof points)[number] | undefined;
        if (!p) return null;
        const share = shareLabel(p.value, total);
        return (
          <TooltipBox>
            <div className="tnum font-semibold">{fmt(p.value)}</div>
            <div className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
              <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: p.color }} />
              {p.label}
            </div>
            {share && (
              <div className="tnum mt-0.5" style={{ color: "var(--text-muted)" }}>
                {share} of {measure.toLowerCase()}
              </div>
            )}
          </TooltipBox>
        );
      }}
    />
  );

  let chart: ReactElement;
  if (shownForm === "pie" || shownForm === "donut") {
    chart = (
      <PieChart {...(fixed ? { width: fixed.width, height: Math.max(120, fixed.height - legendHeight(points.length)) } : {})} accessibilityLayer>
        {tooltip}
        <Pie
          data={points}
          dataKey="value"
          nameKey="label"
          innerRadius={shownForm === "donut" ? "55%" : 0}
          outerRadius="85%"
          paddingAngle={shownForm === "donut" ? 1 : 0}
          stroke="var(--card-bg)"
          strokeWidth={2}
          isAnimationActive={false}
        >
          {points.map((p) => (
            <Cell key={p.key} fill={p.color} />
          ))}
        </Pie>
      </PieChart>
    );
  } else if (shownForm === "hbar") {
    chart = (
      <BarChart
        data={points}
        layout="vertical"
        {...(fixed ? { width: fixed.width, height: fixed.height } : {})}
        margin={{ top: 0, right: 56, bottom: 0, left: 0 }}
        accessibilityLayer
      >
        <CartesianGrid stroke="var(--gridline)" horizontal={false} />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={128}
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)}
        />
        {tooltip}
        <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={24} isAnimationActive={false}>
          {points.map((p) => (
            <Cell key={p.key} fill={p.color} />
          ))}
          {/* Bars carry their value at the tip, in a text token. */}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: unknown) => fmt(typeof v === "number" ? v : null)}
            style={{ fill: "var(--text-secondary)", fontSize: 10.5 }}
          />
        </Bar>
      </BarChart>
    );
  } else {
    chart = (
      <BarChart
        data={points}
        {...(fixed ? { width: fixed.width, height: fixed.height } : {})}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        accessibilityLayer
      >
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          interval={0}
          height={44}
          angle={-20}
          textAnchor="end"
          tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
        />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v) => tickLabel(format, Number(v), currency)}
        />
        {tooltip}
        <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}>
          {points.map((p) => (
            <Cell key={p.key} fill={p.color} />
          ))}
        </Bar>
      </BarChart>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Frame fixed={fixed}>{chart}</Frame>
      {circle && (
        // A circle's slices carry no labels, so the legend is the identity
        // channel — with each value and share, never colour alone.
        <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[11.5px] sm:grid-cols-2">
          {points.map((p) => (
            <li key={p.key} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ background: p.color }} />
              <span className="min-w-0 truncate" style={{ color: "var(--text-secondary)" }} title={p.label}>
                {p.label}
              </span>
              <span className="tnum ml-auto shrink-0" style={{ color: "var(--text-primary)" }}>
                {fmt(p.value)}
              </span>
              <span className="tnum w-11 shrink-0 text-right" style={{ color: "var(--text-muted)" }}>
                {shareLabel(p.value, total) ?? ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <table className="sr-only">
        <caption>{measure}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <th scope="row">{p.label}</th>
              <td>{fmt(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Height the legend takes under a circle, for printed documents. */
function legendHeight(rows: number): number {
  return 8 + Math.ceil(rows / 2) * 18;
}
