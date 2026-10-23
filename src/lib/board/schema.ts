import { z } from "zod";
import { AD_PLATFORMS } from "@/lib/platforms";
import {
  CATEGORY_FORMS,
  DIMENSION_IDS,
  MAX_WIDGETS,
  METRIC_IDS,
  SERIES_FORMS,
  TABLE_COLUMNS,
  TABLE_ROWS,
  TEXT_MAX,
  TITLE_MAX,
  TOP_N,
  checkWidget,
} from "./catalog";
import { BOARD_COLS, normalizeLayout } from "./grid";
import { widgetQueryOf } from "./query";
import type { BoardWidget, WidgetQuery } from "./types";

/**
 * The shapes a board may be saved in, and the lenient reader for what is stored.
 *
 * Strict on write, forgiving on read — the same split as the section layout.
 * A request body is validated in full and refused if anything is off; a stored
 * row (written by an older deploy, or hand-edited) is read widget by widget, and
 * a widget that no longer makes sense is dropped rather than taking the whole
 * board down with it.
 */

export const BOARD_SCHEMA_VERSION = 1;
export { MAX_WIDGETS };
export const MAX_ROW = 400;

const Platform = z.enum(AD_PLATFORMS);
const Metric = z.enum(METRIC_IDS);
const Dimension = z.enum(DIMENSION_IDS);

/**
 * A pinned result type — a key from `metrics/results.ts` (an action type such as
 * "offsite_conversion.fb_pixel_lead", or "tiktok:LEAD_GENERATION"). Optional,
 * so every board saved before results existed still validates.
 */
const ResultType = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/).optional();

const kpiShape = { kind: z.literal("kpi"), platform: Platform, metric: Metric, resultType: ResultType };
const seriesShape = {
  kind: z.literal("series"),
  platform: Platform,
  metric: Metric,
  form: z.enum(SERIES_FORMS),
  compare: z.boolean(),
  resultType: ResultType,
};
const categoryShape = {
  kind: z.literal("category"),
  platform: Platform,
  metric: Metric,
  dimension: Dimension,
  form: z.enum(CATEGORY_FORMS),
  topN: z.number().int().min(TOP_N.min).max(TOP_N.max),
  resultType: ResultType,
};
const tableShape = {
  kind: z.literal("table"),
  platform: Platform,
  dimension: z.union([Dimension, z.literal("date")]),
  metrics: z.array(Metric).min(TABLE_COLUMNS.min).max(TABLE_COLUMNS.max),
  sort: Metric,
  topN: z.number().int().min(TABLE_ROWS.min).max(TABLE_ROWS.max),
  resultType: ResultType,
};
const funnelShape = { kind: z.literal("funnel"), platform: Platform };
const textShape = {
  kind: z.literal("text"),
  text: z.string().max(TEXT_MAX),
  size: z.enum(["heading", "body"]),
};
const logoShape = { kind: z.literal("logo") };

const boxShape = {
  id: z.string().regex(/^[A-Za-z0-9_-]{2,40}$/),
  x: z.number().int().min(0).max(BOARD_COLS - 1),
  y: z.number().int().min(0).max(MAX_ROW),
  w: z.number().int().min(1).max(BOARD_COLS),
  h: z.number().int().min(1).max(12),
  title: z.string().trim().max(TITLE_MAX).optional(),
};

/** One widget's question, as the data API receives it. */
export const WidgetQuerySchema = z
  .discriminatedUnion("kind", [
    z.object(kpiShape).strict(),
    z.object(seriesShape).strict(),
    z.object(categoryShape).strict(),
    z.object(tableShape).strict(),
    z.object(funnelShape).strict(),
    z.object(textShape).strict(),
    z.object(logoShape).strict(),
  ])
  .superRefine((q, ctx) => {
    const verdict = checkWidget(q as WidgetQuery);
    if (!verdict.ok) ctx.addIssue({ code: "custom", message: verdict.reason });
  });

/** One positioned widget, as a board stores it. */
export const BoardWidgetSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...kpiShape, ...boxShape }).strict(),
    z.object({ ...seriesShape, ...boxShape }).strict(),
    z.object({ ...categoryShape, ...boxShape }).strict(),
    z.object({ ...tableShape, ...boxShape }).strict(),
    z.object({ ...funnelShape, ...boxShape }).strict(),
    z.object({ ...textShape, ...boxShape }).strict(),
    z.object({ ...logoShape, ...boxShape }).strict(),
  ])
  .superRefine((w, ctx) => {
    const verdict = checkWidget(widgetQueryOf(w as BoardWidget));
    if (!verdict.ok) ctx.addIssue({ code: "custom", message: verdict.reason });
  });

const WidgetsSchema = z
  .array(BoardWidgetSchema)
  .max(MAX_WIDGETS)
  .superRefine((widgets, ctx) => {
    const seen = new Set<string>();
    for (const w of widgets) {
      if (seen.has(w.id)) {
        ctx.addIssue({ code: "custom", message: `Duplicate widget id ${w.id}` });
        return;
      }
      seen.add(w.id);
    }
  });

/**
 * What a client-role user may send. No `locked` — the lock is the agency's,
 * and a client payload that names it is refused rather than ignored, so a
 * crafted request fails loudly.
 */
export const ClientBoardWriteSchema = z
  .object({
    widgets: WidgetsSchema,
    ifUnmodifiedSince: z.string().datetime().optional(),
    expectNew: z.boolean().optional(),
  })
  .strict();

/** Staff may also lock or unlock, and may send a lock change alone. */
export const StaffBoardWriteSchema = z
  .object({
    widgets: WidgetsSchema.optional(),
    locked: z.boolean().optional(),
    ifUnmodifiedSince: z.string().datetime().optional(),
    expectNew: z.boolean().optional(),
  })
  .strict()
  .refine((d) => d.widgets !== undefined || d.locked !== undefined, {
    message: "Nothing to save.",
  });

export interface ResolvedWidgets {
  widgets: BoardWidget[];
  /** Widgets in the stored row that no longer validate. */
  dropped: number;
  /** Why the stored row could not be used at all. */
  problem: "newer_version" | "unreadable" | null;
}

/**
 * Read a stored widget list without ever throwing.
 *
 * A row written by a NEWER deploy is not guessed at — rendering a shape this
 * code has never seen could silently omit widgets — so the caller falls back to
 * the starter and says why.
 */
export function resolveWidgets(raw: unknown, schemaVersion: number): ResolvedWidgets {
  if (schemaVersion > BOARD_SCHEMA_VERSION) {
    return { widgets: [], dropped: 0, problem: "newer_version" };
  }
  if (!Array.isArray(raw)) return { widgets: [], dropped: 0, problem: "unreadable" };

  const out: BoardWidget[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of raw.slice(0, MAX_WIDGETS * 2)) {
    const parsed = BoardWidgetSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id) || out.length >= MAX_WIDGETS) {
      dropped++;
      continue;
    }
    seen.add(parsed.data.id);
    out.push(parsed.data as BoardWidget);
  }
  return { widgets: normalizeLayout(out), dropped, problem: null };
}
