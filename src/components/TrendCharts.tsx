"use client";

import { useEffect, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dayLabel } from "@/lib/dates";
import { formatCurrency, formatNumber } from "@/lib/metrics/compute";
import type { DailyPoint, TrendAnnotation } from "@/lib/metrics/queries";
import {
  DataState,
  PipeNotice,
  type DataStateProps,
} from "@/components/DataState";
import { Icon } from "@/components/Icon";

/**
 * Spend and leads over time, as TWO STACKED CHARTS sharing an x-axis — not one
 * dual-axis chart.
 *
 * A dual-axis chart lets you place two arbitrary scales side by side, and the
 * apparent crossings and correlations are an artifact of where you happened to
 * put the axes. It is the single most misleading chart form in common use.
 * Stacked panels with a shared x let the eye compare the same instants without
 * inventing a relationship between dollars and lead counts.
 *
 * Each panel carries ONE measure, plus a faint dashed GHOST of the previous
 * period (index-aligned) so "up or down vs last time" is visible without
 * reading a single number. The ghost is direct-labelled in the panel legend, so
 * the two lines are never distinguished by colour alone.
 *
 * The two panels also fail INDEPENDENTLY, which is why each carries its own
 * state rather than the card carrying one. Spend comes from the ad platform and
 * leads come from the CRM; collapsing the whole card to a single dashed box —
 * as this did — hid a working lead feed whenever Meta was unreachable, and hid
 * an unreachable Meta whenever a client simply had a quiet week. Those are four
 * different situations and they now render as four different things.
 */

interface Props {
  daily: DailyPoint[];
  prevDaily?: DailyPoint[];
  currency: string;
  /** Why spend is absent, resolved server-side. Null when the ad pipe is live. */
  spendState?: DataStateProps | null;
  /** Why leads are absent. Null when the CRM pipe is live. */
  leadsState?: DataStateProps | null;
  /** Label for the ad platform in fallback copy — "Meta" or "Google". */
  spendLabel?: string;
  /**
   * Events to mark on the time axis — "what happened on the 14th?".
   *
   * Rendered ONLY on the spend panel and ONLY when the ad pipe is healthy. An
   * annotation is an explanation, and explaining a number we have just told the
   * reader not to trust is worse than saying nothing: it lends the stale figure
   * a specificity it has not earned.
   */
  annotations?: TrendAnnotation[];
  /**
   * Render at a FIXED pixel width instead of measuring the container.
   *
   * 🔴 Set this on any surface that will be printed. `ResponsiveContainer`
   * sizes itself from a `ResizeObserver` measurement. Printing re-lays-out the
   * page at the PAPER width — a different width from the screen — and observer
   * callbacks are delivered asynchronously while rasterisation is not, so the
   * chart is captured at its stale screen width: clipped on a narrower page,
   * stranded in a column of white space on a wider one.
   *
   * A fixed width removes the measurement from the path entirely: the chart is
   * already the width the page will be, so there is nothing to re-measure when
   * the layout changes.
   *
   * ⚠️ Measured, not assumed: `renderToStaticMarkup` of an explicitly-sized
   * Recharts 3.10 chart emits `<div class="recharts-wrapper" style="width:680px">`
   * and **nothing inside it** — no `<svg>`, no paths. Recharts 3 builds its
   * geometry from a store populated after mount, so charts are client-rendered
   * either way and this prop does not change that. What it changes is the
   * dependency on a resize observation that print will not wait for. A reader
   * with JavaScript disabled gets an empty chart frame on both paths.
   */
  fixedWidth?: number;
}

/**
 * Which mark the trend panels draw.
 *
 * All three answer the same question about the same numbers on the same scale;
 * only the mark changes. That is the whole reason a switcher is safe here —
 * nothing about the axes, the range or the aggregation moves with it, so no
 * choice can make the chart say something the others do not.
 *
 * Area is the default because a filled shape reads as a continuous quantity
 * over time, which daily spend is. Line is the honest choice when the reader
 * cares about the shape of the change rather than the volume under it, and Bar
 * is right when they want to read individual days off the chart — which a
 * smoothed curve actively discourages.
 */
type ChartForm = "area" | "line" | "bar";

const FORMS: readonly { id: ChartForm; label: string }[] = [
  { id: "area", label: "Area" },
  { id: "line", label: "Line" },
  { id: "bar", label: "Bar" },
];

