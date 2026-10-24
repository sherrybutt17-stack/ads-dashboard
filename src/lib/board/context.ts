import { crmConnected } from "@/lib/clients";
import type { Client } from "@/db/schema";
import type { ClientBranding } from "@/lib/branding";
import { getClientBranding } from "@/lib/branding-store";
import { activeGoogleAccountsForDisplay } from "@/lib/google/accounts";
import { activeAdAccounts } from "@/lib/meta/accounts";
import { activeTiktokAccountsForDisplay } from "@/lib/tiktok/accounts";
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
  };
}
