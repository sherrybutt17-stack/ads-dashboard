import type { Client } from "@/db/schema";
import type { AdPlatform } from "@/lib/platforms";
import { getGoogleAccountSummary } from "./queries";

/**
 * The currency a platform's money is shown in.
 *
 * The same rule as `loadDashboard` (`dashboard.ts`, where Meta comes from the
 * client row and Google from its primary account): a Google figure priced in
 * Meta's currency would print "$" over amounts the platform reported in CAD.
 * TikTok keeps the dashboard's current Meta fallback, so the two screens agree
 * until that gap is fixed in both places.
 */
export async function platformCurrency(client: Client, platform: AdPlatform): Promise<string> {
  const meta = client.metaCurrency ?? "USD";
  if (platform !== "google") return meta;
  try {
    const g = await getGoogleAccountSummary(client.id);
    return g.currency ?? meta;
  } catch {
    return meta;
  }
}
