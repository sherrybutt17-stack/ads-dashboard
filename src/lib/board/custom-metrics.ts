import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customMetrics, type CustomMetricRow } from "@/db/schema";
import { resolveWidgets } from "./schema";
import type { BoardWidget } from "./types";
import { isAdPlatform } from "@/lib/platforms";
import type { FormulaToken } from "@/lib/metrics/formula";
import { resultRows } from "@/lib/metrics/queries";
import { isMetricId, type MetricFormat } from "./catalog";
import type { CustomMetric, CustomMetricDraft } from "./registry";

/**
 * Storing an agency's own metrics (Settings → Metrics).
 *
 * Every function takes the agency id and scopes by it — a metric id from a
 * request is only ever looked up inside the caller's agency, so one agency can
 * never read, change or count another's metrics.
 *
 * Forgiving on read, like the board store: a missing table (0032 not yet
 * applied) or an unreadable row means "no metric", never an error page.
 */

const FORMATS: readonly MetricFormat[] = ["currency", "count", "percent", "decimal", "multiple"];
const POLARITIES = ["higher-better", "lower-better", "neutral"] as const;

/** A stored row as the registry reads it; null when the row no longer makes sense. */
export function toCustomMetric(r: CustomMetricRow): CustomMetric | null {
  const kind = r.kind === "rename" || r.kind === "formula" ? r.kind : null;
  const platform = r.platform === "any" || isAdPlatform(r.platform) ? r.platform : null;
  if (!kind || !platform) return null;
  return {
    id: r.id,
    kind,
    platform,
    baseMetric: r.baseMetric && isMetricId(r.baseMetric) ? r.baseMetric : null,
    // Shape-checked again by `parseFormula` wherever it is used.
    expression: Array.isArray(r.expression) ? (r.expression as FormulaToken[]) : null,
    label: r.label,
    description: r.description,
    format: FORMATS.includes(r.format as MetricFormat) ? (r.format as MetricFormat) : null,
    polarity: (POLARITIES as readonly string[]).includes(r.polarity ?? "")
      ? (r.polarity as CustomMetric["polarity"])
      : null,
    archived: r.archivedAt !== null,
  };
}

/** Every metric the agency has, archived ones included, by name. */
export async function listCustomMetrics(agencyId: string): Promise<CustomMetric[]> {
  try {
    const rows = await db
      .select()
      .from(customMetrics)
      .where(eq(customMetrics.agencyId, agencyId))
      .orderBy(asc(customMetrics.label));
    return rows.flatMap((r) => toCustomMetric(r) ?? []);
  } catch (err) {
    console.error("[custom-metrics] read failed:", err);
    return [];
  }
}

export async function getCustomMetric(agencyId: string, id: string): Promise<CustomMetric | null> {
  const [row] = await db
    .select()
    .from(customMetrics)
    .where(and(eq(customMetrics.agencyId, agencyId), eq(customMetrics.id, id)))
    .limit(1);
  return row ? toCustomMetric(row) : null;
}

export async function countCustomMetrics(agencyId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customMetrics)
    .where(eq(customMetrics.agencyId, agencyId));
  return Number(r?.n ?? 0);
}

/** What a draft stores: a rename keeps no formula, a formula no base. */
function columnsOf(d: CustomMetricDraft) {
  const rename = d.kind === "rename";
  return {
    label: d.label.trim(),
    description: d.description?.trim() || null,
    baseMetric: rename ? d.baseMetric : null,
    expression: rename ? null : d.expression,
    format: rename ? null : d.format,
    polarity: rename ? null : d.polarity,
  };
}

export async function createCustomMetric(
  agencyId: string,
  d: CustomMetricDraft,
  by: string | null,
): Promise<CustomMetric> {
  const [row] = await db
    .insert(customMetrics)
    .values({ agencyId, kind: d.kind, platform: d.platform, ...columnsOf(d), createdBy: by, updatedBy: by })
    .returning();
  const m = toCustomMetric(row);
  if (!m) throw new Error("A metric was stored that cannot be read back.");
  return m;
}

/**
 * Changes a metric's name, description and definition. Its kind and platform
 * never change: a widget built on a Meta rename must not wake up on TikTok.
 */
export async function updateCustomMetric(
  agencyId: string,
  id: string,
  d: CustomMetricDraft,
  by: string | null,
): Promise<CustomMetric | null> {
  const [row] = await db
    .update(customMetrics)
    .set({ ...columnsOf(d), updatedBy: by, updatedAt: new Date() })
    .where(and(eq(customMetrics.agencyId, agencyId), eq(customMetrics.id, id)))
    .returning();
  return row ? toCustomMetric(row) : null;
}

export async function setCustomMetricArchived(
  agencyId: string,
  id: string,
  archived: boolean,
  by: string | null,
): Promise<CustomMetric | null> {
  const [row] = await db
    .update(customMetrics)
    .set({ archivedAt: archived ? new Date() : null, updatedBy: by, updatedAt: new Date() })
    .where(and(eq(customMetrics.agencyId, agencyId), eq(customMetrics.id, id)))
    .returning();
  return row ? toCustomMetric(row) : null;
}

export async function deleteCustomMetric(agencyId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(customMetrics)
    .where(and(eq(customMetrics.agencyId, agencyId), eq(customMetrics.id, id)))
    .returning({ id: customMetrics.id });
  return rows.length > 0;
}

/**
 * How many of the agency's client boards show each metric — what the settings
 * table lists, and what decides between deleting a metric and archiving it.
 * Share links are not counted: each carries a frozen copy of the definitions
 * it was sent with, so deleting a metric never changes a link already sent.
 */
export async function customMetricUsage(agencyId: string): Promise<Map<string, number>> {
  const res = await db.execute(sql`
    SELECT m.id::text AS id,
           count(b.id) FILTER (WHERE strpos(b.widgets::text, 'custom:' || m.id::text) > 0)::int AS boards
    FROM custom_metrics m
    LEFT JOIN clients c ON c.agency_id = m.agency_id
    LEFT JOIN dashboard_boards b ON b.client_id = c.id
    WHERE m.agency_id = ${agencyId}
    GROUP BY m.id
  `);
  return new Map(resultRows<{ id: string; boards: number }>(res).map((r) => [r.id, Number(r.boards) || 0]));
}

/**
 * Every widget, on any of the agency's client boards, that shows the metric —
 * so an edit can say how many it leaves unable to draw as set up.
 */
export async function widgetsUsingMetric(agencyId: string, id: string): Promise<BoardWidget[]> {
  const res = await db.execute(sql`
    SELECT b.widgets, b.schema_version
    FROM dashboard_boards b
    JOIN clients c ON c.id = b.client_id
    WHERE c.agency_id = ${agencyId}
      AND strpos(b.widgets::text, ${`custom:${id}`}) > 0
  `);
  const ref = `custom:${id}`;
  return resultRows<{ widgets: unknown; schema_version: number }>(res).flatMap((r) =>
    resolveWidgets(r.widgets, Number(r.schema_version) || 1).widgets.filter((w) =>
      JSON.stringify(w).includes(ref),
    ),
  );
}
