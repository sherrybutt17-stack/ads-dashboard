import {
  DASH,
  formatCurrency,
  formatMultiple,
  formatNumber,
  formatPercent,
} from "@/lib/metrics/compute";
import type { MetricFormat } from "./catalog";

/**
 * One formatter for every board number, built on the dashboard's own so a
 * board cell and an Overview cell print the same figure the same way.
 *
 * Pure: chart components receive the format as data (`MetricFormat`) and call
 * this, rather than receiving a function from a server component.
 */
export function formatMetricValue(
  format: MetricFormat,
  v: number | null,
  currency = "USD",
  opts: { compact?: boolean } = {},
): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  switch (format) {
    case "currency":
      return formatCurrency(v, currency, opts);
    case "count":
      // Counts are whole, except Google's conversions, which Google itself
      // splits between ads — "3.75" must not be printed as "4".
      return Number.isInteger(v)
        ? formatNumber(v, opts)
        : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
    case "percent":
      // Two places below 10% (a 1.23% CTR), one above (a 34.5% book rate).
      return formatPercent(v, Math.abs(v) < 0.1 ? 2 : 1);
    case "decimal":
      return v.toFixed(2);
    case "multiple":
      return formatMultiple(v);
  }
}

/** StatTile's count-up formats; percent and decimal print as text. */
export function statTileFormat(
  format: MetricFormat,
): "currency" | "number" | "multiple" | undefined {
  return format === "currency"
    ? "currency"
    : format === "count"
      ? "number"
      : format === "multiple"
        ? "multiple"
        : undefined;
}
