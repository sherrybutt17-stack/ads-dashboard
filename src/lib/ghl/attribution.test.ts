import { describe, it, expect } from "vitest";
import {
  detectLeadPlatform,
  parseAttribution,
  normalizeRawAttribution,
} from "./attribution";

/**
 * Fixtures lifted from the live database, not invented.
 *
 * The account's UTM setup puts the campaign id in `utm_id`, the adset id in
 * `utm_term`, and the ad's NAME (not id) in `utm_content` — while
 * `attributionSource.campaignId`, `.adId` and `.adGroupId`, which the original
 * parser read, are null on every row.
 */
const META_FB = {
  url: "https://retainer.growthguild.us/ghloffer?utm_source=fb&utm_medium=Others&utm_campaign=Leads+|+GG+|+14,+Jan,+2026&utm_content=New+Reel+2&fbclid=IwcGRvZ&utm_id=120241413092450750&utm_term=120241413092470750",
  fbclid: "IwcGRvZ",
  gclid: null,
  adId: null,
  adGroupId: null,
  campaignId: undefined,
  medium: "calendar",
  utmMedium: "Others",
  utmSource: "fb",
  utmTerm: "120241413092470750",
  utmContent: "New Reel 2",
  campaign: "Leads | Gg | 14, Jan, 2026",
  referrer: "http://m.facebook.com",
  sessionSource: "Social media",
};

/** Threads. Meta inventory, and `th` is what GHL records as the source. */
const META_THREADS = {
  ...META_FB,
  utmSource: "th",
  utmMedium: "Threads_Feed",
  referrer: undefined,
};

/** A manually created CRM contact — no ad involvement at all. */
const MANUAL = {
  sessionSource: "CRM UI",
  medium: "manual",
};

describe("detectLeadPlatform", () => {
  it("trusts a click id over everything else", () => {
    expect(detectLeadPlatform({ fbclid: "abc" })).toBe("meta");
    expect(detectLeadPlatform({ gclid: "xyz" })).toBe("google");
  });

  it("recognises Google's iOS-privacy click ids", () => {
    // gbraid/wbraid replace gclid when Apple's restrictions apply; without
    // these, a large share of Google's iOS traffic reads as unattributed.
    expect(detectLeadPlatform({ gbraid: "g1" })).toBe("google");
    expect(detectLeadPlatform({ wbraid: "w1" })).toBe("google");
  });

  it("recognises Threads as Meta", () => {
    // Live data: `utm_source=th`. A facebook/instagram-only list drops it.
    expect(detectLeadPlatform(META_THREADS)).toBe("meta");
  });

  it("falls back to the referrer host when nothing is declared", () => {
    expect(detectLeadPlatform({ referrer: "http://m.facebook.com" })).toBe("meta");
    expect(detectLeadPlatform({ referrer: "https://www.youtube.com/watch" })).toBe(
      "google",
    );
  });

  it("does not claim a lead on a substring collision", () => {
    // "googleusercontent.com" is not Google Ads.
    expect(detectLeadPlatform({ utmSource: "googleusercontent.com" })).toBe(
      "unknown",
    );
    expect(detectLeadPlatform({ utmSource: "fbi" })).toBe("unknown");
  });

  it("declines to guess when both click ids are present", () => {
    expect(detectLeadPlatform({ fbclid: "a", gclid: "b" })).toBe("unknown");
  });

  it("returns unknown for a manually created contact", () => {
    expect(detectLeadPlatform(MANUAL)).toBe("unknown");
  });
});

