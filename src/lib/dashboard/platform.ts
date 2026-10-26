import { activeAdAccounts } from "@/lib/meta/accounts";
import { activeGoogleAccountsForDisplay } from "@/lib/google/accounts";
import { activeTiktokAccountsForDisplay } from "@/lib/tiktok/accounts";
import {
  isAdPlatform,
  resolveAdPlatform,
  type AdPlatform,
  type ConnectedPlatforms,
} from "@/lib/platforms";

/**
 * Which ad platforms a client has a live account on, for choosing the view a
 * page opens on and the platforms its toggle offers.
 *
 * Each platform is asked through its own module's reader, so the status rule
 * stays the one that module owns — Meta and Google count `active`, TikTok
 * anything not `removed` — rather than being restated here as a fourth copy.
 *
 * Never throws, exactly as `loadBoardContext` reads the same three lists: a
 * lookup that fails counts as not connected. The worst that costs is the page
 * opening on Meta, as every page did before the default followed the client —
 * where a throw would take down a dashboard over a list the page only needs
 * to pick a tab.
 */
export async function connectedAdPlatforms(clientId: string): Promise<ConnectedPlatforms> {
  const [meta, google, tiktok] = await Promise.all([
    activeAdAccounts(clientId).catch((err: unknown) => {
      console.error("[dashboard] Meta account list unavailable:", err);
      return [];
    }),
    activeGoogleAccountsForDisplay(clientId),
    activeTiktokAccountsForDisplay(clientId),
  ]);
  return {
    meta: meta.length > 0,
    google: google.accounts.length > 0,
    tiktok: tiktok.accounts.length > 0,
  };
}

/**
 * The platform a page renders, from its `?platform=` and the client's accounts.
 *
 * For the report and meeting mode, which have no other use for the account
 * lists. A link that names a platform costs no query at all — it wins before
 * the lists would be read — and the Overview names it on every link except
 * Meta's own for a client with Meta (`linkCarriesPlatform`).
 */
export async function resolvePagePlatform(clientId: string, requested: unknown): Promise<AdPlatform> {
  if (isAdPlatform(requested)) return requested;
  return resolveAdPlatform(requested, await connectedAdPlatforms(clientId));
}
