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
 * Each panel carries ONE series, so no legend is needed — the panel title names
 * it. Grid and axes stay recessive; the data is the only thing with weight.
 */

interface Props {
  daily: DailyPoint[];
  currency: string;
}

export function TrendCharts({ daily, currency }: Props) {
  const data = daily.map((d) => ({
    date: d.dateKey,
    label: dayLabel(d.dateKey),
    spend: d.ads.spend,
    leads: d.funnel.new_lead,
    appts: d.funnel.appointment_booked,
  }));

  const hasAny = data.some((d) => d.spend > 0 || d.leads > 0);

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
            color="var(--series-1)"
            format={(v) => formatCurrency(v, currency)}
          />
          <Panel
            title="New leads"
            data={data}
            dataKey="leads"
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
  color,
  format,
}: {
  title: string;
  data: Array<Record<string, string | number>>;
  dataKey: string;
  color: string;
  format: (v: number) => string;
}) {
  const gradientId = `grad-${dataKey}`;
  return (
    <div>
      <div className="mb-1 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
        {title}
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
                      {format(Number(payload[0].value))}
                    </div>
                  </div>
                );
              }}
            />
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
