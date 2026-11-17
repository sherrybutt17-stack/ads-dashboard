import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { lockClient, projectAndWrite } from "@/lib/tag-funnel";
import {
  decideSplit,
  PLACED_BY_TAG,
  type ShareReason,
  type ShareRules,
  type SplitEvidence,
} from "./share-rule";

/**
 * "Share this sub-account" — one GoHighLevel sub-account feeding several
 * dashboard clients. The engine: copying the holder's rows to every member,
 * and splitting each person to the ONE client that counts them.
 *
 * ── The model ─────────────────────────────────────────────────────────
 *
 *   SHARE    one `ghl_installations` row (the app connection). Every client in
 *            it carries `clients.ghl_share_installation_id` = that row.
 *   HOLDER   the client the installation is bound to. Only it talks to
 *            GoHighLevel: webhooks, imports and reads all run as the holder,
 *            exactly as before sharing.
 *   MEMBERS  the other clients (up to four). Each keeps a FULL copy of the
 *            holder's contacts, opportunities, stage moves, tag history and
 *            webhook events — written only by the mirror below — so every
 *            screen keeps reading by `client_id`.
 *
 * Which copy counts is a pair of flags on `contacts` and `opportunities`:
 * `share_counted` true on exactly one copy of a person (a partial unique index
 * makes a second impossible), false on the rest; every reader drops the false
 * ones (`src/lib/metrics/ledger.ts`). New rows start false, so a failure can
 * only UNDER-count until the hourly sweep repairs it — never count twice.
 *
 * Who counts a person is decided by `decideSplit` (`./share-rule.ts`) from the
 * holder's copy alone: the users' tags, nothing else. Cards and tag stand-ins
 * follow their contact's verdict; a card with no contact takes the no-tag
 * choice.
 *
 * ── Locks ─────────────────────────────────────────────────────────────
 *
 * Every write here holds, in this order: the share lock, then the tag-funnel
 * lock of EVERY client in the share, sorted by id. That is the lock Map by
 * tag's saves and rebuilds take, so no stand-in is ever written mid-split and
 * a client switching modes cannot slip between the split and its projection.
 * Nothing that holds a tag-funnel lock ever asks for the share lock.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<Tx, "execute">;

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One array parameter: drizzle spreads a bare array into a row, which ANY() refuses. */
const textArray = (values: readonly (string | null)[]) => sql`${sql.param([...values])}::text[]`;
const uuidArray = (values: readonly (string | null)[]) => sql`${sql.param([...values])}::uuid[]`;

/* ------------------------------------------------------------------ *
 * Loading a share
 * ------------------------------------------------------------------ */

export interface ShareClient {
  id: string;
  name: string;
  slug: string;
  agencyId: string | null;
  status: string;
  /** Normalised GHL tags that mark this client's leads. */
  tags: string[];
  getsUntagged: boolean;
  since: Date | null;
}

export interface Share {
  installationId: string;
  holder: ShareClient;
  /** Every other client in the share, archived ones included. */
  members: ShareClient[];
  keepRemoved: boolean;
  version: number;
  splitVersion: number;
}

export const shareClients = (share: Share): ShareClient[] => [share.holder, ...share.members];
export const liveMembers = (share: Share): ShareClient[] => share.members.filter((m) => m.status !== "archived");

/**
 * The share an installation feeds, or null when it feeds no one but its own
 * client. The holder is whoever the installation is bound to — and only while
 * that client is itself in the share.
 */
export async function loadShare(exec: Exec, installationId: string): Promise<Share | null> {
  const found = rows<{
    id: string;
    name: string;
    slug: string;
    agency_id: string | null;
    status: string;
    tags: string[] | null;
    gets_untagged: boolean;
    since: string | Date | null;
    keep_removed: boolean;
    version: number;
    split_version: number;
    is_holder: boolean;
  }>(
    await exec.execute(sql`
      SELECT c.id::text AS id, c.name, c.slug, c.agency_id::text AS agency_id, c.status::text AS status,
             c.ghl_share_tags AS tags, c.ghl_share_gets_untagged AS gets_untagged, c.ghl_share_since AS since,
             c.ghl_share_keep_removed AS keep_removed, c.ghl_share_version AS version,
             c.ghl_share_split_version AS split_version,
             (c.id = i.client_id) AS is_holder
        FROM clients c
        JOIN ghl_installations i ON i.id = ${installationId}
       WHERE c.ghl_share_installation_id = ${installationId}
       ORDER BY c.ghl_share_since NULLS FIRST, c.created_at, c.id
    `),
  );
  const toClient = (r: (typeof found)[number]): ShareClient => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    agencyId: r.agency_id,
    status: r.status,
    tags: r.tags ?? [],
    getsUntagged: Boolean(r.gets_untagged),
    since: r.since ? new Date(r.since) : null,
  });
  const holder = found.find((r) => r.is_holder);
  if (!holder) return null;
  return {
    installationId,
    holder: toClient(holder),
    members: found.filter((r) => !r.is_holder).map(toClient),
    keepRemoved: Boolean(holder.keep_removed),
    version: Number(holder.version) || 0,
    splitVersion: Number(holder.split_version) || 0,
  };
}

