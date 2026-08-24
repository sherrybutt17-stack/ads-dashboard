import type { GhlAttributionSource } from "./types";

/**
 * Which ad platform sent this lead, and which platform's column its ids belong
 * in.
 *
 * ---
 *
 * WHAT THE PRODUCTION DATA ACTUALLY CONTAINS (measured over every contact
 * carrying attribution, not assumed):
 *
 * - `attributionSource.campaignId` is **never populated** — 0 of 191 rows. The
 *   original design read the Meta campaign id from this field. It has never
 *   held one.
 * - `attributionSource.adId` and `.adGroupId` are **null in every row** — 0 of
 *   76. This settles the open question flagged as the build's highest-value
 *   unknown: appending `ad_id=` / `ad_group_id=` to the ad URL does NOT populate
 *   them. GHL's parser does not expose those names as fields.
 * - The ids DO arrive — inside the landing `url`, as ordinary query parameters:
 *   `utm_id=120241413092450750` is the campaign id, and `utm_term` /
 *   `utmKeyword` carries the adset id. `utm_content` carries the ad's NAME, not
 *   its id.
 * - `utm_source` observed as `fb`, `ig` and `th` — Threads, which any
 *   facebook/instagram-only token list silently drops.
 *
 * So the campaign ids that currently work were not read from attribution at all:
 * a one-off import script joined leads to campaigns **by campaign name**, the
 * exact fragile join that breaks the moment anyone renames a campaign.
 *
 * This module reads the ids from where they really are — the URL — and assigns
 * them to a platform. `unknown` is a first-class answer: when nothing
 * identifies a platform, NEITHER id is written and the lead reports as
 * "Unattributed", because the previous behaviour (write it to Meta regardless)
 * meant a Google lead counted toward the Facebook tab.
 */
export type LeadPlatform = "meta" | "google" | "tiktok" | "unknown";

/**
 * Source tokens per platform, matched exactly against lowercased values.
 *
 * Exact rather than substring: "google" as a substring also matches
 * `googleusercontent.com`, and a loose "fb" would claim anything containing
 * those two letters. `th`/`threads` are here because Threads is Meta inventory
 * and appears in this account's live data.
 */
const META_TOKENS = new Set([
  "facebook", "facebook.com", "www.facebook.com", "m.facebook.com",
  "l.facebook.com", "lm.facebook.com", "business.facebook.com",
  "fb", "fb.me", "ig", "instagram", "instagram.com", "www.instagram.com",
  "l.instagram.com", "th", "threads", "threads.net", "www.threads.net",
  "meta", "messenger", "audiencenetwork", "an", "paid social", "paid_social",
]);

/*
 * 🔴 `tt` is deliberately ABSENT.
 *
 * It is TikTok's own abbreviation and it is also two letters that appear as a
 * source value for plenty of other things. `th` is in the Meta set above only
 * because Threads was observed in this account's live data; adding `tt` on the
 * same reasoning would be a guess, and a wrong platform verdict moves a lead's
 * campaign id into the wrong column where nothing downstream can find it.
 */
const TIKTOK_TOKENS = new Set([
  "tiktok", "tiktok.com", "www.tiktok.com", "m.tiktok.com",
  "ads.tiktok.com", "tiktokads", "tiktok-ads", "tiktok_ads",
  "bytedance", "pangle",
]);

const GOOGLE_TOKENS = new Set([
  "google", "google.com", "www.google.com", "adwords", "googleads",
  "google-ads", "google_ads", "gads", "googleadservices.com",
  "www.googleadservices.com", "doubleclick", "doubleclick.net",
  // Google Ads serves video and demand-gen inventory on YouTube.
  "youtube", "youtube.com", "www.youtube.com", "m.youtube.com",
]);

function norm(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

const lower = (v: unknown): string | null => norm(v)?.toLowerCase() ?? null;

/**
 * A platform object id, or null.
 *
 * Meta ids run ~17–18 digits, Google's ~9–11. Requiring 8+ consecutive digits
 * is what makes it safe to read an id out of `utm_term`, whose conventional
 * contents are a keyword — no keyword is eight digits long.
 */
function asId(v: unknown): string | null {
  const s = norm(v);
  return s && /^\d{8,}$/.test(s) ? s : null;
}

/** Query parameters of the landing URL, where the real ids live. */
function paramsOf(url: unknown): URLSearchParams | null {
  const s = norm(url);
  if (!s) return null;
  try {
    return new URL(s).searchParams;
  } catch {
    const q = s.indexOf("?");
    return q >= 0 ? new URLSearchParams(s.slice(q + 1)) : null;
  }
}

/** Host of a URL-ish string, or the raw token if it will not parse. */
function hostOf(v: unknown): string | null {
  const s = lower(v);
  if (!s) return null;
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    return s;
  }
}