describe("parseAttribution", () => {
  it("reads the campaign id from utm_id, where it actually is", () => {
    const p = parseAttribution({ attributionSource: META_FB });
    expect(p.platform).toBe("meta");
    expect(p.metaCampaignId).toBe("120241413092450750");
  });

  it("reads the adset id from utm_term", () => {
    // 86 live leads gain adset-level attribution from this alone; the old
    // parser read `.adGroupId`, which is null on every row in production.
    const p = parseAttribution({ attributionSource: META_FB });
    expect(p.metaAdsetId).toBe("120241413092470750");
  });

  it("refuses to store an ad NAME in the ad id column", () => {
    // utm_content is "New Reel 2". Storing that as an id would look like
    // ad-level attribution while joining to nothing.
    const p = parseAttribution({ attributionSource: META_FB });
    expect(p.metaAdId).toBeNull();
    expect(p.utmContent).toBe("New Reel 2");
  });

  it("does not mistake a real keyword in utm_term for an id", () => {
    const p = parseAttribution({
      attributionSource: { ...META_FB, utmTerm: "botox near me", url: undefined },
    });
    expect(p.metaAdsetId).toBeNull();
    expect(p.utmTerm).toBe("botox near me");
  });

  /** The defect: a Google lead's campaign id used to land in the Meta column. */
  it("never writes a Google campaign id into the Meta column", () => {
    const p = parseAttribution({
      attributionSource: {
        url: "https://x.test/?utm_source=google&campaignid=1234567890&adgroupid=9876543210",
        gclid: "Cj0KC",
      },
    });
    expect(p.platform).toBe("google");
    expect(p.googleCampaignId).toBe("1234567890");
    expect(p.metaCampaignId).toBeNull();
    expect(p.metaAdsetId).toBeNull();
    expect(p.gclid).toBe("Cj0KC");
  });

  it("writes neither id when the platform cannot be identified", () => {
    const p = parseAttribution({
      attributionSource: { url: "https://x.test/?utm_id=1234567890" },
    });
    expect(p.platform).toBe("unknown");
    expect(p.metaCampaignId).toBeNull();
    expect(p.googleCampaignId).toBeNull();
    // ...but the id is not thrown away: attribution exists, unclassified.
    expect(p.unresolvedCampaignId).toBe("1234567890");
  });

  it("prefers FIRST touch for the platform verdict", () => {
    // Arrived from Google, returned via a Facebook retargeting ad. The
    // acquisition belongs to Google; charging it to Meta would overstate Meta's
    // lead count and understate its cost per lead.
    const p = parseAttribution({
      attributionSource: { gclid: "g", url: "https://x.test/?utm_id=1111111111" },
      lastAttributionSource: { fbclid: "f" },
    });
    expect(p.platform).toBe("google");
    expect(p.googleCampaignId).toBe("1111111111");
  });

  it("falls back to last touch only when first touch identifies nothing", () => {
    const p = parseAttribution({
      attributionSource: {},
      lastAttributionSource: META_FB,
    });
    expect(p.platform).toBe("meta");
  });

  it("stores both click ids regardless of the verdict", () => {
    const p = parseAttribution({ attributionSource: { fbclid: "a", gclid: "b" } });
    expect(p.platform).toBe("unknown");
    expect(p.fbclid).toBe("a");
    expect(p.gclid).toBe("b");
  });

  it("survives an empty or absent attribution source", () => {
    expect(parseAttribution({}).platform).toBe("unknown");
    expect(parseAttribution({ attributionSource: {} }).metaCampaignId).toBeNull();
  });
});

describe("normalizeRawAttribution", () => {
  /*
   * Two shapes exist in production: the webhook path nests under
   * `attributionSource`, the bulk import stored the source object flat. A
   * backfill that understood only one would silently skip half the table.
   */
  it("reads the nested webhook shape", () => {
    const n = normalizeRawAttribution({
      attributionSource: META_FB,
      lastAttributionSource: null,
    });
    expect(n.attributionSource?.utmSource).toBe("fb");
  });

  it("reads the flat imported shape", () => {
    const n = normalizeRawAttribution(META_FB);
    expect(n.attributionSource?.utmSource).toBe("fb");
  });

  it("survives junk", () => {
    expect(normalizeRawAttribution(null)).toEqual({});
    expect(normalizeRawAttribution("nope")).toEqual({});
  });
});

describe("facebookLeadId", () => {
  /*
   * The only attribution a native Instant Form lead carries. Which field name
   * actually arrives has NOT been verified against live data — no Instant Form
   * lead has come through this pipe yet — so several documented carriers are
   * accepted and `asId` refuses anything that is not a long number.
   */
  it("reads it from the attribution source", () => {
    const p = parseAttribution({
      attributionSource: {
        facebookLeadId: "1203630123456789",
      } as never,
    });
    expect(p.facebookLeadId).toBe("1203630123456789");
  });

  it("reads it from a lead_id URL parameter", () => {
    const p = parseAttribution({
      attributionSource: {
        url: "https://x.com/thanks?lead_id=1203630123456789",
      } as never,
    });
    expect(p.facebookLeadId).toBe("1203630123456789");
  });

  it("🔴 refuses a value that is not an id", () => {
    // The column feeds a Graph API path. A form answer landing here must read
    // null rather than being stored and later interpolated into a request.
    const p = parseAttribution({
      attributionSource: { facebookLeadId: "Jane Doe" } as never,
    });
    expect(p.facebookLeadId).toBeNull();
  });

  it("is null when nothing carries one", () => {
    const p = parseAttribution({ attributionSource: META_FB });
    expect(p.facebookLeadId).toBeNull();
  });

  it("🔴 is kept whatever the platform verdict says", () => {
    /*
     * Not gated on `platform`, unlike every other id. A leadgen id is a Meta
     * object by definition, and a native Lead Ad has no URL — so the evidence
     * the verdict is derived from does not exist for exactly these leads.
     */
    const p = parseAttribution({
      attributionSource: { facebookLeadId: "1203630123456789" } as never,
    });
    expect(p.platform).toBe("unknown");
    expect(p.facebookLeadId).toBe("1203630123456789");
  });
});
