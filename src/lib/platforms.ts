/**
 * The ad platforms a dashboard view can be scoped to, and the one parser that
 * turns untrusted input into one.
 *
 * ── 🔴 Why the parser is shared ───────────────────────────────────────
 *
 * Five call sites — the dashboard, the report, meeting mode, the share-link
 * view and share-link creation — each wrote the same line by hand:
 *
 *     const platform = sp.platform === "google" ? "google" : "meta";
 *
 * Correct while there were two platforms. When TikTok was added it became a
 * silent mislabel in all five: `?platform=tiktok` fell through to `"meta"`, so
 * clicking the TikTok tab rendered Meta's spend, leads and cost per lead under
 * a TikTok heading. That is worse than an empty tab, because an empty tab
 * prompts a question and a plausible wrong number does not — someone would have
 * reported TikTok performance to a client from Facebook data.
 *
 * The fix is one function rather than five corrected ternaries, because the
 * next platform would reintroduce the bug in whichever site got missed. Adding
 * one here now updates every view at once.
 *
 * This module has no dependencies, so client components can import the labels
 * without pulling the query layer — the same rule `@/lib/stages` exists for.
 */

export const AD_PLATFORMS = ["meta", "google", "tiktok"] as const;

export type AdPlatform = (typeof AD_PLATFORMS)[number];

/**
 * Display names.
 *
 * Meta reads as "Facebook" in the platform toggle, where the audience is an
 * agency operator or a client who thinks of the product by that name, and as
 * "Meta" in metric labels, where it names the data source. Both spellings are
 * deliberate; callers pick.
 */
export const PLATFORM_LABEL: Record<AdPlatform, string> = {
  meta: "Meta",
  google: "Google",
  tiktok: "TikTok",
};

export function isAdPlatform(value: unknown): value is AdPlatform {
  return typeof value === "string" && (AD_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Anything → a platform, defaulting to Meta.
 *
 * The default is what makes this safe to point at a query string: an absent,
 * misspelled or hostile `?platform=` renders the Meta dashboard rather than
 * throwing. Only a value that IS a platform selects a different one, so the
 * mislabel above cannot recur — a new platform added to `AD_PLATFORMS` is
 * parsed by every caller the moment it exists.
 */
export function parseAdPlatform(value: unknown): AdPlatform {
  return isAdPlatform(value) ? value : "meta";
}
