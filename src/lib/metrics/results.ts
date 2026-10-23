/**
 * The ad platforms' own "Results": what each Ads Manager counts as the outcome
 * of a campaign, and how to add them up without saying anything untrue.
 *
 * Pure — no I/O — so the Board's editor, the Overview and the tests share one
 * reading of every result type.
 *
 * ── 🔴 A result is only meaningful with its type ──────────────────────
 *
 * A "result" is whatever the campaign optimises for. For a lead campaign it is
 * a lead; for a traffic campaign it is a landing-page view; for an engagement
 * campaign it is a post engagement. Adding them together produces a number
 * that describes nothing — 13 leads plus 826 landing-page views is not 839 of
 * anything — so results are only ever summed within one type, exactly as Ads
 * Manager does (it shows "—" for a mixed total).
 *
 * Where a single headline is needed, it is the range's MAIN type: the additive
 * type that most money went to. "42 Website leads", with the rest named in a
 * footnote, rather than a sum across kinds.
 *
 * ── What each platform reports (verified on live accounts, 24 Oct 2026) ──
 *
 * Meta: `results` on each campaign-day and ad-day row, a list of
 *   `{ indicator, values: [{ value, attribution_windows }] }`. The indicator is
 *   present even on a day with no results (no `values`), so a day of spend
 *   always keeps its type.
 * TikTok: `result` — 0 at campaign level, correct at ad-group level, so the
 *   sync sums the ad-group report per campaign-day into `raw.results`. The type
 *   comes from the campaign's `objective_type`.
 * Google: the "Conversions" column, already stored per campaign-day. Google has
 *   no per-campaign result type, so it is one type, and fractional.
 */

/** Groups of result types, for wording and (later) for combining platforms. */
export type ResultFamily =
  | "lead"
  | "application"
  | "call"
  | "conversation"
  | "appointment"
  | "contact"
  | "purchase"
  | "signup"
  | "app_install"
  | "conversion"
  | "landing_page_view"
  | "link_click"
  | "video_view"
  | "engagement"
  | "follow"
  | "impression"
  | "reach"
  | "other";

export interface ResultType {
  /**
   * What results are grouped by: the normalised Meta indicator
   * ("offsite_conversion.fb_pixel_lead"), "tiktok:<OBJECTIVE>" or
   * "google:conversions". Two types are summed together only when their keys
   * are equal.
   */
  key: string;
  /** Plural, the way Ads Manager names the column: "Website leads". */
  label: string;
  family: ResultFamily;
  /**
   * False when a day's figures cannot be added across days — reach counts
   * people, and the same person reached on Monday and Tuesday is one person.
   */
  additive: boolean;
  /** Google reports fractional conversions (data-driven attribution). */
  decimals: 0 | 2;
}

/** One type's figures over some range. */
export interface TypedResults {
  type: ResultType;
  /** Every result of this type. */
  count: number;
  /**
   * Spend on the campaign-days whose ONLY result type is this one. A day that
   * optimised for two things cannot have its spend split honestly, so it is
   * left out of every type's cost (and named as `mixedSpend`).
   */
  spend: number;
  /**
   * Results on those same single-type days — the denominator that goes with
   * `spend`. Dividing single-type spend by ALL results would make a mixed day's
   * results look free and the cost per result too low.
   */
  pricedCount: number;
}

/* ------------------------------------------------------------------ *
 * Meta
 * ------------------------------------------------------------------ */

interface Known {
  label: string;
  family: ResultFamily;
  additive?: boolean;
}

/**
 * Meta action types that appear as result indicators, with Ads Manager's name.
 * Aliases (the `omni_` and grouped variants) map to the same key, so a
 * campaign that switched between them still adds up.
 */