const FORM_KEY = "trend.chartForm";

function isChartForm(v: unknown): v is ChartForm {
  return v === "area" || v === "line" || v === "bar";
}

/**
 * Remembered per viewer, in localStorage.
 *
 * Deliberately NOT read during the first render. The server has no localStorage
 * and would render "area" regardless, so reading it synchronously on the client
 * makes the two trees disagree and React discards the server HTML. Reading it
 * in an effect costs one extra paint and cannot desync.
 *
 * Every access is wrapped: in a private window, or with site data blocked, the
 * accessor throws rather than returning null, and an unreadable preference must
 * not take the chart down with it.
 */
function useChartForm(): [ChartForm, (f: ChartForm) => void] {
  const [form, setForm] = useState<ChartForm>("area");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(FORM_KEY);
      // The one extra render is the point — see the note above this hook.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a render-time read would desync hydration
      if (isChartForm(saved)) setForm(saved);
    } catch {
      /* unreadable storage is not an error worth showing anyone */
    }
  }, []);

  const choose = (f: ChartForm) => {
    setForm(f);
    try {
      window.localStorage.setItem(FORM_KEY, f);
    } catch {
      /* the choice still applies to this page; it just will not outlive it */
    }
  };

  return [form, choose];
}

/**
 * The switcher. Styled as the date presets are — `accent-fill` for the active
 * segment — because it IS the same kind of control, and because the accent is
 * what selection wears here. A series colour would say "this button is data".
 */
