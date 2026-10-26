import { PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";
import { widgetMetrics, type StatDef, type StatId, type StatLookup } from "./catalog";
import type { WidgetQuery } from "./types";

/**
 * Who counted a number: the ad platform itself, or the CRM.
 *
 * 🔴 The distinction a report most needs to make and least often does. "Leads"
 * can mean the leads Meta or TikTok counted against their own attribution —
 * what Ads Manager shows — or the leads that actually reached the client's
 * pipeline in GoHighLevel from that platform. The two differ by construction
 * (attribution windows, form spam, leads that never sync), and a tile that
 * says only "Leads · META" over a CRM count reads as Meta's number. So every
 * stat names its counter wherever it is chosen and wherever it is shown.
 *
 * A stat is the CRM's when it needs the CRM at all — "Cost per lead" divides
 * the platform's spend by CRM leads, so its leads are the CRM's.
 */
export type StatSource = "platform" | "crm";

/** The picker's "Counted by" filter. */
export type SourceFilter = "all" | StatSource;

export function statSource(def: Pick<StatDef, "needs">): StatSource {
  return def.needs.includes("crm") ? "crm" : "platform";
}

/** The counters behind a widget's numbers — none for text, a heading or a logo. */
export function widgetSources(q: WidgetQuery, stats: StatLookup): Set<StatSource> {
  if (q.kind === "funnel") return new Set(["crm"]);
  if (q.kind === "creatives") return new Set(["platform"]);
  const out = new Set<StatSource>();
  for (const m of widgetMetrics(q)) {
    const def = stats.get(m);
    if (def) out.add(statSource(def));
  }
  return out;
}

/** Whether a widget passes the picker's filter: "All", or any of its numbers counted by the one chosen. */
export function matchesSource(sources: ReadonlySet<StatSource>, filter: SourceFilter): boolean {
  return filter === "all" || sources.has(filter);
}

/**
 * The tag a widget carries: "CRM", "Meta", "Meta + CRM" — or, on a board of
 * one platform, nothing for the platform's own numbers.
 *
 * `showPlatform`: the board mixes platforms, so even the platform's own numbers
 * say whose they are. CRM numbers are always tagged: a CRM count left untagged
 * beside the platform's would read as the platform's.
 */
export function sourceTag(
  sources: ReadonlySet<StatSource>,
  platform: AdPlatform | null,
  showPlatform: boolean,
): string | null {
  const name = platform ? PLATFORM_LABEL[platform] : null;
  const crm = sources.has("crm");
  const own = sources.has("platform");
  if (crm && own) return name ? `${name} + CRM` : "CRM";
  if (crm) return showPlatform && name ? `CRM · ${name}` : "CRM";
  if (own && showPlatform && name) return name;
  return null;
}

/** A preset's badge in the picker: "Meta", "CRM", "Meta + CRM" — always named, unlike a tile's tag. */
export function sourceBadge(sources: ReadonlySet<StatSource>, platform: AdPlatform): string | null {
  const name = PLATFORM_LABEL[platform];
  if (sources.has("crm") && sources.has("platform")) return `${name} + CRM`;
  if (sources.has("crm")) return "CRM";
  return sources.has("platform") ? name : null;
}

/** A stat's name in the picker, with its counter, so the closed select still says whose it is. */
export function pickerLabel(label: string, source: StatSource, platform: AdPlatform): string {
  if (source === "crm") return `${label} · CRM`;
  // "Leads (Meta-reported)", "On-Facebook leads" already say whose they are.
  return /meta|facebook|google|tiktok/i.test(label) ? label : `${label} · ${PLATFORM_LABEL[platform]}`;
}

/** The picker's group heading with its counter: "CRM · Pipeline", "Meta · Conversions". */
export function pickerGroup(group: string, stats: readonly StatId[], lookup: StatLookup, platform: AdPlatform): string {
  const sources = new Set(stats.flatMap((m) => {
    const def = lookup.get(m);
    return def ? [statSource(def)] : [];
  }));
  if (sources.size !== 1) return group;
  if (sources.has("crm")) return `CRM · ${group.replace(/^CRM /, "").replace(/^\w/, (c) => c.toUpperCase())}`;
  return `${PLATFORM_LABEL[platform]} · ${group}`;
}

/**
 * One line under the chosen stat: who counted it, and what that means.
 *
 * The CRM's leads for a platform are the pipeline's leads that came from it —
 * by the same rule the dashboard uses (Meta's by the client's paid-lead filter,
 * Google's by click or campaign id, TikTok's by TikTok click or campaign id).
 */
export function sourceNote(source: StatSource, platform: AdPlatform): string {
  const name = PLATFORM_LABEL[platform];
  if (source === "crm") {
    return `Counted by your CRM (GoHighLevel): the leads in your pipeline that came from ${name}, by the same rule as the dashboard — not ${name}'s own count.`;
  }
  switch (platform) {
    case "meta":
      return "Counted by Meta itself, with its own attribution — the number Ads Manager shows. Not your CRM.";
    case "google":
      return "Counted by Google Ads itself — the number Google Ads shows. Not your CRM.";
    case "tiktok":
      return "Counted by TikTok itself — its Results, each ad group judged by its own goal. Not your CRM.";
  }
}

/** The filter's choices, with the platform named: All · Meta · CRM. */
export function sourceChoices(platform: AdPlatform): Array<{ value: SourceFilter; label: string; hint: string }> {
  const name = PLATFORM_LABEL[platform];
  return [
    { value: "all", label: "All", hint: `${name}'s numbers and your CRM's` },
    { value: "platform", label: name, hint: `Numbers ${name} counts itself — what its own Ads Manager shows` },
    { value: "crm", label: "CRM", hint: `Numbers from your CRM (GoHighLevel): leads and pipeline that came from ${name}` },
  ];
}
