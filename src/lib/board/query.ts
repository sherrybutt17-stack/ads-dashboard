import type { BoardWidget, WidgetQuery } from "./types";

/**
 * A widget's question without its position — what the data API needs and the
 * editor's cache keys on.
 *
 * Pure and safe in the browser: the editor builds data-API URLs with it.
 */
export function widgetQueryOf(w: BoardWidget): WidgetQuery {
  switch (w.kind) {
    case "kpi":
      return { kind: "kpi", platform: w.platform, metric: w.metric };
    case "series":
      return { kind: "series", platform: w.platform, metric: w.metric, form: w.form, compare: w.compare };
    case "category":
      return {
        kind: "category",
        platform: w.platform,
        metric: w.metric,
        dimension: w.dimension,
        form: w.form,
        topN: w.topN,
      };
    case "table":
      return {
        kind: "table",
        platform: w.platform,
        dimension: w.dimension,
        metrics: [...w.metrics],
        sort: w.sort,
        topN: w.topN,
      };
    case "funnel":
      return { kind: "funnel", platform: w.platform };
    case "text":
      return { kind: "text", text: w.text, size: w.size };
    case "logo":
      return { kind: "logo" };
  }
}

/**
 * Stable identity for a query: same question, same key, whatever order its
 * fields were written in. The chart form is left out — switching a bar to a
 * donut reuses the data already fetched.
 */
export function widgetQueryKey(q: WidgetQuery): string {
  const copy: Record<string, unknown> = { ...q };
  if (q.kind === "category" || q.kind === "series") delete copy.form;
  return JSON.stringify(copy, Object.keys(copy).sort());
}

/** Longest encoded query the data API accepts. */
export const MAX_ENCODED_QUERY = 2048;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeWidgetQuery(q: WidgetQuery): string {
  return toBase64Url(JSON.stringify(q));
}

/**
 * The raw JSON of an encoded query, or null. Validation is the caller's job
 * (`WidgetQuerySchema`), so this stays dependency-free.
 */
export function decodeWidgetQuery(s: string | null | undefined): unknown {
  if (!s || s.length > MAX_ENCODED_QUERY) return null;
  const text = fromBase64Url(s);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