/**
 * Identify the platform from one attribution source, most trustworthy signal
 * first.
 *
 * 1. **Click ids.** `fbclid`, and `gclid`/`gbraid`/`wbraid` — stamped by the
 *    platform on the outbound click itself. They survive a UTM setup nobody
 *    configured. (`gbraid`/`wbraid` are Google's iOS-privacy variants and appear
 *    in GHL's payload shape alongside `gclid`.)
 * 2. **Declared source** — `utm_source`, set by whoever built the ad URL.
 * 3. **Observed source** — session source, then referrer host. Last, because an
 *    organic Facebook share also refers from facebook.com. That is acceptable
 *    here: this only decides which column an id goes in, and a lead with no id
 *    writes nothing either way.
 */
export function detectLeadPlatform(
  attr: GhlAttributionSource | null | undefined,
): LeadPlatform {
  if (!attr) return "unknown";

  const fb = norm(attr.fbclid);
  const g =
    norm(attr.gclid) ??
    norm((attr as Record<string, unknown>).gbraid) ??
    norm((attr as Record<string, unknown>).wbraid);
  const tt = norm((attr as Record<string, unknown>).ttclid);

  /*
   * A click id is decisive only when it is the ONLY one present. Two click ids
   * on one contact means the person arrived twice by different routes, and
   * picking either would assign their whole pipeline value to one platform's
   * spend. Falling through to the source tokens is not better evidence, but it
   * is evidence about THIS visit rather than a coin toss.
   */
  const present = [fb && "meta", g && "google", tt && "tiktok"].filter(
    Boolean,
  ) as LeadPlatform[];
  if (present.length === 1) return present[0];

  for (const candidate of [attr.utmSource, attr.sessionSource, attr.medium]) {
    const t = lower(candidate);
    if (!t) continue;
    if (META_TOKENS.has(t)) return "meta";
    if (GOOGLE_TOKENS.has(t)) return "google";
    if (TIKTOK_TOKENS.has(t)) return "tiktok";
  }

  const host = hostOf(attr.referrer) ?? hostOf(attr.url);
  if (host) {
    if (META_TOKENS.has(host)) return "meta";
    if (GOOGLE_TOKENS.has(host)) return "google";
    if (TIKTOK_TOKENS.has(host)) return "tiktok";
  }

  return "unknown";
}

export interface ParsedAttribution {
  platform: LeadPlatform;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  metaCampaignId: string | null;
  metaAdsetId: string | null;
  metaAdId: string | null;
  fbclid: string | null;
  gclid: string | null;
  googleCampaignId: string | null;
  /** TikTok Click ID — the TikTok analog of `fbclid` and `gclid`. */
  ttclid: string | null;
  /** TikTok numeric campaign id, when derivable from UTMs on the ad URL. */
  tiktokCampaignId: string | null;
  /**
   * A campaign id we found but could not assign to a platform.
   *
   * Kept because "attribution exists but is unclassified" is a setup problem
   * worth surfacing, and is a different thing from "no attribution at all".
   */
  unresolvedCampaignId: string | null;
  /**
   * Meta leadgen id, for a native Instant Form submission.
   *
   * 🔴 The ONLY attribution a Lead Ad carries. Those forms open inside Facebook
   * with no landing page, so there is no URL and none of the parameter-reading
   * above can find anything — every such lead is unattributed no matter how
   * carefully the ads are tagged. This id is what `meta/leadgen.ts` trades back
   * to Meta for the ad, ad set and campaign.
   *
   * Stored on its own rather than resolved here: resolving costs an API call
   * per lead and needs a scope this app may not hold, neither of which belongs
   * on the webhook path.
   */
  facebookLeadId: string | null;
}

/**
 * GHL stores attribution in two shapes depending on which path wrote the row:
 * the webhook path nests it under `attributionSource` / `lastAttributionSource`,
 * the bulk import stored the source object flat. Normalise both so a backfill
 * and the live path read identically.
 */
export function normalizeRawAttribution(raw: unknown): {
  attributionSource?: GhlAttributionSource;
  lastAttributionSource?: GhlAttributionSource;
} {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  if (o.attributionSource || o.lastAttributionSource) {
    return {
      attributionSource: (o.attributionSource ?? undefined) as GhlAttributionSource,
      lastAttributionSource: (o.lastAttributionSource ??
        undefined) as GhlAttributionSource,
    };
  }
  return { attributionSource: o as GhlAttributionSource };
}