const META_KNOWN: Record<string, Known & { key?: string }> = {
  "offsite_conversion.fb_pixel_lead": { label: "Website leads", family: "lead" },
  lead: { label: "Leads", family: "lead" },
  onsite_web_lead: { label: "Leads (website)", family: "lead" },
  "onsite_conversion.lead_grouped": { label: "On-Facebook leads", family: "lead" },
  leadgen_grouped: { label: "On-Facebook leads", family: "lead", key: "onsite_conversion.lead_grouped" },
  "leadgen.other": { label: "On-Facebook leads", family: "lead", key: "onsite_conversion.lead_grouped" },

  submit_application_website: { label: "Website applications submitted", family: "application" },
  submit_application_total: { label: "Applications submitted", family: "application" },
  "offsite_conversion.fb_pixel_submit_application": {
    label: "Website applications submitted",
    family: "application",
    key: "submit_application_website",
  },

  click_to_call_native_call_placed: { label: "Calls placed", family: "call" },
  click_to_call_call_confirm: { label: "Calls placed", family: "call", key: "click_to_call_native_call_placed" },
  call_confirm_grouped: { label: "Calls placed", family: "call", key: "click_to_call_native_call_placed" },

  "onsite_conversion.messaging_conversation_started_7d": {
    label: "Messaging conversations started",
    family: "conversation",
  },
  "onsite_conversion.total_messaging_connection": { label: "Messaging contacts", family: "conversation" },

  schedule_total: { label: "Appointments scheduled", family: "appointment" },
  schedule_website: { label: "Appointments scheduled", family: "appointment", key: "schedule_total" },
  "offsite_conversion.fb_pixel_schedule": {
    label: "Appointments scheduled",
    family: "appointment",
    key: "schedule_total",
  },

  contact_total: { label: "Contacts", family: "contact" },
  contact_website: { label: "Contacts", family: "contact", key: "contact_total" },
  "offsite_conversion.fb_pixel_contact": { label: "Contacts", family: "contact", key: "contact_total" },

  omni_purchase: { label: "Purchases", family: "purchase" },
  purchase: { label: "Purchases", family: "purchase", key: "omni_purchase" },
  "offsite_conversion.fb_pixel_purchase": { label: "Website purchases", family: "purchase" },

  omni_complete_registration: { label: "Registrations completed", family: "signup" },
  complete_registration: { label: "Registrations completed", family: "signup", key: "omni_complete_registration" },
  "offsite_conversion.fb_pixel_complete_registration": {
    label: "Registrations completed",
    family: "signup",
    key: "omni_complete_registration",
  },

  omni_app_install: { label: "App installs", family: "app_install" },
  mobile_app_install: { label: "App installs", family: "app_install", key: "omni_app_install" },
  app_install: { label: "App installs", family: "app_install", key: "omni_app_install" },

  omni_landing_page_view: { label: "Landing page views", family: "landing_page_view" },
  landing_page_view: { label: "Landing page views", family: "landing_page_view", key: "omni_landing_page_view" },
  link_click: { label: "Link clicks", family: "link_click" },

  video_view: { label: "3-second video plays", family: "video_view" },
  video_thruplay_watched: { label: "ThruPlays", family: "video_view" },
  thruplay: { label: "ThruPlays", family: "video_view", key: "video_thruplay_watched" },

  post_engagement: { label: "Post engagements", family: "engagement" },
  page_engagement: { label: "Page engagements", family: "engagement" },
  like: { label: "Page likes", family: "follow" },

  impressions: { label: "Impressions", family: "impression" },
  reach: { label: "Reach", family: "reach", additive: false },
  estimated_ad_recallers: { label: "Estimated ad recall lift (people)", family: "reach", additive: false },
};

/** "actions:offsite_conversion.fb_pixel_lead" → "offsite_conversion.fb_pixel_lead". */
function stripIndicator(indicator: string): string {
  return indicator.replace(/^(actions|conversions|unique_actions):/, "").trim();
}

