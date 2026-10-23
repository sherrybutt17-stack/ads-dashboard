import { AD_PLATFORMS, type AdPlatform } from "@/lib/platforms";
import { METRICS, widgetMetrics } from "./catalog";
import { widgetQueryOf } from "./query";
import type { BoardWidget } from "./types";

/**
 * Every ad platform whose lead numbers appear on a board, in platform order.
 *
 * Each platform counts leads by its own rule — Meta by the paid-lead filter,
 * Google and TikTok by their own click and campaign ids — so a board, its
 * printed document and its share link have to say which rule each figure
 * used. One function, so the three say the same thing.
 */
export function leadPlatforms(widgets: readonly BoardWidget[]): AdPlatform[] {
  const used = new Set<AdPlatform>();
  for (const w of widgets) {
    const q = widgetQueryOf(w);
    if (!("platform" in q)) continue;
    if (widgetMetrics(q).some((m) => METRICS[m].needs.includes("crm"))) used.add(q.platform);
  }
  return AD_PLATFORMS.filter((p) => used.has(p));
}