/** The share a client is in (as holder or member), or null. */
export async function loadShareForClient(exec: Exec, clientId: string): Promise<Share | null> {
  const [row] = rows<{ installation: string | null }>(
    await exec.execute(sql`SELECT ghl_share_installation_id::text AS installation FROM clients WHERE id = ${clientId}`),
  );
  return row?.installation ? loadShare(exec, row.installation) : null;
}

/**
 * The rules the split runs on. Archived members keep their tags — a lead with
 * their tag counts for no active client rather than drifting to the no-tag
 * choice — but never take untagged leads: the holder does instead.
 */
export function shareRules(share: Share): ShareRules {
  const all = shareClients(share);
  const untagged = all.find((c) => c.getsUntagged);
  return {
    tags: new Map(all.map((c) => [c.id, c.tags])),
    untagged: !untagged ? null : untagged.status === "archived" ? share.holder.id : untagged.id,
    keepRemoved: share.keepRemoved,
  };
}

export interface LockedShare {
  share: Share;
  /** Each client's counting mode, read under its tag-funnel lock. */
  modes: Map<string, { mode: string; everyContact: boolean }>;
}

/**
 * Take the share lock, load the share under it, then every client's tag-funnel
 * lock in id order, and only then read their modes. Null when the
 * installation no longer feeds a share.
 */
export async function lockShare(tx: Exec, installationId: string): Promise<LockedShare | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ghl-share:${installationId}`}, 0))`);
  const share = await loadShare(tx, installationId);
  if (!share) return null;
  const ids = shareClients(share)
    .map((c) => c.id)
    .sort();
  for (const id of ids) await lockClient(tx, id);
  const modeRows = rows<{ id: string; mode: string; every_contact: boolean }>(
    await tx.execute(sql`
      SELECT id::text AS id, crm_mapping_mode::text AS mode, tag_lead_every_contact AS every_contact
        FROM clients WHERE id = ANY(${uuidArray(ids)})
    `),
  );
  return {
    share,
    modes: new Map(modeRows.map((r) => [r.id, { mode: r.mode, everyContact: Boolean(r.every_contact) }])),
  };
}

/* ------------------------------------------------------------------ *
 * The mirror: holder rows → one member's copy
 * ------------------------------------------------------------------ */

/** Which of the holder's rows a mirror or split covers. Null lists mean all. */
export interface ShareScope {
  /** GHL contact ids. */
  contacts: readonly string[] | null;
  /** GHL opportunity ids, for cards whose contact is unknown. */
  opportunities?: readonly string[] | null;
}

export interface MirrorTarget {
  holderId: string;
  memberId: string;
  installationId: string;
}

/**
 * How `alerted_at` is set on a member's NEW copy. `live` leaves it empty, so
 * the member can alert a fresh lead the split gives it. `history` stamps an
 * old date (link time, repairs): those copies must neither alert nor count
 * toward the member's hourly alert limit.
 */
export type MirrorAlerting = "live" | "history";

/** Every pipeline stage: a share has ONE stage mapping, the holder's (§6.8). */
export async function mirrorStages(tx: Exec, t: MirrorTarget): Promise<void> {
  await tx.execute(sql`
    INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, ghl_stage_name, ghl_pipeline_name,
                                 canonical_stage, display_order, discovered_from_webhook, created_at, updated_at)
    SELECT ${t.memberId}, h.ghl_pipeline_id, h.ghl_stage_id, h.ghl_stage_name, h.ghl_pipeline_name,
           h.canonical_stage, h.display_order, h.discovered_from_webhook, h.created_at, h.updated_at
      FROM pipeline_stages h
     WHERE h.client_id = ${t.holderId}
    ON CONFLICT (client_id, ghl_stage_id) DO UPDATE SET
      ghl_pipeline_id = excluded.ghl_pipeline_id,
      ghl_stage_name = excluded.ghl_stage_name,
      ghl_pipeline_name = excluded.ghl_pipeline_name,
      canonical_stage = excluded.canonical_stage,
      display_order = excluded.display_order,
      discovered_from_webhook = excluded.discovered_from_webhook,
      updated_at = excluded.updated_at
    WHERE (pipeline_stages.ghl_pipeline_id, pipeline_stages.ghl_stage_name, pipeline_stages.ghl_pipeline_name,
           pipeline_stages.canonical_stage, pipeline_stages.display_order, pipeline_stages.discovered_from_webhook)
          IS DISTINCT FROM
          (excluded.ghl_pipeline_id, excluded.ghl_stage_name, excluded.ghl_pipeline_name,
           excluded.canonical_stage, excluded.display_order, excluded.discovered_from_webhook)
  `);
}