function FormSwitch({
  value,
  onChange,
}: {
  value: ChartForm;
  onChange: (f: ChartForm) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Chart form"
      className="flex items-center gap-0.5 rounded-[var(--radius-sm)] p-0.5"
      style={{ background: "var(--surface-2)" }}
    >
      {FORMS.map((f) => {
        const active = f.id === value;
        return (
          <button
            key={f.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(f.id)}
            className={`rounded-[var(--radius-xs)] px-2 py-1 text-[11px] font-semibold transition-colors${
              active ? " accent-fill" : ""
            }`}
            style={
              active
                ? undefined
                : { background: "transparent", color: "var(--text-secondary)" }
            }
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

export function TrendCharts({
  daily,
  prevDaily,
  currency,
  spendState,
  leadsState,
  spendLabel = "ad",
  annotations = [],
  fixedWidth,
}: Props) {
  const [form, setForm] = useChartForm();

  const data = daily.map((d, i) => ({
    date: d.dateKey,
    label: dayLabel(d.dateKey),
    spend: d.ads.spend,
    leads: d.funnel.new_lead,
    prevSpend: prevDaily?.[i]?.ads.spend ?? null,
    prevLeads: prevDaily?.[i]?.funnel.new_lead ?? null,
  }));

  const hasSpend = data.some((d) => d.spend > 0);
  const hasLeads = data.some((d) => d.leads > 0);
  const hasPrev = Boolean(prevDaily?.length);

  /*
   * A pipe problem outranks an empty range: if we cannot reach Meta, "no spend
   * this period" is a claim we have no right to make. Only once the pipe is
   * known good does zero spend get to mean paused.
   */
  const spendEmpty: DataStateProps | null =
    spendState ??
    (hasSpend
      ? null
      : {
          title: `No ${spendLabel} spend in this period`,
          detail:
            "The account is connected and reporting — nothing ran in this date range.",
          tone: "neutral" as const,
        });

  const leadsEmpty: DataStateProps | null =
    leadsState ??
    (hasLeads
      ? null
      : {
          title: "No leads in this period",
          detail:
            "The CRM is connected and sending — nobody enquired in this range.",
          tone: "neutral" as const,
        });

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2
            className="mb-1 text-sm font-semibold"
            style={{ color: "var(--section-ink, var(--text-primary))" }}
          >
            Spend and leads over time
          </h2>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Separate scales, shared timeline — deliberately not overlaid
          </p>
        </div>
        {/*
          Not on paper. `fixedWidth` is only ever set by the print/report
          renderer, and a segmented control printed onto a report is three
          dead buttons and a lie about what the reader can do with the page.
        */}
        {!fixedWidth && <FormSwitch value={form} onChange={setForm} />}
      </div>

      <div className="flex flex-col gap-4">
        {spendEmpty ? (
          <PanelShell title="Ad spend">
            <DataState {...spendEmpty} size="compact" />
          </PanelShell>
        ) : (
          <Panel
            title="Ad spend"
            data={data}
            dataKey="spend"
            prevKey={hasPrev ? "prevSpend" : undefined}
            color="var(--series-1)"
            form={form}
            format={(v) => formatCurrency(v, currency)}
            // Populated but the pipe is degraded: keep the numbers, qualify them.
            notice={spendState ?? undefined}
            // Suppressed while the pipe is degraded — see the prop's comment.
            annotations={spendState ? [] : annotations}
            fixedWidth={fixedWidth}
          />
        )}
        {leadsEmpty ? (
          <PanelShell title="New leads">
            <DataState {...leadsEmpty} size="compact" />
          </PanelShell>
        ) : (
          <Panel
            title="New leads"
            data={data}
            dataKey="leads"
            prevKey={hasPrev ? "prevLeads" : undefined}
            color="var(--series-2)"
            form={form}
            format={(v) => formatNumber(v)}
            notice={leadsState ?? undefined}
            fixedWidth={fixedWidth}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Measure the container, or don't.
 *
 * `ResponsiveContainer` is right on screen and wrong on paper — it needs a
 * layout pass and a `ResizeObserver` tick before it knows how wide it is, and
 * printing does not wait for either. When an explicit width is supplied the
 * container is removed from the tree entirely rather than being given a fixed
 * size, because a container that still measures is a container that can still
 * measure the wrong thing.
 */
function SizedChart({
  width,
  children,
}: {
  width?: number;
  children: React.ReactElement;
}) {
  if (width) return children;
  // Height comes from the wrapping div, which sets it explicitly; only the
  // width has ever needed measuring.
  return (
    <ResponsiveContainer width="100%" height="100%">
      {children}
    </ResponsiveContainer>
  );
}

/** The panel's title row without a chart under it, so an absent panel keeps its
 *  place in the stack rather than the layout silently reflowing. */
function PanelShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mb-1 text-xs font-medium"
        style={{ color: "var(--text-secondary)" }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

/** 2px surface ring keeps the hover marker legible over the mark beneath it. */
const ACTIVE_DOT = (color: string) => ({
  r: 4,
  fill: color,
  stroke: "var(--surface-1)",
  strokeWidth: 2,
});

function Panel({
  title,
  data,
  dataKey,
  prevKey,
  color,
  form,
  format,
  notice,
  annotations = [],
  fixedWidth,
}: {
  title: string;
  data: Array<Record<string, string | number | null>>;
  dataKey: string;
  prevKey?: string;
  color: string;
  form: ChartForm;
  format: (v: number) => string;
  notice?: DataStateProps;
  annotations?: TrendAnnotation[];
  fixedWidth?: number;
}) {
  const gradientId = `grad-${dataKey}`;
  const chartHeight = 132;

  /*
   * Collapse to one mark per day. Three campaigns launching together is one
   * thing that happened, and three overlapping markers on the same tick is
   * unreadable — the tooltip lists them all.
   */
  const marks = new Map<string, TrendAnnotation[]>();
  for (const a of annotations) {
    const point = data.find((d) => d.date === a.dateKey);
    if (!point) continue; // outside the visible range
    const key = String(point.label);
    marks.set(key, [...(marks.get(key) ?? []), a]);
  }
  return (
    <div>
      {notice && <PipeNotice {...notice} />}
      <div className="mb-1 flex items-center justify-between gap-3">
        <div
          className="text-xs font-medium"
          style={{ color: "var(--text-secondary)" }}
        >
          {title}
        </div>
        {prevKey && (
          <div
            className="flex items-center gap-3 text-[10px]"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="flex items-center gap-1">
              {/*
                The key shows the mark that is actually on screen. A 2px rule
                next to a bar chart names something the reader cannot find.
              */}
              <span
                className={
                  form === "bar"
                    ? "inline-block h-2.5 w-2.5 rounded-[2px]"
                    : "inline-block h-[2px] w-3.5 rounded-full"
                }
                style={{ background: color }}
              />
              This period
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-0 w-3.5"
                style={{ borderTop: "1.5px dashed var(--text-muted)" }}
              />
              Previous
            </span>
          </div>
        )}
      </div>
      <div style={{ height: chartHeight }}>
        <SizedChart width={fixedWidth}>
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            /*
             * Only set when printing. `ResponsiveContainer` injects these by
             * cloning its child, so passing them here while ALSO wrapping in a
             * container would be redundant at best and fight the measurement at
             * worst — hence one or the other, never both (see `SizedChart`).
             */
            {...(fixedWidth ? { width: fixedWidth, height: chartHeight } : {})}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke="var(--gridline)"
              strokeDasharray="0"
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "var(--baseline)" }}
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(v) => format(Number(v))}
            />
            <Tooltip
              cursor={{ stroke: "var(--baseline)", strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const cur = payload.find((p) => p.dataKey === dataKey)?.value;
                const prev = payload.find((p) => p.dataKey === prevKey)?.value;
                return (
                  <div
                    className="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs shadow-lg"
                    style={{
                      background: "var(--surface-raised)",
                      border: "1px solid var(--border-strong)",
                      color: "var(--text-primary)",
                    }}
                  >
                    <div style={{ color: "var(--text-muted)" }}>{label}</div>
                    <div className="tnum mt-0.5 font-semibold">
                      {cur != null ? format(Number(cur)) : "–"}
                    </div>
                    {prevKey && prev != null && (
                      <div
                        className="tnum mt-0.5"
                        style={{ color: "var(--text-muted)" }}
                      >
                        prev {format(Number(prev))}
                      </div>
                    )}
                  </div>
                );
              }}
            />
            {/*
              Ghost first, so the current series draws on top of it.

              Always a dashed line, whatever mark the current period wears. It
              was already drawn as one — an `<Area>` with `fill="none"` IS a
              line — and pinning it that way is what lets the switcher change
              the current series without changing the thing it is compared to.
              A ghost that changed shape alongside it would make the comparison
              a moving target, and paired bars would read as two live series
              rather than one and its shadow.
            */}
            {prevKey && (
              <Line
                type="monotone"
                dataKey={prevKey}
                stroke="var(--text-muted)"
                strokeWidth={1.25}
                strokeDasharray="3 3"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                connectNulls
              />
            )}
            {form === "area" && (
              <Area
                type="monotone"
                dataKey={dataKey}
                stroke={color}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={false}
                activeDot={ACTIVE_DOT(color)}
              />
            )}
            {form === "line" && (
              <Line
                type="monotone"
                dataKey={dataKey}
                stroke={color}
                strokeWidth={2}
                dot={false}
                activeDot={ACTIVE_DOT(color)}
              />
            )}
            {form === "bar" && (
              <Bar
                dataKey={dataKey}
                fill={color}
                /*
                 * Rounded at the data end only, anchored to the baseline: a bar
                 * rounded at the bottom too would lift off its own zero and
                 * overstate every small value.
                 */
                radius={[4, 4, 0, 0]}
                /* Thin marks. Thirty days at full width reads as a solid block. */
                maxBarSize={18}
              />
            )}
            {/*
              Event marks, drawn LAST so they sit above the area fill.

              Deliberately understated: a thin dashed rule and a small dot, in
              muted grey rather than a status colour. These are context, not
              judgements — "a campaign started here" is neither good nor bad, and
              colouring it red or green would editorialise a fact.
            */}
            {[...marks.keys()].map((label) => (
              <ReferenceLine
                key={label}
                x={label}
                stroke="var(--text-muted)"
                strokeDasharray="2 3"
                strokeOpacity={0.7}
                label={{
                  value: "◆",
                  position: "top",
                  fill: "var(--text-muted)",
                  fontSize: 8,
                }}
              />
            ))}
          </ComposedChart>
        </SizedChart>
      </div>

      {marks.size > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5">
          {[...marks.entries()].map(([label, list]) => (
            <li
              key={label}
              className="flex gap-1.5 text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              <span aria-hidden="true">◆</span>
              <span>
                <strong
                  style={{ color: "var(--text-secondary)", fontWeight: 600 }}
                >
                  {label}
                </strong>{" "}
                — {list.map((a) => a.label).join("; ")}
                {list.some((a) => a.detail) && (
                  <span
                    title={list
                      .map((a) => a.detail)
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {" "}
                    <Icon
                      name="help"
                      size={9}
                      className="inline-block align-[-1px]"
                    />
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
