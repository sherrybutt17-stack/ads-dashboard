import type { AdPlatform } from "@/lib/platforms";
import type { FunnelStep } from "@/lib/metrics/compute";
import type { CreativeType, DeliveryRanking } from "@/db/schema";
import type {
  CardGrouping,
  CategoryForm,
  DimensionId,
  SeriesForm,
  StatId,
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
  | { kind: "kpi"; platform: AdPlatform; metric: StatId; resultType?: string }
  | {
      kind: "series";
      platform: AdPlatform;
      metric: StatId;
      form: SeriesForm;
      /** Draw the previous period as a dashed ghost. */
      compare: boolean;
      resultType?: string;
    }
  | {
      kind: "category";
      platform: AdPlatform;
      metric: StatId;
      dimension: DimensionId;
      form: CategoryForm;
      topN: number;
      resultType?: string;
    }
  | {
      kind: "table";
      platform: AdPlatform;
      dimension: TableDimension;
      metrics: StatId[];
      sort: StatId;
      topN: number;
      /**
       * For results columns: the result type to count (a key from
       * `metrics/results.ts`). Absent means the range's main type. Optional,
       * so every board saved before results existed still validates.
       */
      resultType?: string;
    }
  | {
      /** Ads as cards, like Whatagraph's "Creatives performance". Meta only. */
      kind: "creatives";
      platform: AdPlatform;
      /** One card per ad, or per creative (ads sharing an image or video, merged). */
      by: CardGrouping;
      /** The stats on each card, in order. */
      stats: StatId[];
      /** What the cards are ranked by — need not be one of `stats`. */
      sort: StatId;
      topN: number;
      /** Meta's delivery rankings under each card, as on the Overview. */
      rankings?: boolean;
      resultType?: string;
      /** Only these Meta campaign ids. Absent = every campaign. */
      campaigns?: string[];
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

/** One ad (or creative) on a creative-cards widget. Plain JSON, like everything here. */
export interface CreativeCardData {
  /** The ad id, or the creative key. */
  key: string;
  /** The ad's name — for a creative, its biggest-spending ad's. */
  name: string;
  /** The ad's headline; null when it would only repeat the name. */
  headline: string | null;
  body: string | null;
  type: CreativeType;
  videoSeconds: number | null;
  /**
   * `ref` — a thumbnail the page loads from the client's own thumb route;
   * `src` — a data URI, for documents read without a session. Null: none.
   */
  thumb: { ref: string } | { src: string } | null;
  /** Facebook's preview of the live ad (needs a Facebook login to open). */
  previewUrl: string | null;
  /** One per `stats`, in order. Null = no honest value. */
  values: Array<number | null>;
  /** "3 ads · 74% of spend", or the ad's campaign and its share. */
  context: string;
  /** The kind of result this card's results count, when a results stat shows. */
  resultLabel: string | null;
  rankings: Array<{ label: "Quality" | "Engagement" | "Conversion"; value: DeliveryRanking }>;
  /** Why no rankings show, when they were asked for and none qualify. */
  rankingNote: string | null;
  learning: "learning" | "limited" | null;
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
      /**
       * What the number counts, when the stat alone does not say: a results
       * tile's type, "Website leads". Shown beside the title.
       */
      unit?: string;
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
      columns: StatId[];
      rows: TableRow[];
      /** Re-derived from summed components, never averaged. */
      totals: Array<number | null>;
      /** Rows beyond the top N, folded into the totals. */
      more: number;
      currency: string;
      notes?: string[];
    }
  | {
      kind: "creatives";
      by: CardGrouping;
      stats: StatId[];
      cards: CreativeCardData[];
      /** Ads (or creatives) beyond the top N. */
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
