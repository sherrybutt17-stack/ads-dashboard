import { crmConnected } from "@/lib/clients";
import type { Client } from "@/db/schema";
import type { ClientBranding } from "@/lib/branding";
import { getClientBranding } from "@/lib/branding-store";
import { activeGoogleAccountsForDisplay } from "@/lib/google/accounts";
import { activeAdAccounts } from "@/lib/meta/accounts";
import { activeTiktokAccountsForDisplay } from "@/lib/tiktok/accounts";
import { newestAdSync } from "@/lib/platforms";
import type { BoardConnections } from "./aggregate";
import type { StarterContext } from "./catalog";
import { listCustomMetrics } from "./custom-metrics";
import { buildRegistry, type CustomMetric, type Registry } from "./registry";

export interface BoardContext {
  connections: BoardConnections;
  starter: StarterContext;
  branding: ClientBranding;
  brandName: string;
  /** The agency's own metrics (Settings → Metrics), archived ones included. */
  metrics: CustomMetric[];
  /** The stats this client's board can name: the built-ins and `metrics`. */
  registry: Registry;
  /**
   * When this client's ad figures last synced, across the platforms it has —
   * what the board's header and every sheet's footer are dated with.
   *
   * 🔴 Not `client.lastSyncedAt`, which both used to read. That column is
   * Meta's alone — the Google and TikTok syncs stamp their own account rows —
   * so a TikTok-only client's board said "Not synced yet" over a sync that ran
   * an hour ago, and its PDF and share link left the "as at" line off.
   *
   * One time for the whole board rather than one per platform, because that is
   * how both places are built: a single indicator in the header, a single line
   * in each footer, and no sync time on any widget. The newest, because the one
   * thing a single time can say truthfully about several pipes is when the
   * board's figures last moved. It can therefore sit ahead of a platform that
   * has stopped syncing — that pipe's own freshness row on the health
   * checklist is where it shows. See `newestAdSync`.
   */
  syncedAt: Date | null;
}

/**
 * What a client has connected, once, for the page that renders their board.
 *
 * It decides two things: which starter layout they get (a Google-only client
 * should not open on a wall of Meta tiles) and which widgets say "not
 * connected" instead of printing a row of zeros that reads like a dead account.
 *
 * Never throws. A lookup that fails counts as not connected — the widgets then
 * explain themselves, which is better than the whole board failing over one
 * account list.
 */
export async function loadBoardContext(client: Client): Promise<BoardContext> {
  const [meta, google, tiktok, branding, metrics] = await Promise.all([
    activeAdAccounts(client.id).catch(() => []),
    activeGoogleAccountsForDisplay(client.id),
    activeTiktokAccountsForDisplay(client.id),
    getClientBranding(client.id),
    // Never throws: a missing table or a failed read means "no custom metrics".
    listCustomMetrics(client.agencyId),
  ]);
  const connections: BoardConnections = {
    meta: meta.length > 0,
    google: google.accounts.length > 0,
    tiktok: tiktok.accounts.length > 0,
    crm: crmConnected(client),
  };
  const brandName = branding.displayName ?? client.name;
  return {
    connections,
    starter: {
      hasMeta: connections.meta,
      hasGoogle: connections.google,
      hasTiktok: connections.tiktok,
      hasCrm: connections.crm,
      hasLogo: branding.hasLogo,
      clientName: brandName,
    },
    branding,
    brandName,
    metrics,
    registry: buildRegistry(metrics),
    // From the lists already read above: no query of its own.
    syncedAt: newestAdSync({
      metaConnected: connections.meta,
      metaSyncedAt: client.lastSyncedAt,
      accountSyncs: [...google.accounts, ...tiktok.accounts].map((a) => a.lastSyncedAt),
    }),
  };
}
