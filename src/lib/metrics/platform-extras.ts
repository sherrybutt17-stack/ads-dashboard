/**
 * The extra figures each ad platform reports, beyond spend, impressions and
 * clicks — one list per platform, read by the sync that stores them, the
 * queries that sum them and the Board catalogue that shows them.
 *
 * ── Why one list ──────────────────────────────────────────────────────
 *
 * A figure is named three times: as the platform's field ("video_views_p25"),
 * as the key it is stored under in `raw`, and as the key a Board stat reads
 * (`x.video_p25`). Three hand-kept lists drift — a stat reading a key the sync
 * never writes shows a confident zero forever. Here each key is written once
 * and the other two places derive from it.
 *
 * Pure and dependency-free, so the catalogue (which runs in the browser) can
 * import it.
 */

/** A key a Board stat can read from `Bag.x`. Lower snake case, so it is safe as a SQL alias. */
export const EXTRA_KEY = /^[a-z][a-z0-9_]*$/;

/* ------------------------------------------------------------------ *
 * Meta — from the `actions` array every daily row already stores
 * ------------------------------------------------------------------ */

/**
 * Action families, summed per row. Meta reports one event under several
 * overlapping types — a website registration arrives as
 * `omni_complete_registration`, `complete_registration` AND
 * `offsite_conversion.fb_pixel_complete_registration` — so within a family the
 * FIRST type present on a row wins and the others are ignored. Adding them
 * would count one registration two or three times: the same trap as Meta's
 * lead types, and the rule `PURCHASE_PRECEDENCE` already follows.
 *
 * The broadest type comes first, as `metrics/results.ts` orders its aliases.
 */
export const META_ACTION_FAMILIES = {
  page_engagement: ["page_engagement"],
  photo_views: ["photo_view"],
  registrations: [
    "omni_complete_registration",
    "complete_registration",
    "offsite_conversion.fb_pixel_complete_registration",
  ],
  contacts: ["contact_total", "contact_website", "offsite_conversion.fb_pixel_contact"],
  schedules: ["schedule_total", "schedule_website", "offsite_conversion.fb_pixel_schedule"],
  applications: [
    "submit_application_total",
    "submit_application_website",
    "offsite_conversion.fb_pixel_submit_application",
  ],
  adds_to_cart: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"],
  checkouts: [
    "omni_initiated_checkout",
    "initiate_checkout",
    "offsite_conversion.fb_pixel_initiate_checkout",
  ],
  content_views: ["omni_view_content", "view_content", "offsite_conversion.fb_pixel_view_content"],
  calls_placed: ["click_to_call_native_call_placed", "call_confirm_grouped", "click_to_call_call_confirm"],
  messaging_conversations: ["onsite_conversion.messaging_conversation_started_7d"],
} as const satisfies Record<string, readonly string[]>;

export type MetaActionFamily = keyof typeof META_ACTION_FAMILIES;

/**
 * Columns only Meta's AD rows carry: the sync asks for outbound clicks and the
 * video quartiles below campaign level only. Stored typed, summed into `x`.
 */
export const META_AD_ROW_EXTRAS = {
  outbound_clicks: "outbound_clicks",
  video_p25: "video_p25",
  video_p50: "video_p50",
  video_p75: "video_p75",
  video_p95: "video_p95",
  video_p100: "video_p100",
} as const;

/* ------------------------------------------------------------------ *
 * Google — two best-effort GAQL queries, stored as `raw.xc` and `raw.xe`
 * ------------------------------------------------------------------ */

/**
 * Two families, two queries, so a field Google refuses (or retires — v25
 * renamed `video_views` to `video_trueview_views`) costs only its own family
 * and never spend. Each family is written whole or not at all, so a row either
 * has a family or was synced before it existed.
 *
 * key → the GAQL field and the camelCase key Google answers with.
 */
export const GOOGLE_EXTRA_FAMILIES = {
  xc: {
    all_conversions: { field: "metrics.all_conversions", json: "allConversions" },
    all_conversions_value: { field: "metrics.all_conversions_value", json: "allConversionsValue" },
    conversions_value: { field: "metrics.conversions_value", json: "conversionsValue" },
    view_through_conversions: { field: "metrics.view_through_conversions", json: "viewThroughConversions" },
  },
  xe: {
    interactions: { field: "metrics.interactions", json: "interactions" },
    engagements: { field: "metrics.engagements", json: "engagements" },
    video_views: { field: "metrics.video_trueview_views", json: "videoTrueviewViews" },
    phone_calls: { field: "metrics.phone_calls", json: "phoneCalls" },
  },
} as const;

export type GoogleExtraFamily = keyof typeof GOOGLE_EXTRA_FAMILIES;

/* ------------------------------------------------------------------ *
 * TikTok — one best-effort campaign report, stored as `raw.x`
 * ------------------------------------------------------------------ */

/** key → TikTok's report metric. Verified accepted together at campaign-day level, 24 Oct 2026. */
export const TIKTOK_EXTRAS = {
  likes: "likes",
  comments: "comments",
  shares: "shares",
  follows: "follows",
  profile_visits: "profile_visits",
  video_views: "video_play_actions",
  video_2s: "video_watched_2s",
  video_6s: "video_watched_6s",
  video_p25: "video_views_p25",
  video_p50: "video_views_p50",
  video_p75: "video_views_p75",
  video_p100: "video_views_p100",
} as const;

export type TiktokExtra = keyof typeof TIKTOK_EXTRAS;

/* ------------------------------------------------------------------ *
 * What each platform can fill
 * ------------------------------------------------------------------ */

/**
 * Columns Google and TikTok already store on every row, read into `x` beside
 * the extras: their own conversion count (TikTok's "Conversions"; Google's is
 * also its Results).
 */
export const SIMPLE_COLUMN_EXTRAS = ["conversions"] as const;

/** Every `x` key a platform's bags can carry — what a stat on that platform may read. */
export function extraKeysFor(platform: "meta" | "google" | "tiktok"): string[] {
  switch (platform) {
    case "meta":
      return [...Object.keys(META_ACTION_FAMILIES), ...Object.keys(META_AD_ROW_EXTRAS)];
    case "google":
      return [
        ...SIMPLE_COLUMN_EXTRAS,
        ...Object.values(GOOGLE_EXTRA_FAMILIES).flatMap((f) => Object.keys(f)),
      ];
    case "tiktok":
      return [...SIMPLE_COLUMN_EXTRAS, ...Object.keys(TIKTOK_EXTRAS)];
  }
}

/**
 * Round a stored figure to 6 places. Google splits conversions between ads
 * ("0.333333"), and a value below 1e-6 would serialise as "1e-7", which the
 * read side's plain-decimal guard reads as nothing.
 */
export function storedFigure(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0;
}
