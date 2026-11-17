import { sql, type SQL } from "drizzle-orm";
import type { Client } from "@/db/schema";

/**
 * Shared sub-account: what a NEW row starts as when a sharing holder's writers
 * insert it — in the share, and not counted yet. The split (`./share.ts`)
 * decides who counts it straight after the delivery or import page, so a
 * failure in between under-counts until the sweep, and never counts twice.
 *
 * 🔴 Computed INSIDE the insert from the clients row, not from the client the
 * request loaded: a Stop sharing that commits while a delivery is in flight
 * leaves a stray stamp for at most the length of one statement, which the
 * sweep's invariant reset then clears.
 *
 * Insert values only — never an ON CONFLICT set, so an existing row keeps its
 * flags. Empty for a client that doesn't share: its SQL is exactly as before.
 */
export function shareStamp(
  client: Pick<Client, "id"> & Partial<Pick<Client, "ghlShareInstallationId">>,
): { shareInstallationId?: SQL; shareCounted?: SQL } {
  if (!client.ghlShareInstallationId) return {};
  const current = sql`(SELECT ghl_share_installation_id FROM clients WHERE id = ${client.id})`;
  return {
    shareInstallationId: current,
    shareCounted: sql`(CASE WHEN ${current} IS NULL THEN NULL ELSE false END)`,
  };
}
