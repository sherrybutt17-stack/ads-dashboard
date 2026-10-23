import type { AdPlatform } from "@/lib/platforms";

export interface LeadFilterSetting {
  mode: "all" | "attributed" | "tagged" | "either";
  tag: string;
}

/**
 * The sentence that says which leads a number counts — shared by the Overview's
 * lead-source note and the board, so both say the same thing about the same
 * figure.
 *
 * Google and TikTok leads are matched by their own attribution (a click id or
 * a campaign id, `platformLeadPredicate` in queries.ts) and ignore the Meta
 * mode and tag entirely, so they are described by that rather than by a filter
 * the numbers were NOT computed with.
 */
export function leadFilterDescription(platform: AdPlatform, filter: LeadFilterSetting): string {
  if (platform === "google") {
    return "Counting leads with a Google click ID (gclid) or Google campaign ID";
  }
  if (platform === "tiktok") {
    return "Counting leads with a TikTok click ID (ttclid) or TikTok campaign ID";
  }
  switch (filter.mode) {
    case "all":
      return "Counting every lead in the pipeline — cost metrics include organic and referral leads";
    case "attributed":
      return "Counting only leads with a Facebook campaign ID";
    case "tagged":
      return `Counting only leads tagged "${filter.tag}"`;
    default:
      return `Counting leads with a Facebook campaign ID or tagged "${filter.tag}"`;
  }
}
