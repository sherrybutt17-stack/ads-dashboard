import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Client } from "@/db/schema";
import { isSuperadmin } from "@/lib/auth";
import type { SessionPayload } from "@/lib/session";
import { trailingWindowInclusive } from "@/lib/dates";
import { clientTags } from "@/lib/tag-funnel";
import { liveMembers, loadShareForClient, shareClients } from "./share";
import { holdsFormerCopies } from "./share-actions";
import { MAX_SHARE_CLIENTS } from "./share-rule";

/**
 * Everything the "Share this sub-account" panel on the Connections page shows,
 * for one client and one viewer. Read-only.
 */

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

export interface SharePanelClient {
  id: string;
  name: string;
  slug: string;
  tags: string[];
  isHolder: boolean;
  archived: boolean;
  /** ISO date this client joined the share. */
  since: string | null;
  /** People counted for this client, contacts added in the last 30 days. */
  counted30: number;
  paidLeadTag: string;
  paidLeadFilter: string;
  alertsOn: boolean;
}

export interface SharePanelCandidate {
  id: string;
  name: string;
  /** Why it can't be added, or null when it can. */
  blocked: "own_ghl" | "in_share" | null;
}

export interface SharePanelState {
  /** Growth Guild: add a client, stop sharing, remove copied leads. */
  canManage: boolean;
  /** Agency logins and Growth Guild: change the tags (decision 1). */
  canEditTags: boolean;
  role: "holder" | "member" | null;
  /** The client holding the connection — this one when it holds it. */
  holder: { id: string; name: string; slug: string } | null;
  /** This client holds exactly one live app installation for its location, so it could share it. */
  canShare: boolean;
  installationLive: boolean;
  clients: SharePanelClient[];
  /** The client taking leads with no client's tag; null = no one. */
  untagged: string | null;
  keepRemoved: boolean;
  version: number;
  /** Every tag on the sub-account's contacts, most used first. */
  tags: { tag: string; contacts: number }[];
  /** Contacts in the sub-account, for tag-coverage warnings. */
  totalContacts: number;
  /** Clients of the same agency that could be added (Growth Guild only). */
  candidates: SharePanelCandidate[];
  maxClients: number;
  /** Copied leads this client still holds from a sub-account it no longer shares. */
  formerCopies: number;
}

export async function loadSharePanel(client: Client, session: SessionPayload | null): Promise<SharePanelState> {
  const superadmin = isSuperadmin(session);
  const share = client.ghlShareInstallationId ? await loadShareForClient(db, client.id) : null;
  const holderId = share?.holder.id ?? client.id;

  const installs = rows<{ id: string; location_id: string; live: boolean }>(
    await db.execute(sql`
      SELECT id::text AS id, location_id, (uninstalled_at IS NULL) AS live
        FROM ghl_installations WHERE client_id = ${holderId}
    `),
  );
  const live = installs.filter((i) => i.live);
  const [holderRow] = rows<{ name: string; slug: string; location: string | null }>(
    await db.execute(sql`SELECT name, slug, ghl_location_id AS location FROM clients WHERE id = ${holderId}`),
  );
  const canShare = !share
    ? live.length === 1 && live[0].location_id === client.ghlLocationId
    : share.holder.id === client.id;

  const base: SharePanelState = {
    canManage: superadmin,
    canEditTags: true,
    role: share ? (share.holder.id === client.id ? "holder" : "member") : null,
    holder: holderRow ? { id: holderId, name: holderRow.name, slug: holderRow.slug } : null,
    canShare,
    installationLive: live.length > 0,
    clients: [],
    untagged: null,
    keepRemoved: share?.keepRemoved ?? true,
    version: share?.version ?? 0,
    tags: [],
    totalContacts: 0,
    candidates: [],
    maxClients: MAX_SHARE_CLIENTS,
    formerCopies: share ? 0 : await holdsFormerCopies(client.id),
  };
  if (!share && !canShare) return base;

  const members = share ? shareClients(share) : [];
  const ids = share ? members.map((c) => c.id) : [client.id];
  const window = trailingWindowInclusive(30, client.timezone);
  const details = rows<{
    id: string;
    name: string;
    slug: string;
    status: string;
    tags: string[] | null;
    since: string | Date | null;
    untagged: boolean;
    paid_tag: string;
    paid_filter: string;
    alerts: boolean;
    counted: number;
  }>(
    await db.execute(sql`
      SELECT c.id::text AS id, c.name, c.slug, c.status::text AS status, c.ghl_share_tags AS tags,
             c.ghl_share_since AS since, c.ghl_share_gets_untagged AS untagged,
             c.paid_lead_tag AS paid_tag, c.paid_lead_filter::text AS paid_filter,
             (c.alerts_enabled AND c.alert_webhook_encrypted IS NOT NULL) AS alerts,
             (SELECT COUNT(*)::int FROM contacts x
               WHERE x.client_id = c.id AND x.share_counted IS NOT FALSE
                 AND COALESCE(x.ghl_created_at, x.created_at) >= ${window.startUtc}) AS counted
        FROM clients c
       WHERE c.id = ANY(${sql.param(ids)}::uuid[])
    `),
  );
  const order = new Map(ids.map((id, i) => [id, i]));
  base.clients = details
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((d) => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      tags: d.tags ?? [],
      isHolder: d.id === holderId,
      archived: d.status === "archived",
      since: d.since ? new Date(d.since).toISOString() : null,
      counted30: Number(d.counted) || 0,
      paidLeadTag: d.paid_tag,
      paidLeadFilter: d.paid_filter,
      alertsOn: Boolean(d.alerts),
    }));
  base.untagged = share ? (details.find((d) => d.untagged)?.id ?? null) : client.id;

  base.tags = await clientTags(holderId, { all: true });
  const [total] = rows<{ n: number }>(
    await db.execute(sql`SELECT COUNT(*)::int AS n FROM contacts WHERE client_id = ${holderId}`),
  );
  base.totalContacts = Number(total?.n) || 0;

  if (superadmin && (!share || liveMembers(share).length + 1 < MAX_SHARE_CLIENTS)) {
    const installationId = share?.installationId ?? live[0]?.id ?? null;
    base.candidates = rows<{ id: string; name: string; in_share: boolean; own: boolean }>(
      await db.execute(sql`
        SELECT c.id::text AS id, c.name,
               (c.ghl_share_installation_id IS NOT NULL) AS in_share,
               (c.ghl_location_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM ghl_installations i WHERE i.client_id = c.id)
                 OR EXISTS (SELECT 1 FROM contacts x WHERE x.client_id = c.id
                              AND x.share_installation_id IS DISTINCT FROM ${installationId}::uuid)) AS own
          FROM clients c
         WHERE c.agency_id = ${client.agencyId} AND c.status <> 'archived'
           AND NOT (c.id = ANY(${sql.param(ids)}::uuid[]))
         ORDER BY c.name
      `),
    ).map((r) => ({ id: r.id, name: r.name, blocked: r.in_share ? "in_share" : r.own ? "own_ghl" : null }));
  }
  return base;
}