/**
 * Merge first-touch and last-touch attribution into one parsed record.
 *
 * First touch wins, last touch fills gaps: `lastAttributionSource` is
 * overwritten on every qualifying visit, and cost-per-lead wants the touch that
 * CREATED the lead. The platform verdict follows the same rule — otherwise a
 * lead who arrived from Google and later returned through a Facebook
 * retargeting ad would have its acquisition charged to Meta.
 */
export function parseAttribution(contact: {
  attributionSource?: GhlAttributionSource;
  lastAttributionSource?: GhlAttributionSource;
}): ParsedAttribution {
  const first = contact.attributionSource ?? {};
  const last = contact.lastAttributionSource ?? {};

  const pick = (k: keyof GhlAttributionSource): string | null =>
    norm(first[k]) ?? norm(last[k]);

  const firstPlatform = detectLeadPlatform(first);
  const platform =
    firstPlatform !== "unknown" ? firstPlatform : detectLeadPlatform(last);

  // The landing URL, which is where the ids actually are.
  const p = paramsOf(first.url) ?? paramsOf(last.url);
  const q = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = asId(p?.get(k));
      if (v) return v;
    }
    return null;
  };

  const utmTerm = pick("utmTerm") ?? pick("utmKeyword" as keyof GhlAttributionSource);
  const utmContent = pick("utmContent");

  /*
   * Campaign id, in order of directness:
   *   utm_id            — what this account actually uses
   *   campaign_id       — the parameter name the original setup guide suggested
   *   campaignid        — Google ValueTrack's {campaignid}
   *   .campaignId       — the field the old code trusted; empty in practice
   */
  const campaignId =
    q("utm_id", "campaign_id", "campaignid") ?? asId(pick("campaignId"));

  /*
   * Ad set / ad group. `utm_term` is the fallback because that is where this
   * account's adset id lands; `asId` keeps a genuine keyword from being mistaken
   * for one.
   */
  const adsetId =
    q("ad_group_id", "adset_id", "adgroupid", "adsetid") ??
    asId(pick("adGroupId")) ??
    asId(utmTerm);

  /*
   * Ad / creative. Note: this account's `utm_content` holds the ad NAME, not an
   * id, so `asId` correctly declines it and ad-level attribution stays null
   * rather than storing a name in an id column.
   */
  const adId =
    q("ad_id", "adid", "creative") ?? asId(pick("adId")) ?? asId(utmContent);

  /*
   * Leadgen id. Several carriers are checked because which one arrives has NOT
   * been verified against live data — no Instant Form lead has come through
   * this pipe yet, so every name here is from GHL's merge-field documentation
   * rather than from an observed payload. Listed most-documented first.
   *
   * This is cheap to be generous about: `asId` refuses anything that is not a
   * long number, so a wrong guess reads null rather than storing a form answer
   * in an id column.
   */
  const facebookLeadId =
    asId(pick("facebookLeadId" as keyof GhlAttributionSource)) ??
    asId(pick("fbLeadId" as keyof GhlAttributionSource)) ??
    asId(pick("leadId" as keyof GhlAttributionSource)) ??
    q("lead_id", "leadgen_id");

  return {
    platform,
    utmSource: pick("utmSource"),
    utmMedium: pick("utmMedium") ?? pick("medium"),
    utmCampaign: pick("utmCampaign") ?? pick("campaign"),
    utmContent,
    utmTerm,

    // Each id goes to exactly one platform's column, or to none at all.
    metaCampaignId: platform === "meta" ? campaignId : null,
    metaAdsetId: platform === "meta" ? adsetId : null,
    metaAdId: platform === "meta" ? adId : null,
    googleCampaignId: platform === "google" ? campaignId : null,
    tiktokCampaignId: platform === "tiktok" ? campaignId : null,
    unresolvedCampaignId: platform === "unknown" ? campaignId : null,

    /*
     * Not gated on the platform verdict, unlike the ids above. A leadgen id is
     * a Meta object by definition — nothing else issues them — and a native
     * Lead Ad has no URL, so the verdict it would be gated on is derived from
     * evidence that does not exist for exactly these leads.
     */
    facebookLeadId,

    // Click ids identify themselves, so they are stored whatever the verdict.
    fbclid: pick("fbclid"),
    gclid:
      pick("gclid") ??
      pick("gbraid" as keyof GhlAttributionSource) ??
      pick("wbraid" as keyof GhlAttributionSource),
    ttclid: pick("ttclid" as keyof GhlAttributionSource) ?? q("ttclid"),
  };
}
