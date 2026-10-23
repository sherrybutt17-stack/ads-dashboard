import type { AdPlatform } from "@/lib/platforms";
import type { FunnelStep } from "@/lib/metrics/compute";
import type {
  CategoryForm,
  DimensionId,
  MetricId,
  SeriesForm,
  TableDimension,
} from "./catalog";

/**
 * A widget's question: what to show, from which platform, in which form.
 *
 * Plain JSON on purpose. It is stored in jsonb, sent to the data API in a URL,
 * passed from server components to client ones (which may not receive
 * functions), and frozen into share links — so it can never hold anything but
 * data.
 */
export type WidgetQuery =
  | { kind: "kpi"; platform: AdPlatform; metric: MetricId }
  | {
      kind: "series";
      platform: AdPlatform;
      metric: MetricId;
      form: SeriesForm;
      /** Draw the previous period as a dashed ghost. */
      compare: boolean;
    }
  | {
      kind: "category";
      platform: AdPlatform;
      metric: MetricId;
      dimension: DimensionId;
      form: CategoryForm;
      topN: number;
    }
  | {
      kind: "table";
      platform: AdPlatform;
      dimension: TableDimension;
      metrics: MetricId[];
      sort: MetricId;
      topN: number;
    }
  | { kind: "funnel"; platform: AdPlatform }
  | { kind: "text"; text: string; size: "heading" | "body" }
  | { kind: "logo" };

/** Where a widget sits: grid units of a 12-column board. */
export interface WidgetBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BoardWidget = WidgetQuery &
  WidgetBox & {
    /** A custom heading; the catalogue's default title when absent. */
    title?: string;
  };

/* ------------------------------------------------------------------ *
 * What the aggregator hands each widget
 * ------------------------------------------------------------------ */

export interface CategoryRow {
  key: string;
  label: string;
  value: number | null;
  /** "Other" folds the tail; "not_reported" is the part Meta withholds. */
  tone?: "other" | "not_reported";
}

export interface SeriesPoint {
  key: string;
  label: string;
  value: number | null;
  /** The same day of the previous period, aligned by position. */
  prev: number | null;
}

export interface TableRow {
  key: string;
  label: string;
  /** A second line, e.g. the campaign an ad belongs to. */
  sub?: string;
  values: Array<number | null>;
}

export type WidgetData =
  | {
      kind: "value";
      value: number | null;
      previous: number | null;
      change: number | null;
      /** Daily values for the sparkline, when the stat has a daily form. */
      spark: number[] | null;
      currency: string;
      footnote?: string;
      notes?: string[];
    }
  | {
      kind: "series";
      points: SeriesPoint[];
      currency: string;
      /** "Previous period", or null when comparison is off. */
      prevLabel: string | null;
      notes?: string[];
    }
  | {
      kind: "categories";
      rows: CategoryRow[];
      /** The whole, when the parts add up to one. */
      total: number | null;
      currency: string;
      notes?: string[];
    }
  | {
      kind: "table";
      columns: MetricId[];
      rows: TableRow[];
      /** Re-derived from summed components, never averaged. */
      totals: Array<number | null>;
      /** Rows beyond the top N, folded into the totals. */
      more: number;
      currency: string;
      notes?: string[];
    }
  | {
      kind: "funnel";
      steps: FunnelStep[];
      exits: { no_show: number; lost: number };
      notes?: string[];
    }
  | { kind: "logo"; src: string | null; name: string }
  | { kind: "text" }
  /**
   * Not here yet. "reach": the exact range is not cached, and the widget asks
   * the data API itself. "load": the editor is fetching it (a widget just added
   * or changed) and will replace this when the answer lands.
   */
  | { kind: "pending"; reason: "reach" | "load" }
  | {
      kind: "unavailable";
      title: string;
      detail?: string;
      /** "empty" = nothing happened; "problem" = something is not connected or failed. */
      tone: "empty" | "problem";
    };

export type BoardData = Record<string, WidgetData>;