/** "offsite_conversion.custom.123" → "Custom conversion"; anything else readable. */
function humanize(actionType: string): string {
  if (/^offsite_conversion\.custom\.\d+$/.test(actionType)) return "Custom conversions";
  if (actionType === "offsite_conversion.fb_pixel_custom") return "Custom events";
  const words = actionType
    .replace(/^(offsite_conversion|onsite_conversion|onsite_web|omni)[._]?/, "")
    .replace(/^fb_pixel_/, "")
    .replace(/[._]+/g, " ")
    .trim();
  if (!words) return "Results";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The result type for one Meta indicator. Never throws; unknown types stay readable. */
export function metaResultType(indicator: string): ResultType {
  const raw = stripIndicator(indicator);
  const known = META_KNOWN[raw];
  if (known) {
    return {
      key: known.key ?? raw,
      label: known.label,
      family: known.family,
      additive: known.additive ?? true,
      decimals: 0,
    };
  }
  return {
    key: raw || "results",
    label: humanize(raw),
    family: /^offsite_conversion\.custom\./.test(raw) ? "conversion" : "other",
    additive: true,
    decimals: 0,
  };
}

/** A string that is a plain decimal number, as Meta and TikTok send them. */
function numeric(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return 0;
}

/**
 * The results on one stored Meta row (`raw`), one entry per indicator.
 *
 * Tolerates anything: a missing or non-array `results`, entries without an
 * indicator, missing `values` (a zero day — the type survives, count 0), junk
 * numbers. Only the first value is read: we never request extra attribution
 * windows, so there is exactly one, under "default".
 */
export function metaResultsOf(raw: unknown): Array<{ indicator: string; count: number }> {
  const results = (raw as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: Array<{ indicator: string; count: number }> = [];
  for (const e of results) {
    const indicator = (e as { indicator?: unknown } | null)?.indicator;
    if (typeof indicator !== "string" || !indicator) continue;
    const values = (e as { values?: unknown }).values;
    const first = Array.isArray(values) ? (values[0] as { value?: unknown } | undefined) : undefined;
    out.push({ indicator, count: numeric(first?.value) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * TikTok and Google
 * ------------------------------------------------------------------ */

const TIKTOK_KNOWN: Record<string, Known> = {
  LEAD_GENERATION: { label: "Leads", family: "lead" },
  WEB_CONVERSIONS: { label: "Conversions", family: "conversion" },
  CONVERSIONS: { label: "Conversions", family: "conversion" },
  TRAFFIC: { label: "Clicks", family: "link_click" },
  VIDEO_VIEWS: { label: "Video views", family: "video_view" },
  ENGAGEMENT: { label: "Engagements", family: "engagement" },
  APP_PROMOTION: { label: "App installs", family: "app_install" },
  APP_INSTALL: { label: "App installs", family: "app_install" },
  PRODUCT_SALES: { label: "Purchases", family: "purchase" },
  SHOP_PURCHASES: { label: "Purchases", family: "purchase" },
  CATALOG_SALES: { label: "Purchases", family: "purchase" },
  REACH: { label: "Reach", family: "reach", additive: false },
  RF_REACH: { label: "Reach", family: "reach", additive: false },
};

/** The result type for a TikTok campaign objective. */
export function tiktokResultType(objective: string | null | undefined): ResultType {
  const o = (objective ?? "").trim().toUpperCase();
  const known = TIKTOK_KNOWN[o];
  return {
    key: `tiktok:${o || "UNKNOWN"}`,
    label: known?.label ?? "Results",
    family: known?.family ?? "other",
    additive: known?.additive ?? true,
    decimals: 0,
  };
}

/** Google's single result type: the "Conversions" column. */
export const GOOGLE_RESULT_TYPE: ResultType = {
  key: "google:conversions",
  label: "Conversions",
  family: "conversion",
  additive: true,
  decimals: 2,
};

/* ------------------------------------------------------------------ *
 * Adding up
 * ------------------------------------------------------------------ */

/** Merge entries that share a type key (aliases normalise to one key). */
export function mergeByType(entries: readonly TypedResults[]): TypedResults[] {
  const by = new Map<string, TypedResults>();
  for (const e of entries) {
    const prev = by.get(e.type.key);
    if (prev) {
      prev.count += e.count;
      prev.spend += e.spend;
      prev.pricedCount += e.pricedCount;
    } else {
      by.set(e.type.key, { type: e.type, count: e.count, spend: e.spend, pricedCount: e.pricedCount });
    }
  }
  return [...by.values()];
}

/** Cost per result for one type: its single-type spend ÷ the results on those days. */
export function costPerResult(e: Pick<TypedResults, "spend" | "pricedCount">): number | null {
  return e.pricedCount > 0 && e.spend > 0 ? e.spend / e.pricedCount : null;
}

/**
 * The headline type for a range: the ADDITIVE type most money went to; ties go
 * to the one with more results, then to the key, so the choice is stable.
 *
 * Non-additive types (reach) are never the main type: their daily figures
 * cannot be summed into the range total a tile would show.
 */
export function mainResultType(entries: readonly TypedResults[]): ResultType | null {
  const candidates = entries.filter((e) => e.type.additive && (e.spend > 0 || e.count > 0));
  if (candidates.length === 0) return null;
  const best = [...candidates].sort(
    (a, b) => b.spend - a.spend || b.count - a.count || a.type.key.localeCompare(b.type.key),
  )[0];
  return best.type;
}

export interface ResultsHeadline {
  /** The type shown — the pinned one if it has data, else the main type. */
  type: ResultType | null;
  count: number;
  /** Null when there is no single-type spend to divide (a mixed range only). */
  costPer: number | null;
  /** The other additive types in the range, most results first. */
  others: TypedResults[];
}

/**
 * What a tile shows: the main (or pinned) type, its count and cost per result,
 * and the other types for the footnote.
 *
 * `pinned` is a type key from a widget setting. A pinned type with nothing in
 * the range still shows — as zero — because "0 calls this week" is an answer.
 */
export function resultsHeadline(
  entries: readonly TypedResults[],
  opts: { pinned?: string | null; types?: ReadonlyMap<string, ResultType> } = {},
): ResultsHeadline {
  const merged = mergeByType(entries);
  const pinnedType = opts.pinned
    ? (merged.find((e) => e.type.key === opts.pinned)?.type ?? opts.types?.get(opts.pinned) ?? null)
    : null;
  const type = pinnedType ?? mainResultType(merged);
  if (!type) return { type: null, count: 0, costPer: null, others: [] };
  const mine = merged.find((e) => e.type.key === type.key);
  const count = mine?.count ?? 0;
  return {
    type,
    count,
    costPer: mine ? costPerResult(mine) : null,
    others: merged
      .filter((e) => e.type.key !== type.key && e.type.additive && e.count > 0)
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * The type a stored key names, for a pinned type with nothing in the range —
 * "0 calls placed" still needs to say "calls placed".
 */
export function resultTypeFromKey(platform: "meta" | "google" | "tiktok", key: string): ResultType {
  if (platform === "google") return GOOGLE_RESULT_TYPE;
  if (platform === "tiktok") return tiktokResultType(key.replace(/^tiktok:/, ""));
  return metaResultType(key);
}

/** A count in the type's own precision: "42", or "3.5" for Google. */
export function formatResultCount(n: number, type: Pick<ResultType, "decimals"> | null): string {
  const decimals = type?.decimals ?? 0;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/** "Also 12 messaging conversations started and 826 landing page views." */
export function othersFootnote(others: readonly TypedResults[], max = 2): string | null {
  if (others.length === 0) return null;
  const shown = others.slice(0, max).map(
    (o) => `${formatResultCount(o.count, o.type)} ${o.type.label.toLowerCase()}`,
  );
  const rest = others.length - shown.length;
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0];
  return `Also ${list}${rest > 0 ? ` (+${rest} more type${rest === 1 ? "" : "s"})` : ""}.`;
}

/* ------------------------------------------------------------------ *
 * The Overview's two tiles
 * ------------------------------------------------------------------ */

/** The parts of a stored results row the summary needs (see `getPlatformResults`). */
export interface ResultsRowLike {
  key: string;
  byType: readonly TypedResults[];
  rowsWithoutResults: number;
  mixedSpend: number;
}

export interface ResultsSummary {
  /** The main type for the range; null when nothing in it has a type. */
  type: ResultType | null;
  count: number;
  costPer: number | null;
  /** The SAME type over the previous period, so the change is like for like. */
  previousCount: number | null;
  previousCostPer: number | null;
  /** That type's daily count across the range, for the sparkline. */
  spark: number[];
  /** "Also 12 messaging conversations started." */
  othersNote: string | null;
  /** Days in range stored before results were collected. */
  notCollected: boolean;
  mixedSpend: number;
}

export const EMPTY_RESULTS_SUMMARY: ResultsSummary = Object.freeze({
  type: null,
  count: 0,
  costPer: null,
  previousCount: null,
  previousCostPer: null,
  spark: [],
  othersNote: null,
  notCollected: false,
  mixedSpend: 0,
}) as ResultsSummary;

/**
 * The Overview tiles' figures — the same main-type rule, the same functions and
 * the same rows as a Board results tile, so the two screens cannot disagree.
 */
export function summarizeResults(input: {
  current: ResultsRowLike | undefined;
  previous: ResultsRowLike | undefined;
  days: readonly ResultsRowLike[];
  dayKeys: readonly string[];
}): ResultsSummary {
  const cur = input.current;
  const head = resultsHeadline(cur?.byType ?? []);
  if (!head.type) {
    return {
      ...EMPTY_RESULTS_SUMMARY,
      notCollected: (cur?.rowsWithoutResults ?? 0) > 0,
      mixedSpend: cur?.mixedSpend ?? 0,
    };
  }
  const key = head.type.key;
  const prev = input.previous?.byType.find((t) => t.type.key === key);
  const byDay = new Map(input.days.map((d) => [d.key, d]));
  return {
    type: head.type,
    count: head.count,
    costPer: head.costPer,
    previousCount: input.previous ? (prev?.count ?? 0) : null,
    previousCostPer: prev ? costPerResult(prev) : null,
    spark: input.dayKeys.map(
      (k) => byDay.get(k)?.byType.find((t) => t.type.key === key)?.count ?? 0,
    ),
    othersNote: othersFootnote(head.others),
    notCollected: (cur?.rowsWithoutResults ?? 0) > 0,
    mixedSpend: cur?.mixedSpend ?? 0,
  };
}

/**
 * The kinds a widget may pin, per platform, for the builder's "Result type"
 * list. Additive kinds only — reach cannot be summed into a tile — and one
 * entry per key, under Ads Manager's name. Google has one kind, so none.
 */
export function resultTypeChoices(platform: "meta" | "google" | "tiktok"): Array<{ key: string; label: string }> {
  if (platform === "google") return [];
  const seen = new Map<string, string>();
  if (platform === "meta") {
    for (const indicator of Object.keys(META_KNOWN)) {
      const t = metaResultType(indicator);
      if (t.additive && !seen.has(t.key)) seen.set(t.key, t.label);
    }
  } else {
    for (const objective of Object.keys(TIKTOK_KNOWN)) {
      const t = tiktokResultType(objective);
      if (t.additive && !seen.has(t.key)) seen.set(t.key, t.label);
    }
  }
  return [...seen].map(([key, label]) => ({ key, label }));
}