const CONTACT_COLUMNS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "meta_campaign_id",
  "meta_adset_id",
  "meta_ad_id",
  "tiktok_campaign_id",
  "fbclid",
  "gclid",
  "ttclid",
  "google_campaign_id",
  "facebook_lead_id",
  "tags",
  "raw_attribution",
  "attribution_fetched_at",
  "ghl_created_at",
] as const;

/**
 * The holder's contacts as the member's copies. A new copy is uncounted; an
 * existing one takes the holder's values (only when the holder's row changed,
 * unless `force`), never its share flags or its alert claim.
 */
export async function mirrorContacts(
  tx: Exec,
  t: MirrorTarget,
  scope: ShareScope,
  opts: { alerting: MirrorAlerting; onlyChanged?: boolean },
): Promise<void> {
  const cols = sql.raw(CONTACT_COLUMNS.join(", "));
  const fromHolder = sql.raw(CONTACT_COLUMNS.map((c) => `h.${c}`).join(", "));
  const set = sql.raw(CONTACT_COLUMNS.map((c) => `${c} = excluded.${c}`).join(",\n      "));
  const alerted =
    opts.alerting === "history" ? sql`COALESCE(h.alerted_at, h.ghl_created_at, h.created_at)` : sql`NULL::timestamptz`;
  const inScope = scope.contacts ? sql`AND h.ghl_contact_id = ANY(${textArray(scope.contacts)})` : sql``;
  await tx.execute(sql`
    INSERT INTO contacts (client_id, ghl_contact_id, ${cols}, first_call_at, first_touch_at, alerted_at,
                          share_installation_id, share_counted, created_at, updated_at)
    SELECT ${t.memberId}, h.ghl_contact_id, ${fromHolder}, h.first_call_at, h.first_touch_at, ${alerted},
           ${t.installationId}, false, h.created_at, h.updated_at
      FROM contacts h
     WHERE h.client_id = ${t.holderId} ${inScope}
    ON CONFLICT (client_id, ghl_contact_id) DO UPDATE SET
      ${set},
      first_call_at = COALESCE(excluded.first_call_at, contacts.first_call_at),
      first_touch_at = COALESCE(excluded.first_touch_at, contacts.first_touch_at),
      updated_at = excluded.updated_at
    WHERE contacts.share_installation_id = ${t.installationId}
      ${opts.onlyChanged ? sql`AND contacts.updated_at IS DISTINCT FROM excluded.updated_at` : sql``}
  `);
}

