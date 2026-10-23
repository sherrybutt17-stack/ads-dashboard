import type { Client } from "@/db/schema";
import type { ClientBranding } from "@/lib/branding";
import { getClientBranding } from "@/lib/branding-store";
import { activeGoogleAccountsForDisplay } from "@/lib/google/accounts";
import { activeAdAccounts } from "@/lib/meta/accounts";
import { activeTiktokAccountsForDisplay } from "@/lib/tiktok/accounts";
import type { BoardConnections } from "./aggregate";
import type { StarterContext } from "./catalog";

export interface BoardContext {
  connections: BoardConnections;
  starter: StarterContext;
  branding: ClientBranding;
  brandName: string;
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
  const [meta, google, tiktok, branding] = await Promise.all([
    activeAdAccounts(client.id).catch(() => []),
    activeGoogleAccountsForDisplay(client.id),
    activeTiktokAccountsForDisplay(client.id),
    getClientBranding(client.id),
  ]);
  const connections: BoardConnections = {
    meta: meta.length > 0,
    google: google.accounts.length > 0,
    tiktok: tiktok.accounts.length > 0,
    // A location id means the CRM was wired up; a first webhook means it spoke.
    crm: Boolean(client.ghlLocationId || client.firstWebhookAt),
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
  };
}
