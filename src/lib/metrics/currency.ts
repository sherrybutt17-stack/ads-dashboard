import type { Client } from "@/db/schema";
import type { AdPlatform } from "@/lib/platforms";
import { getGoogleAccountSummary, getTiktokAccountSummary } from "./queries";

/**
 * The currency a platform's money is shown in, and when that platform last
 * synced — the two facts a view of one platform is labelled and dated with.
 *
 * ONE resolver for the Overview (`loadDashboard`) and the Board (through
 * `platformCurrency` below), so the two screens cannot price or date the same
 * platform differently.
 *
 * Meta's both live on the client row. Google's and TikTok's live on their own
 * account rows, because their syncs never write the client row: a Google figure
 * priced in Meta's currency would print "$" over amounts the platform reported
 * in CAD.
 *
 * 🔴 An exhaustive switch, not `platform === "google" ? … : Meta's`.
 *
 * That was the shape here and in `loadDashboard`, and TikTok fell through both
 * into Meta's values: its spend wore Meta's currency on the Board and the
 * Overview alike, and the Overview dated it from `clients.last_synced_at`,
 * which only the Meta sync writes — NULL for a client running TikTok alone, so
 * a sync that had run an hour earlier read "Not synced yet" in the header and
 * "TikTok last synced: never" in the footer. The agency was told its working
 * pipe had never run. With no default branch, a fourth platform is a compile
 * error here rather than a third fall-through.
 */
export async function platformCurrencyAndSync(
  client: Pick<Client, "id" | "metaCurrency" | "lastSyncedAt">,
  platform: AdPlatform,
): Promise<{ currency: string; syncedAt: Date | null }> {
  const meta = client.metaCurrency ?? "USD";
  switch (platform) {
    case "meta":
      return { currency: meta, syncedAt: client.lastSyncedAt };
    case "google": {
      const g = await getGoogleAccountSummary(client.id);
      return { currency: g.currency ?? meta, syncedAt: g.lastSynced };
    }
    case "tiktok": {
      const t = await getTiktokAccountSummary(client.id);
      return { currency: t.currency ?? meta, syncedAt: t.lastSynced };
    }
  }
}

/**
 * The currency alone, for a surface that must render rather than fail: a
 * lookup that throws falls back to Meta's, so one widget's label never takes
 * a board down.
 */
export async function platformCurrency(client: Client, platform: AdPlatform): Promise<string> {
  try {
    return (await platformCurrencyAndSync(client, platform)).currency;
  } catch {
    return client.metaCurrency ?? "USD";
  }
}
