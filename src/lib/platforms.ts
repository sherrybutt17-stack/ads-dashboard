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
 * ── 🔴 Why the dashboard pages do not default to Meta ──────────────────
 *
 * `parseAdPlatform` falls back to Meta, which was right while every client ran
 * Meta. It stopped being right for a client that runs TikTok alone: the
 * Overview, the report and meeting mode all opened on Meta's "not connected"
 * view, with the client's only live data behind a toggle — and the owner read
 * it as the dashboard not showing TikTok at all.
 *
 * So the three pages a person opens without choosing a platform resolve it with
 * `resolveAdPlatform`, which falls back to the first platform the CLIENT has.
 * `parseAdPlatform` stays for values that were chosen explicitly — a stored
 * share link, an API call that always sends one — where Meta is only ever the
 * answer to junk.
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
 *
 * For a page someone opens without naming a platform, use `resolveAdPlatform`
 * — see the note at the top of this module.
 */
export function parseAdPlatform(value: unknown): AdPlatform {
  return isAdPlatform(value) ? value : "meta";
}

/** Which platforms a client has at least one live account on. */
export type ConnectedPlatforms = Readonly<Record<AdPlatform, boolean>>;

/**
 * The platform a client's dashboard opens on when the URL names none: the
 * first one it has an account on, in `AD_PLATFORMS` order.
 *
 * Meta when it has none. That is not a guess at what they will connect — it is
 * the view whose empty state says "Meta isn't connected" and offers to connect
 * it, which is the honest thing to show a client with nothing wired.
 *
 * Meta comes first in the order, so a client that has Meta opens on it exactly
 * as before; only a client WITHOUT Meta opens somewhere new.
 */
export function defaultAdPlatform(connected: ConnectedPlatforms): AdPlatform {
  return AD_PLATFORMS.find((p) => connected[p]) ?? "meta";
}

/**
 * Untrusted input → a platform, defaulting to the client's own.
 *
 * 🔴 An explicit `?platform=` always wins — even one naming a platform the
 * client has no account on. Every link this app prints for a view other than
 * Meta-on-a-Meta-client names its platform (`linkCarriesPlatform`), and a kept
 * link must keep opening that view rather than whichever platform the client
 * happens to lead with today. Only an absent or unrecognised value falls
 * through to `defaultAdPlatform`.
 */
export function resolveAdPlatform(value: unknown, connected: ConnectedPlatforms): AdPlatform {
  return isAdPlatform(value) ? value : defaultAdPlatform(connected);
}

/**
 * Whether a link to a view of `platform` must carry `?platform=`, for a client
 * whose pages open on `opensOn`.
 *
 * 🔴 Only Meta, on a client that opens on Meta, goes without. That is the one
 * case every link printed before the default followed the client already left
 * bare, so for a client with Meta nothing about its URLs changes.
 *
 * Every other view says so — including the client's own default when that is
 * not Meta, where leaving it off would look harmless today. A report link is
 * made to be kept, and a kept bare link to a TikTok-only client's report would
 * quietly open Meta the month Meta is connected. Naming the platform is what
 * keeps a link meaning what it meant when it was printed.
 */
export function linkCarriesPlatform(platform: AdPlatform, opensOn: AdPlatform): boolean {
  return platform !== "meta" || opensOn !== "meta";
}

/**
 * The platforms a view offers to switch between.
 *
 * Every platform with an account behind it, plus two that may have none:
 *
 * - the one on screen. A link to `?platform=google` on a client without Google
 *   renders Google's empty view, and a toggle that left Google out would have
 *   no button lit and no way back to it.
 * - the one the client opens on. That only adds anything when nothing is
 *   connected — it is then Meta, whose empty state is the setup prompt.
 *
 * So a client running TikTok alone gets TikTok and nothing else: a Facebook
 * button that can only ever show "not connected" is a dead end that reads like
 * a broken pipe, which is what it looked like to the owner who reported it.
 */
export function offeredAdPlatforms(viewing: AdPlatform, connected: ConnectedPlatforms): AdPlatform[] {
  const home = defaultAdPlatform(connected);
  return AD_PLATFORMS.filter((p) => connected[p] || p === viewing || p === home);
}

/**
 * When a client's ad figures last synced, across every platform it has: the
 * newest of the per-platform times.
 *
 * 🔴 Meta's time is `clients.last_synced_at`, and it counts only while Meta has
 * an account. Google and TikTok stamp their own account rows and never touch
 * the client row, so reading that column alone dated a TikTok-only client
 * "Not synced yet" over a sync that ran an hour ago. And the column outlives a
 * removed Meta account, so without `metaConnected` a Meta sync from the day the
 * account was detached would vouch for a TikTok pipe that has since stopped.
 *
 * The newest rather than the oldest: one line for several pipes can only say
 * when the client's figures last moved. Whether each pipe is keeping up is the
 * health checklist's question — it has a freshness row per platform.
 */
export function newestAdSync(input: {
  metaConnected: boolean;
  /** `clients.last_synced_at` — written by the Meta sync alone. */
  metaSyncedAt: Date | null;
  /** Every Google and TikTok account's own `last_synced_at`. */
  accountSyncs: Iterable<Date | null>;
}): Date | null {
  let newest = input.metaConnected ? input.metaSyncedAt : null;
  for (const at of input.accountSyncs) {
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}