/** The holder's real cards (never its tag stand-ins) as the member's copies. */
export async function mirrorOpportunities(
  tx: Exec,
  t: MirrorTarget,
  scope: ShareScope,
  opts: { onlyChanged?: boolean } = {},
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO opportunities (client_id, ghl_opportunity_id, contact_id, ghl_contact_id, ghl_pipeline_id, name,
                               current_stage_id, current_stage_ghl_id, status, monetary_value, ghl_created_at,
                               last_stage_change_at, from_tags, share_installation_id, share_counted,
                               created_at, updated_at)
    SELECT ${t.memberId}, h.ghl_opportunity_id, mc.id, h.ghl_contact_id, h.ghl_pipeline_id, h.name,
           ms.id, h.current_stage_ghl_id, h.status, h.monetary_value, h.ghl_created_at,
           h.last_stage_change_at, false, ${t.installationId}, false,
           h.created_at, h.updated_at
      FROM opportunities h
      LEFT JOIN contacts mc ON mc.client_id = ${t.memberId} AND mc.ghl_contact_id = h.ghl_contact_id
      LEFT JOIN pipeline_stages ms ON ms.client_id = ${t.memberId} AND ms.ghl_stage_id = h.current_stage_ghl_id
     WHERE h.client_id = ${t.holderId} AND NOT h.from_tags ${opportunityScope(sql`h`, scope)}
    ON CONFLICT (client_id, ghl_opportunity_id) DO UPDATE SET
      contact_id = excluded.contact_id,
      ghl_contact_id = excluded.ghl_contact_id,
      ghl_pipeline_id = excluded.ghl_pipeline_id,
      name = excluded.name,
      current_stage_id = excluded.current_stage_id,
      current_stage_ghl_id = excluded.current_stage_ghl_id,
      status = excluded.status,
      monetary_value = excluded.monetary_value,
      ghl_created_at = excluded.ghl_created_at,
      last_stage_change_at = excluded.last_stage_change_at,
      updated_at = excluded.updated_at
    WHERE opportunities.share_installation_id = ${t.installationId}
      ${opts.onlyChanged ? sql`AND opportunities.updated_at IS DISTINCT FROM excluded.updated_at` : sql``}
  `);
}

function opportunityScope(alias: SQL, scope: ShareScope): SQL {
  const parts: SQL[] = [];
  if (scope.contacts) parts.push(sql`${alias}.ghl_contact_id = ANY(${textArray(scope.contacts)})`);
  if (scope.opportunities) parts.push(sql`${alias}.ghl_opportunity_id = ANY(${textArray(scope.opportunities)})`);
  if (scope.contacts === null && !scope.opportunities) return sql``;
  if (parts.length === 0) return sql`AND false`;
  return sql`AND (${sql.join(parts, sql` OR `)})`;
}

/**
 * The holder's stage moves as the member's, every id remapped to the member's
 * own rows. The dedupe key swaps the holder's opportunity-uuid prefix — which
 * every non-tag writer puts first — for the member's, so a copy can never
 * collide with an original and copying again inserts nothing.
 */
export async function mirrorTransitions(tx: Exec, t: MirrorTarget, scope: ShareScope): Promise<void> {
  await tx.execute(sql`
    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, from_stage_id, to_stage_id,
                                   from_stage_ghl_id, to_stage_ghl_id, from_canonical, to_canonical,
                                   changed_at, source, dedupe_key, webhook_event_id, created_at)
    SELECT ${t.memberId}, mo.id, mc.id, mfs.id, mts.id,
           h.from_stage_ghl_id, h.to_stage_ghl_id, h.from_canonical, h.to_canonical,
           h.changed_at, h.source,
           CASE WHEN left(h.dedupe_key, 37) = ho.id::text || ':'
                THEN mo.id::text || substr(h.dedupe_key, 37)
                ELSE mo.id::text || ':' || h.dedupe_key END,
           mev.id, h.created_at
      FROM stage_transitions h
      JOIN opportunities ho ON ho.id = h.opportunity_id AND NOT ho.from_tags
      JOIN opportunities mo ON mo.client_id = ${t.memberId} AND mo.ghl_opportunity_id = ho.ghl_opportunity_id
      LEFT JOIN contacts hc ON hc.id = h.contact_id
      LEFT JOIN contacts mc ON mc.client_id = ${t.memberId} AND mc.ghl_contact_id = hc.ghl_contact_id
      LEFT JOIN pipeline_stages mfs ON mfs.client_id = ${t.memberId} AND mfs.ghl_stage_id = h.from_stage_ghl_id
      LEFT JOIN pipeline_stages mts ON mts.client_id = ${t.memberId} AND mts.ghl_stage_id = h.to_stage_ghl_id
      LEFT JOIN webhook_events mev
             ON h.webhook_event_id IS NOT NULL
            AND mev.id = md5(h.webhook_event_id::text || ':' || ${t.memberId}::text)::uuid
     WHERE h.client_id = ${t.holderId} AND h.source::text <> 'tag' ${opportunityScope(sql`ho`, scope)}
    ON CONFLICT (dedupe_key) DO NOTHING
  `);
}

/** The holder's tag history, with the holder's dates, as the member's. */
export async function mirrorTagHistory(tx: Exec, t: MirrorTarget, scope: ShareScope): Promise<void> {
  const inScope = scope.contacts ? sql`AND hc.ghl_contact_id = ANY(${textArray(scope.contacts)})` : sql``;
  await tx.execute(sql`
    INSERT INTO contact_tag_history (contact_id, client_id, tag, first_seen_at, exact)
    SELECT mc.id, ${t.memberId}, h.tag, h.first_seen_at, h.exact
      FROM contact_tag_history h
      JOIN contacts hc ON hc.id = h.contact_id
      JOIN contacts mc ON mc.client_id = ${t.memberId} AND mc.ghl_contact_id = hc.ghl_contact_id
     WHERE h.client_id = ${t.holderId} ${inScope}
    ON CONFLICT (contact_id, tag) DO NOTHING
  `);
}

/**
 * Copy webhook events to a member. The copy's id is derived from the
 * original's, so copying twice changes nothing, and a copied stage move can
 * find its event's copy. Status and timing are the holder's, as processed.
 */
export async function mirrorEvents(
  tx: Exec,
  t: MirrorTarget,
  which: { eventIds: readonly string[] } | { since?: Date | null; limit?: number; afterId?: string | null },
): Promise<string | null> {
  let filter: SQL;
  if ("eventIds" in which) {
    if (which.eventIds.length === 0) return null;
    filter = sql`e.id = ANY(${uuidArray(which.eventIds)})`;
  } else {
    filter = sql`e.client_id = ${t.holderId}
      AND COALESCE(e.event_type, '') NOT IN ('INSTALL', 'UNINSTALL', 'AppInstall', 'AppUninstall')
      ${which.since ? sql`AND e.received_at >= ${which.since}` : sql``}
      ${which.afterId ? sql`AND e.id > ${which.afterId}::uuid` : sql``}`;
  }
  const res = await tx.execute(sql`
    WITH src AS (
      SELECT e.* FROM webhook_events e
       WHERE ${filter}
       ORDER BY e.id
       ${"eventIds" in which || !which.limit ? sql`` : sql`LIMIT ${which.limit}`}
    ), ins AS (
      INSERT INTO webhook_events (id, client_id, webhook_token, event_type, received_at, headers, payload,
                                  status, error, processed_at)
      SELECT md5(src.id::text || ':' || ${t.memberId}::text)::uuid, ${t.memberId}, NULL, src.event_type,
             src.received_at,
             COALESCE(src.headers, '{}'::jsonb)
               || jsonb_build_object('__sharedFrom', ${t.installationId}::text, '__copyOf', src.id::text),
             src.payload, src.status, src.error, src.processed_at
        FROM src
      ON CONFLICT (id) DO NOTHING
    )
    SELECT max(src.id::text) AS last FROM src
  `);
  return rows<{ last: string | null }>(res)[0]?.last ?? null;
}

/** Members' "a webhook has arrived" markers, from the holder's. */
export async function copyWebhookMarkers(tx: Exec, holderId: string, memberIds: readonly string[]): Promise<void> {
  if (memberIds.length === 0) return;
  await tx.execute(sql`
    UPDATE clients m
       SET first_webhook_at = COALESCE(m.first_webhook_at, h.first_webhook_at),
           last_webhook_at = GREATEST(m.last_webhook_at, h.last_webhook_at)
      FROM clients h
     WHERE h.id = ${holderId} AND m.id = ANY(${uuidArray(memberIds)})
  `);
}

/** Mirror one scope of the holder's rows to one member (everything but events). */
export async function mirrorScope(
  tx: Exec,
  t: MirrorTarget,
  scope: ShareScope,
  opts: { alerting: MirrorAlerting; onlyChanged?: boolean },
): Promise<void> {
  await mirrorContacts(tx, t, scope, opts);
  await mirrorOpportunities(tx, t, scope, { onlyChanged: opts.onlyChanged });
  await mirrorTransitions(tx, t, scope);
  await mirrorTagHistory(tx, t, scope);
}

/* ------------------------------------------------------------------ *
 * The split
 * ------------------------------------------------------------------ */

/** A person newly counted for a client because of its tag — the only kind that alerts. */
export interface PlacedLead {
  clientId: string;
  ghlContactId: string;
}

/** A person who arrived over 30 days ago and changed client — audited. */
export interface MovedLead {
  ghlContactId: string;
  from: string;
  to: string | null;
}

export interface SplitOutcome {
  placed: PlacedLead[];
  moved: MovedLead[];
  /** Persons whose counted client changed. */
  changed: number;
}

const emptyOutcome = (): SplitOutcome => ({ placed: [], moved: [], changed: 0 });

function mergeOutcome(into: SplitOutcome, more: SplitOutcome): SplitOutcome {
  into.placed.push(...more.placed);
  into.moved.push(...more.moved);
  into.changed += more.changed;
  return into;
}

const MOVED_LATE_MS = 30 * 86_400_000;

export interface Verdict {
  ghlContactId: string;
  winner: string | null;
  reason: ShareReason;
  /** The client counting this person before the split, and why. */
  before: { clientId: string; reason: ShareReason | null } | null;
  createdAt: Date;
}

/**
 * Decide, under `rules`, who counts each of the holder's contacts in scope.
 * Read-only; `applyVerdicts` writes them. The preview runs this same function
 * with the rules being proposed.
 */
export async function decideScope(
  tx: Exec,
  share: Pick<Share, "installationId" | "holder">,
  rules: ShareRules,
  gids: readonly string[] | null,
): Promise<Verdict[]> {
  const splitTags = [...new Set([...rules.tags.values()].flat())];
  const inScope = gids ? sql`AND hc.ghl_contact_id = ANY(${textArray(gids)})` : sql``;
  const found = rows<{
    gid: string;
    tags: string[] | null;
    fetched: string | Date | null;
    created: string | Date;
    counted_client: string | null;
    counted_reason: string | null;
    history: Record<string, string> | string | null;
  }>(
    await tx.execute(sql`
      SELECT hc.ghl_contact_id AS gid, hc.tags, hc.attribution_fetched_at AS fetched,
             COALESCE(hc.ghl_created_at, hc.created_at) AS created,
             cur.client_id::text AS counted_client, cur.share_reason AS counted_reason,
             (SELECT jsonb_object_agg(h.tag, h.first_seen_at)
                FROM contact_tag_history h
               WHERE h.contact_id = hc.id AND h.tag = ANY(${textArray(splitTags)})) AS history
        FROM contacts hc
        LEFT JOIN contacts cur
               ON cur.share_installation_id = ${share.installationId}
              AND cur.ghl_contact_id = hc.ghl_contact_id
              AND cur.share_counted
       WHERE hc.client_id = ${share.holder.id} ${inScope}
    `),
  );
  return found.map((r) => {
    const raw = typeof r.history === "string" ? (JSON.parse(r.history) as Record<string, string>) : r.history;
    const history = new Map(Object.entries(raw ?? {}).map(([tag, at]) => [tag, new Date(at)]));
    const beforeReason = (r.counted_reason as ShareReason | null) ?? null;
    const evidence: SplitEvidence = {
      tags: r.tags,
      history,
      fetchedAt: r.fetched ? new Date(r.fetched) : null,
      createdAt: new Date(r.created),
      owner: r.counted_client && beforeReason && PLACED_BY_TAG.has(beforeReason) ? r.counted_client : null,
    };
    const v = decideSplit(evidence, rules);
    return {
      ghlContactId: r.gid,
      winner: v.clientId,
      reason: v.reason,
      before: r.counted_client ? { clientId: r.counted_client, reason: beforeReason } : null,
      createdAt: evidence.createdAt,
    };
  });
}

/**
 * Write verdicts onto every copy of each person and their cards: losers first,
 * then the winner, so the one-counted-copy index never sees two. A winner
 * with no copy (an archived member, a copy not mirrored yet) counts nowhere.
 * Only rows whose flags change are touched.
 */
export async function applyVerdicts(tx: Exec, installationId: string, verdicts: readonly Verdict[]): Promise<void> {
  for (const chunk of chunks(verdicts, 1000)) {
    const v = sql`unnest(${textArray(chunk.map((x) => x.ghlContactId))}, ${uuidArray(
      chunk.map((x) => x.winner),
    )}, ${textArray(chunk.map((x) => x.reason))}) AS v(gid, winner, reason)`;
    await tx.execute(sql`
      UPDATE contacts c SET share_counted = false, share_reason = v.reason
        FROM ${v}
       WHERE c.share_installation_id = ${installationId} AND c.ghl_contact_id = v.gid
         AND c.client_id IS DISTINCT FROM v.winner
         AND (c.share_counted IS DISTINCT FROM false OR c.share_reason IS DISTINCT FROM v.reason)
    `);
    await tx.execute(sql`
      UPDATE opportunities o SET share_counted = false
        FROM ${v}
       WHERE o.share_installation_id = ${installationId} AND o.ghl_contact_id = v.gid
         AND o.client_id IS DISTINCT FROM v.winner
         AND o.share_counted IS DISTINCT FROM false
    `);
    await tx.execute(sql`
      UPDATE contacts c SET share_counted = true, share_reason = v.reason
        FROM ${v}
       WHERE c.share_installation_id = ${installationId} AND c.ghl_contact_id = v.gid
         AND c.client_id = v.winner
         AND (c.share_counted IS DISTINCT FROM true OR c.share_reason IS DISTINCT FROM v.reason)
    `);
    await tx.execute(sql`
      UPDATE opportunities o SET share_counted = true
        FROM ${v}
       WHERE o.share_installation_id = ${installationId} AND o.ghl_contact_id = v.gid
         AND o.client_id = v.winner
         AND o.share_counted IS DISTINCT FROM true
    `);
  }
}

/**
 * Cards whose contact the holder doesn't hold (or that have none) take the
 * no-tag choice. Only `paid rule: all` and the stage-aging panel ever count
 * them.
 */
export async function splitContactless(
  tx: Exec,
  share: Pick<Share, "installationId" | "holder">,
  untagged: string | null,
  opportunities: readonly string[] | null,
): Promise<void> {
  const scope = opportunities ? sql`AND o.ghl_opportunity_id = ANY(${textArray(opportunities)})` : sql``;
  const orphan = sql`(o.ghl_contact_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM contacts hc WHERE hc.client_id = ${share.holder.id} AND hc.ghl_contact_id = o.ghl_contact_id))`;
  await tx.execute(sql`
    UPDATE opportunities o SET share_counted = false
     WHERE o.share_installation_id = ${share.installationId} AND ${orphan} ${scope}
       AND o.client_id IS DISTINCT FROM ${untagged}::uuid
       AND o.share_counted IS DISTINCT FROM false
  `);
  if (untagged) {
    await tx.execute(sql`
      UPDATE opportunities o SET share_counted = true
       WHERE o.share_installation_id = ${share.installationId} AND ${orphan} ${scope}
         AND o.client_id = ${untagged}
         AND o.share_counted IS DISTINCT FROM true
    `);
  }
}

/**
 * Stamp rows of the share's clients that a writer left unstamped (a delivery
 * that loaded the holder just before it started sharing). They start
 * uncounted, as every new row in a share does; the split then decides them.
 */
async function stampStragglers(tx: Exec, share: Share, scope: ShareScope): Promise<void> {
  const ids = shareClients(share).map((c) => c.id);
  const contactScope = scope.contacts ? sql`AND ghl_contact_id = ANY(${textArray(scope.contacts)})` : sql``;
  await tx.execute(sql`
    UPDATE contacts SET share_installation_id = ${share.installationId}, share_counted = false
     WHERE client_id = ANY(${uuidArray(ids)}) AND share_installation_id IS NULL ${contactScope}
  `);
  await tx.execute(sql`
    UPDATE opportunities o SET share_installation_id = ${share.installationId}, share_counted = false
     WHERE o.client_id = ANY(${uuidArray(ids)}) AND o.share_installation_id IS NULL ${opportunityScope(sql`o`, scope)}
  `);
}

/** What changed, from the verdicts and their "before". */
function outcomeOf(verdicts: readonly Verdict[], share: Share, now: number): SplitOutcome {
  const live = new Set([share.holder, ...liveMembers(share)].map((c) => c.id));
  const out = emptyOutcome();
  for (const v of verdicts) {
    const was = v.before?.clientId ?? null;
    if (was !== v.winner) out.changed++;
    if (
      v.winner &&
      live.has(v.winner) &&
      PLACED_BY_TAG.has(v.reason) &&
      (was !== v.winner || !(v.before?.reason && PLACED_BY_TAG.has(v.before.reason)))
    ) {
      out.placed.push({ clientId: v.winner, ghlContactId: v.ghlContactId });
    }
    if (was && was !== v.winner && now - v.createdAt.getTime() > MOVED_LATE_MS) {
      out.moved.push({ ghlContactId: v.ghlContactId, from: was, to: v.winner });
    }
  }
  return out;
}

/**
 * Split the people in scope: stamp stragglers, decide, write, and rebuild the
 * tag stand-ins of every client counted by tags. Inside a transaction holding
 * `lockShare`.
 */
export async function splitScope(tx: Exec, locked: LockedShare, scope: ShareScope): Promise<SplitOutcome> {
  const { share } = locked;
  const rules = shareRules(share);
  await stampStragglers(tx, share, scope);
  const verdicts = await decideScope(tx, share, rules, scope.contacts);
  await applyVerdicts(tx, share.installationId, verdicts);
  if (scope.contacts === null || scope.opportunities) {
    await splitContactless(tx, share, rules.untagged, scope.contacts === null ? null : scope.opportunities ?? []);
  }
  await projectTagClients(tx, locked, scope.contacts);
  return outcomeOf(verdicts, share, Date.now());
}

/** Rebuild the scope's stand-ins for every client in the share counted by tags. */
async function projectTagClients(tx: Exec, locked: LockedShare, gids: readonly string[] | null): Promise<void> {
  for (const c of shareClients(locked.share)) {
    const mode = locked.modes.get(c.id);
    if (!mode || mode.mode !== "tags") continue;
    let ids: string[] | null = null;
    if (gids) {
      if (gids.length === 0) continue;
      ids = rows<{ id: string }>(
        await tx.execute(sql`
          SELECT id::text AS id FROM contacts WHERE client_id = ${c.id} AND ghl_contact_id = ANY(${textArray(gids)})
        `),
      ).map((r) => r.id);
      if (ids.length === 0) continue;
    }
    await projectAndWrite(tx as Tx, c.id, ids, mode.everyContact);
  }
}

/* ------------------------------------------------------------------ *
 * The live path: one delivery
 * ------------------------------------------------------------------ */

export interface DeliveryScope {
  ghlContactIds?: readonly (string | null | undefined)[];
  ghlOpportunityIds?: readonly (string | null | undefined)[];
  /** The holder's webhook_events row, copied to every member. */
  eventId?: string | null;
}

/** Timeouts for a transaction on GoHighLevel's request path. */
async function boundWaits(tx: Exec): Promise<void> {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
}

/**
 * After the holder processed a delivery: copy what it wrote to every live
 * member, then split the people it touched. One transaction under the share's
 * locks. Returns the people a tag newly placed, for alerts.
 *
 * Never throws for a share that no longer exists. A failure leaves new rows
 * uncounted (never double counted) for the hourly sweep to repair.
 */
export async function syncShare(installationId: string, scope: DeliveryScope): Promise<SplitOutcome> {
  const contactIds = [...new Set((scope.ghlContactIds ?? []).filter((x): x is string => Boolean(x)))];
  const oppIds = [...new Set((scope.ghlOpportunityIds ?? []).filter((x): x is string => Boolean(x)))];
  return db.transaction(async (tx) => {
    await boundWaits(tx);
    const locked = await lockShare(tx, installationId);
    if (!locked) return emptyOutcome();
    const { share } = locked;

    // A card's contact is in scope too: its verdict is the person's.
    if (oppIds.length > 0) {
      const extra = rows<{ gid: string }>(
        await tx.execute(sql`
          SELECT DISTINCT ghl_contact_id AS gid FROM opportunities
           WHERE client_id = ${share.holder.id} AND ghl_opportunity_id = ANY(${textArray(oppIds)})
             AND ghl_contact_id IS NOT NULL
        `),
      );
      for (const r of extra) if (!contactIds.includes(r.gid)) contactIds.push(r.gid);
    }
    const shareScope: ShareScope = { contacts: contactIds, opportunities: oppIds };
    const members = liveMembers(share);
    for (const m of members) {
      const t = { holderId: share.holder.id, memberId: m.id, installationId };
      // The event first, so a copied stage move can point at its copy.
      if (scope.eventId) await mirrorEvents(tx, t, { eventIds: [scope.eventId] });
      await mirrorStages(tx, t);
      await mirrorScope(tx, t, shareScope, { alerting: "live" });
    }
    if (scope.eventId) await copyWebhookMarkers(tx, share.holder.id, members.map((m) => m.id));
    return splitScope(tx, locked, shareScope);
  });
}

/**
 * A delivery that writes no lead rows (an app install, a message): copy the
 * event, and for a message the first-touch / first-call times it set on the
 * holder's contact, to every live member.
 */
export async function copyShareEvent(
  installationId: string,
  eventId: string,
  ghlContactId?: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await boundWaits(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ghl-share:${installationId}`}, 0))`);
    const share = await loadShare(tx, installationId);
    if (!share) return;
    const members = liveMembers(share);
    for (const m of members) {
      await mirrorEvents(tx, { holderId: share.holder.id, memberId: m.id, installationId }, { eventIds: [eventId] });
    }
    if (ghlContactId && members.length > 0) {
      await tx.execute(sql`
        UPDATE contacts m
           SET first_touch_at = COALESCE(m.first_touch_at, h.first_touch_at),
               first_call_at = COALESCE(m.first_call_at, h.first_call_at),
               updated_at = h.updated_at
          FROM contacts h
         WHERE h.client_id = ${share.holder.id} AND h.ghl_contact_id = ${ghlContactId}
           AND m.share_installation_id = ${installationId}
           AND m.client_id = ANY(${uuidArray(members.map((x) => x.id))})
           AND m.ghl_contact_id = h.ghl_contact_id
      `);
    }
    await copyWebhookMarkers(tx, share.holder.id, members.map((m) => m.id));
  });
}

/* ------------------------------------------------------------------ *
 * Whole-share passes
 * ------------------------------------------------------------------ */

export const SPLIT_BATCH = 1000;

/**
 * Split every person in the share — after a link, a tag save, a stop, an
 * archive or unarchive, Re-split now, or when the sweep finds the rules
 * changed since the last full split.
 *
 * Batches of the holder's contacts, each its own short transaction under the
 * share's locks, so live deliveries are never held up for long. With `mirror`
 * each batch is first re-copied to every live member (unarchive, Re-split now).
 * The last batch splits the cards with no contact and records the version the
 * pass started from.
 */
export async function fullSplit(
  installationId: string,
  opts: { mirror?: boolean; deadline?: number } = {},
): Promise<SplitOutcome & { complete: boolean }> {
  const out = emptyOutcome();
  const startVersion = rows<{ v: number }>(
    await db.execute(sql`
      SELECT c.ghl_share_version AS v FROM ghl_installations i JOIN clients c ON c.id = i.client_id
       WHERE i.id = ${installationId}
    `),
  )[0]?.v;
  let after: string | null = null;
  for (;;) {
    if (opts.deadline && Date.now() > opts.deadline) return { ...out, complete: false };
    const step: { done: boolean; outcome: SplitOutcome } = await db.transaction(async (tx) => {
      await boundWaits(tx);
      const locked = await lockShare(tx, installationId);
      if (!locked) return { done: true, outcome: emptyOutcome() };
      const { share } = locked;
      const batch = rows<{ gid: string }>(
        await tx.execute(sql`
          SELECT ghl_contact_id AS gid FROM contacts
           WHERE client_id = ${share.holder.id} ${after ? sql`AND ghl_contact_id > ${after}` : sql``}
           ORDER BY ghl_contact_id
           LIMIT ${SPLIT_BATCH}
        `),
      ).map((r) => r.gid);
      if (opts.mirror) {
        for (const m of liveMembers(share)) {
          const t = { holderId: share.holder.id, memberId: m.id, installationId };
          if (after === null) await mirrorStages(tx, t);
          if (batch.length > 0) await mirrorScope(tx, t, { contacts: batch }, { alerting: "history", onlyChanged: true });
        }
      }
      if (batch.length === 0) {
        // The end: cards with no contact, mirrored and split, then the version.
        if (opts.mirror) {
          for (const m of liveMembers(share)) {
            const t = { holderId: share.holder.id, memberId: m.id, installationId };
            await mirrorOpportunities(tx, t, { contacts: null }, { onlyChanged: true });
            await mirrorTransitions(tx, t, { contacts: null });
          }
        }
        await stampStragglers(tx, share, { contacts: null });
        await splitContactless(tx, share, shareRules(share).untagged, null);
        if (startVersion !== undefined) {
          await tx.execute(sql`
            UPDATE clients SET ghl_share_split_version = ${startVersion}
             WHERE id = ${share.holder.id} AND ghl_share_split_version < ${startVersion}
          `);
        }
        return { done: true, outcome: emptyOutcome() };
      }
      const outcome = await splitScope(tx, locked, { contacts: batch, opportunities: null });
      after = batch[batch.length - 1];
      return { done: false, outcome };
    });
    mergeOutcome(out, step.outcome);
    if (step.done) return { ...out, complete: true };
  }
}
