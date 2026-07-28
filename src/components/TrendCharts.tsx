"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dayLabel } from "@/lib/dates";
import { formatCurrency, formatNumber } from "@/lib/metrics/compute";
import type { DailyPoint } from "@/lib/metrics/queries";

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
 */

interface Props {
  daily: DailyPoint[];
  prevDaily?: DailyPoint[];
  currency: string;
}

export function TrendCharts({ daily, prevDaily, currency }: Props) {
  const data = daily.map((d, i) => ({
    date: d.dateKey,
    label: dayLabel(d.dateKey),
    spend: d.ads.spend,
    leads: d.funnel.new_lead,
    prevSpend: prevDaily?.[i]?.ads.spend ?? null,
    prevLeads: prevDaily?.[i]?.funnel.new_lead ?? null,
  }));

  const hasAny = data.some((d) => d.spend > 0 || d.leads > 0);
  const hasPrev = Boolean(prevDaily?.length);

  return (
    <div className="card p-5">
      <h2 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Spend and leads over time
      </h2>
      <p className="mb-4 text-xs" style={{ color: "var(--text-muted)" }}>
        Separate scales, shared timeline — deliberately not overlaid
      </p>

      {!hasAny ? (
        <div
          className="rounded-[10px] border border-dashed p-8 text-center text-sm"
          style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}
        >
          No spend or leads recorded in this period
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Panel
            title="Ad spend"
            data={data}
            dataKey="spend"
            prevKey={hasPrev ? "prevSpend" : undefined}
            color="var(--series-1)"
            format={(v) => formatCurrency(v, currency)}
          />
          <Panel
            title="New leads"
            data={data}
            dataKey="leads"
            prevKey={hasPrev ? "prevLeads" : undefined}
            color="var(--series-2)"
            format={(v) => formatNumber(v)}
          />
        </div>
      )}
    </div>
  );
}

function Panel({
  title,
  data,
  dataKey,
  prevKey,
  color,
  format,
}: {
  title: string;
  data: Array<Record<string, string | number | null>>;
  dataKey: string;
  prevKey?: string;
  color: string;
  format: (v: number) => string;
}) {
  const gradientId = `grad-${dataKey}`;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          {title}
        </div>
        {prevKey && (
          <div className="flex items-center gap-3 text-[10px]" style={{ color: "var(--text-muted)" }}>
            <span className="flex items-center gap-1">
              <span className="inline-block h-[2px] w-3.5 rounded-full" style={{ background: color }} />
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
      <div style={{ height: 132 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
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
                    className="rounded-[8px] px-2.5 py-1.5 text-xs shadow-lg"
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
                      <div className="tnum mt-0.5" style={{ color: "var(--text-muted)" }}>
                        prev {format(Number(prev))}
                      </div>
                    )}
                  </div>
                );
              }}
            />
            {/* Ghost first, so the current series draws on top of it. */}
            {prevKey && (
              <Area
                type="monotone"
                dataKey={prevKey}
                stroke="var(--text-muted)"
                strokeWidth={1.25}
                strokeDasharray="3 3"
                fill="none"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                connectNulls
              />
            )}
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{
                r: 4,
                fill: color,
                // 2px surface ring keeps the marker legible over the line.
                stroke: "var(--surface-1)",
                strokeWidth: 2,
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
