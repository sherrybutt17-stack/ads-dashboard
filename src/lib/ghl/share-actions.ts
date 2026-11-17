import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { clients, users, type Client } from "@/db/schema";
import { record } from "@/lib/audit";
import { alertNewLead } from "@/lib/alerts/send";
import type { DateWindow } from "@/lib/dates";
import { trailingWindowInclusive } from "@/lib/dates";
import { FUNNEL_TRANSITIONS } from "@/lib/metrics/ledger";
import { paidLeadPredicate } from "@/lib/metrics/queries";
import { clientTags, lockClient, seedTagHistory } from "@/lib/tag-funnel";
import { reclassifyTransitions } from "./backfill";
import {
  applyVerdicts,
  copyWebhookMarkers,
  decideScope,
  fullSplit,
  liveMembers,
  loadShare,
  loadShareForClient,
  lockShare,
  mirrorEvents,
  mirrorOpportunities,
  mirrorScope,
  mirrorStages,
  mirrorTagHistory,
  mirrorTransitions,
  shareClients,
  splitContactless,
  type MovedLead,
  type PlacedLead,
  type Share,
  type Verdict,
} from "./share";
import {
  MAX_SHARE_CLIENTS,
  validateShareRules,
  wouldCountLeads,
  type ShareRules,
  type ShareRulesInput,
} from "./share-rule";

/**
 * "Share this sub-account" — what the buttons do. The engine (copying and
 * splitting) is `./share.ts`; the rule is `./share-rule.ts`.
 *
 * Who may do what: the agency decides — its own logins (Reflexion's Salman and
 * RJ) and Growth Guild add a client to a share, stop sharing and change which
 * tag belongs to which client, for their own agency's clients only. The routes
 * enforce the role and the tenant; these functions check everything else.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<Tx, "execute">;

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

const uuidArray = (values: readonly string[]) => sql`${sql.param([...values])}::uuid[]`;

/** A refusal the person can act on, shown verbatim. */
export class ShareError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Who did it, for the audit trail: `audit_log` has no actor column. */
export interface ShareActor {
  userId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

async function actorMetadata(actor: ShareActor): Promise<{ byUserId: string | null; byEmail: string | null }> {
  if (!actor.userId || actor.userId === "shared") return { byUserId: actor.userId, byEmail: null };
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, actor.userId)).limit(1);
  return { byUserId: actor.userId, byEmail: u?.email ?? null };
}

async function loadClient(id: string): Promise<Client | null> {
  const [c] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  return c ?? null;
}

/* ------------------------------------------------------------------ *
 * Counting, for the preview and the "done" message
 * ------------------------------------------------------------------ */

export const PREVIEW_DAYS = 30;

/**
 * A client's paid new leads in a window, the way the Leads tile counts them:
 * distinct opportunities entering New lead through the client's own funnel
 * (its mode, its share flags), under its own paid-lead rule. Runs on `exec`,
 * so inside a preview transaction it sees the proposed flags.
 */
async function paidNewLeads(
  exec: Exec,
  client: Pick<Client, "id" | "paidLeadFilter" | "paidLeadTag">,
  window: DateWindow,
): Promise<number> {
  const paid = paidLeadPredicate({ mode: client.paidLeadFilter, tag: client.paidLeadTag });
  const [r] = rows<{ n: number }>(
    await exec.execute(sql`
      SELECT COUNT(DISTINCT st.opportunity_id)::int AS n
        FROM ${FUNNEL_TRANSITIONS} st
        ${paid ? sql`JOIN contacts c ON c.id = st.contact_id` : sql``}
       WHERE st.client_id = ${client.id}
         AND st.to_canonical::text = 'new_lead'
         AND st.changed_at >= ${window.startUtc}
         AND st.changed_at < ${window.endUtc}
         ${paid ? sql`AND ${paid}` : sql``}
    `),
  );
  return Number(r?.n ?? 0);
}

/** The GHL contact ids behind those leads, with each one's campaign ids. */
async function paidNewLeadContacts(
  exec: Exec,
  client: Pick<Client, "id" | "paidLeadFilter" | "paidLeadTag">,
  window: DateWindow,
): Promise<{ gid: string; meta: string | null; google: string | null }[]> {
  const paid = paidLeadPredicate({ mode: client.paidLeadFilter, tag: client.paidLeadTag });
  return rows<{ gid: string; meta: string | null; google: string | null }>(
    await exec.execute(sql`
      SELECT DISTINCT c.ghl_contact_id AS gid, c.meta_campaign_id AS meta, c.google_campaign_id AS google
        FROM ${FUNNEL_TRANSITIONS} st
        JOIN contacts c ON c.id = st.contact_id
       WHERE st.client_id = ${client.id}
         AND st.to_canonical::text = 'new_lead'
         AND st.changed_at >= ${window.startUtc}
         AND st.changed_at < ${window.endUtc}
         ${paid ? sql`AND ${paid}` : sql``}
    `),
  );
}

/* ------------------------------------------------------------------ *
 * The preview
 * ------------------------------------------------------------------ */

export interface SharePreviewClient {
  id: string;
  name: string;
  /** Paid leads in the window as this dashboard counts them now. */
  now: number;
  /** …and after the save. */
  after: number;
}

export interface SharePreview {
  days: number;
  clients: SharePreviewClient[];
  /** The holder's whole sub-account in the window, by where each lead goes. */
  breakdown: {
    total: number;
    byClient: { id: string; name: string; tagged: number }[];
    untagged: number;
    untaggedTo: { id: string; name: string } | null;
  };
  /** Leads carrying two clients' tags: kept with their client, or both at once. */
  twoTags: { stays: number; atOnce: number };
  /** Leads whose client's tag was removed and that stay with that client. */
  kept: number;
  /** Leads that arrived over 30 days ago and change client, history and all. */
  movedLate: number;
  /** Leads that will count for one client but came from another's ads. */
  adMismatch: { clientId: string; fromClientId: string; count: number }[];
}

/** Thrown to roll the preview back; never escapes this file. */
class PreviewDone extends Error {}

interface PreviewInput {
  /** The share as it is; null when the holder doesn't share yet. */
  share: Share | null;
  holder: Client;
  /** Clients in the proposal, holder included, in display order. */
  clients: Pick<Client, "id" | "name" | "paidLeadFilter" | "paidLeadTag">[];
  /** A client being added (not in the share yet): counted on the holder's copy, with its settings. */
  adding: Pick<Client, "id" | "name"> | null;
  rules: ShareRules;
}

/**
 * Before/after counts for a proposal, from the same function and the same
 * rows the save will use — inside a transaction that is always rolled back,
 * so nothing is written.
 *
 * A client being added has no copy yet; it will inherit the holder's copy and
 * the holder's settings, so its "after" is the holder's count of the people
 * the rules give it.
 */
async function previewProposal(input: PreviewInput): Promise<SharePreview> {
  const { holder, rules } = input;
  const window = trailingWindowInclusive(PREVIEW_DAYS, holder.timezone);
  const installationId = input.share?.installationId ?? null;
  const out: SharePreview = {
    days: PREVIEW_DAYS,
    clients: [],
    breakdown: { total: 0, byClient: [], untagged: 0, untaggedTo: null },
    twoTags: { stays: 0, atOnce: 0 },
    kept: 0,
    movedLate: 0,
    adMismatch: [],
  };

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
      const now = new Map<string, number>();
      for (const c of input.clients) now.set(c.id, input.adding?.id === c.id ? 0 : await paidNewLeads(tx, c, window));

      // A first share reads tag history as the link will leave it: seeded.
      if (!input.share) await seedTagHistory(tx, holder.id);

      // 🔴 Decide FIRST, while the current owners are still on the rows: the
      // save keeps a lead with the client it counts for (R2/R3), so the
      // preview must see the same owners or it would promise a different split.
      const I = installationId ?? "00000000-0000-0000-0000-000000000000";
      const holderRef = { installationId: I, holder: { id: holder.id } as Share["holder"] };
      const verdicts = await decideScope(tx, holderRef, rules, null);
      const byGid = new Map(verdicts.map((v) => [v.ghlContactId, v]));

      // The pretend share: the holder's rows stamped, every flag cleared, so
      // the holder's whole sub-account counts once — the "total".
      await tx.execute(sql`
        UPDATE contacts SET share_installation_id = ${I}, share_counted = NULL
         WHERE client_id = ${holder.id}
      `);
      await tx.execute(sql`
        UPDATE opportunities SET share_installation_id = ${I}, share_counted = NULL
         WHERE client_id = ${holder.id}
      `);
      const whole = await paidNewLeadContacts(tx, holder, window);

      // Breakdown of the window's leads.
      out.breakdown.total = whole.length;
      const tagged = new Map<string, number>();
      for (const w of whole) {
        const v = byGid.get(w.gid);
        if (!v) continue;
        if (v.reason === "tag" || v.reason === "first_tag" || v.reason === "kept") {
          if (v.winner) tagged.set(v.winner, (tagged.get(v.winner) ?? 0) + 1);
        } else {
          out.breakdown.untagged++;
        }
        if (v.reason === "first_tag" && v.before?.clientId === v.winner) out.twoTags.stays++;
        if (v.reason === "both_tags") out.twoTags.atOnce++;
        if (v.reason === "kept") out.kept++;
      }
      out.breakdown.byClient = input.clients.map((c) => ({ id: c.id, name: c.name, tagged: tagged.get(c.id) ?? 0 }));
      const untaggedTo = input.clients.find((c) => c.id === rules.untagged);
      out.breakdown.untaggedTo = untaggedTo ? { id: untaggedTo.id, name: untaggedTo.name } : null;
      const cutoff = Date.now() - 30 * 86_400_000;
      out.movedLate = verdicts.filter(
        (v) => v.before && v.before.clientId !== v.winner && v.createdAt.getTime() < cutoff,
      ).length;

      // Ads one client paid for, counted on another: a warning, never a route.
      const campaigns = rows<{ client_id: string; meta: string[] | null; google: string[] | null }>(
        await tx.execute(sql`
          SELECT c.id::text AS client_id,
                 (SELECT array_agg(DISTINCT m.meta_campaign_id) FROM fb_daily_metrics m
                   WHERE m.client_id = c.id AND m.level::text = 'campaign' AND m.meta_campaign_id <> '') AS meta,
                 (SELECT array_agg(DISTINCT g.google_campaign_id) FROM google_daily_metrics g
                   WHERE g.client_id = c.id) AS google
            FROM clients c WHERE c.id = ANY(${uuidArray(input.clients.map((c) => c.id))})
        `),
      );
      const ownMeta = new Map(campaigns.map((r) => [r.client_id, new Set(r.meta ?? [])]));
      const ownGoogle = new Map(campaigns.map((r) => [r.client_id, new Set(r.google ?? [])]));
      const mismatch = new Map<string, number>();
      for (const w of whole) {
        const winner = byGid.get(w.gid)?.winner;
        if (!winner) continue;
        const ranBy = (own: Map<string, Set<string>>, id: string | null) =>
          id ? [...own].filter(([, set]) => set.has(id)).map(([client]) => client) : [];
        for (const [own, id] of [
          [ownMeta, w.meta],
          [ownGoogle, w.google],
        ] as const) {
          const runners = ranBy(own, id);
          if (runners.length > 0 && !runners.includes(winner)) {
            const key = `${winner}|${runners[0]}`;
            mismatch.set(key, (mismatch.get(key) ?? 0) + 1);
            break;
          }
        }
      }
      out.adMismatch = [...mismatch].map(([k, count]) => {
        const [clientId, fromClientId] = k.split("|");
        return { clientId, fromClientId, count };
      });

      // After: the proposal applied to every copy that exists.
      await applyVerdicts(tx, I, verdicts);
      await splitContactless(tx, holderRef, rules.untagged, null);
      const after = new Map<string, number>();
      for (const c of input.clients) {
        if (input.adding?.id === c.id) continue;
        after.set(c.id, await paidNewLeads(tx, c, window));
      }
      // The client being added: the holder's copy, flagged as if it were its own.
      if (input.adding) {
        const adding = input.adding.id;
        await applyVerdicts(
          tx,
          I,
          verdicts.map((v) => ({ ...v, winner: v.winner === adding ? holder.id : null })),
        );
        await splitContactless(tx, holderRef, rules.untagged === adding ? holder.id : null, null);
        after.set(adding, await paidNewLeads(tx, holder, window));
      }
      out.clients = input.clients.map((c) => ({
        id: c.id,
        name: c.name,
        now: now.get(c.id) ?? 0,
        after: after.get(c.id) ?? 0,
      }));
      throw new PreviewDone();
    });
  } catch (err) {
    if (!(err instanceof PreviewDone)) throw err;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Adding a client
 * ------------------------------------------------------------------ */

interface LinkPlan {
  holder: Client;
  target: Client;
  installationId: string;
  share: Share | null;
  /** Every client in the proposal, holder first. */
  clients: Client[];
  rules: ShareRules;
}

/**
 * Everything that must hold before a client is added, checked against the
 * database as it is now (the link re-checks the installation under its locks).
 */
async function planLink(holderId: string, targetId: string, input: ShareRulesInput): Promise<LinkPlan> {
  const holder = await loadClient(holderId);
  const target = await loadClient(targetId);
  if (!holder || !target) throw new ShareError(404, "Client not found.");
  if (holder.id === target.id) throw new ShareError(400, "Pick another client to share with.");
  if (holder.agencyId !== target.agencyId) {
    throw new ShareError(400, "Only clients of the same agency can share a sub-account.");
  }
  if (holder.status === "archived" || target.status === "archived") {
    throw new ShareError(409, "An archived client can't share a sub-account.");
  }

  const installs = rows<{ id: string; location_id: string; uninstalled_at: string | null }>(
    await db.execute(sql`
      SELECT id::text AS id, location_id, uninstalled_at FROM ghl_installations WHERE client_id = ${holder.id}
    `),
  );
  const live = installs.filter((i) => !i.uninstalled_at);
  if (installs.length > 0 && live.length === 0) {
    throw new ShareError(409, "The app was uninstalled from this sub-account. Reconnect it first.");
  }
  if (live.length !== 1 || live[0].location_id !== holder.ghlLocationId) {
    throw new ShareError(
      409,
      `${holder.name} must be connected to exactly one GoHighLevel sub-account through the app before it can share it. Reconnect it, then try again.`,
    );
  }
  const installationId = live[0].id;

  let share: Share | null = null;
  if (holder.ghlShareInstallationId) {
    share = await loadShare(db, holder.ghlShareInstallationId);
    if (!share || share.holder.id !== holder.id) {
      throw new ShareError(409, `${holder.name} gets its leads from another client's shared sub-account.`);
    }
    if (share.installationId !== installationId) {
      throw new ShareError(409, "This sub-account's connection changed. Reload the page and try again.");
    }
    if (shareClients(share).length >= MAX_SHARE_CLIENTS) {
      throw new ShareError(409, `A sub-account can be shared with at most ${MAX_SHARE_CLIENTS} clients.`);
    }
  }
  if (target.ghlShareInstallationId) throw new ShareError(409, `${target.name} already shares a sub-account.`);

  // v1: the client being added has no GoHighLevel of its own — only copies an
  // unfinished earlier link of this same share left behind.
  const [own] = rows<{ installs: number; stages: number; contacts: number; events: number }>(
    await db.execute(sql`
      SELECT (SELECT COUNT(*)::int FROM ghl_installations WHERE client_id = ${target.id}) AS installs,
             (SELECT COUNT(*)::int FROM pipeline_stages s WHERE s.client_id = ${target.id}
                 AND NOT EXISTS (SELECT 1 FROM pipeline_stages h WHERE h.client_id = ${holder.id} AND h.ghl_stage_id = s.ghl_stage_id)) AS stages,
             (SELECT COUNT(*)::int FROM contacts WHERE client_id = ${target.id}
                 AND share_installation_id IS DISTINCT FROM ${installationId}::uuid) AS contacts,
             (SELECT COUNT(*)::int FROM webhook_events WHERE client_id = ${target.id}
                 AND headers->>'__sharedFrom' IS DISTINCT FROM ${installationId}) AS events
    `),
  );
  if (target.ghlLocationId || own.installs > 0 || own.stages > 0 || own.contacts > 0 || own.events > 0) {
    throw new ShareError(
      409,
      `${target.name} has its own GoHighLevel connection or leads, so it can't take this sub-account's leads too yet.`,
    );
  }

  const members = share ? liveMembers(share).map((m) => m.id) : [];
  const clientRows = [holder, ...(await Promise.all(members.map(loadClient))).filter((c): c is Client => Boolean(c)), target];
  const validated = validateShareRules(input, {
    clients: new Map(clientRows.map((c) => [c.id, c.name])),
    knownTags: new Set((await clientTags(holder.id, { all: true })).map((t) => t.tag)),
  });
  if (!validated.ok) throw new ShareError(400, validated.error);
  if (!wouldCountLeads(validated.rules, target.id)) {
    throw new ShareError(400, `Pick ${target.name}'s tag first, or give it the leads with no client's tag.`);
  }
  return { holder, target, installationId, share, clients: clientRows, rules: withArchived(share, validated.rules) };
}

export async function previewLink(holderId: string, targetId: string, input: ShareRulesInput): Promise<SharePreview> {
  const plan = await planLink(holderId, targetId, input);
  return previewProposal({
    share: plan.share,
    holder: plan.holder,
    clients: plan.clients,
    adding: plan.target,
    rules: plan.rules,
  });
}

const COPY_BATCH = 2000;
const EVENT_BATCH = 5000;

/**
 * Add a client to the holder's sub-account.
 *
 *  1. Check everything (`planLink`).
 *  2. Give the client the holder's lead settings: mode, tag mapping, paid rule.
 *  3. Seed the holder's tag history, so the first split has dates to read.
 *  4. Copy the holder's rows in batches, each its own short transaction, all
 *     uncounted — the new client shows nothing until the split.
 *  5. One transaction under the installation and holder row locks: re-check
 *     the connection, join both clients to the share, save the rules, catch up
 *     on rows written during the copy.
 *  6. Split every person, then audit.
 *
 * Safe to repeat after a failure: every copy is an upsert, and a half-copied
 * client counts nothing until step 5 commits.
 */
export async function linkClient(
  holderId: string,
  targetId: string,
  input: ShareRulesInput,
  actor: ShareActor,
): Promise<{ leads: number }> {
  const plan = await planLink(holderId, targetId, input);
  const { holder, target, installationId: I } = plan;

  // 2. Lead settings.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE clients t SET crm_mapping_mode = h.crm_mapping_mode, tag_lead_every_contact = h.tag_lead_every_contact,
                           tag_mapping_allowed = h.tag_mapping_allowed, paid_lead_filter = h.paid_lead_filter,
                           paid_lead_tag = h.paid_lead_tag, updated_at = now()
        FROM clients h WHERE h.id = ${holder.id} AND t.id = ${target.id}
    `);
    await tx.execute(sql`DELETE FROM tag_stage_mappings WHERE client_id = ${target.id}`);
    await tx.execute(sql`
      INSERT INTO tag_stage_mappings (client_id, tag, canonical_stage)
      SELECT ${target.id}, tag, canonical_stage FROM tag_stage_mappings WHERE client_id = ${holder.id}
    `);
  });

  // 3. Tag history dates for the split.
  await db.transaction(async (tx) => {
    await lockClient(tx, holder.id);
    await seedTagHistory(tx, holder.id);
  });

  // 4. Batched copy, uncounted.
  const copyStart = new Date();
  const t = { holderId: holder.id, memberId: target.id, installationId: I };
  let afterEvent: string | null = null;
  for (;;) {
    const last: string | null = await db.transaction((tx) =>
      mirrorEvents(tx, t, { limit: EVENT_BATCH, afterId: afterEvent }),
    );
    if (!last || last === afterEvent) break;
    afterEvent = last;
  }
  await db.transaction((tx) => mirrorStages(tx, t));
  let afterContact: string | null = null;
  for (;;) {
    const batch: string[] = rows<{ gid: string }>(
      await db.execute(sql`
        SELECT ghl_contact_id AS gid FROM contacts
         WHERE client_id = ${holder.id} ${afterContact ? sql`AND ghl_contact_id > ${afterContact}` : sql``}
         ORDER BY ghl_contact_id LIMIT ${COPY_BATCH}
      `),
    ).map((r) => r.gid);
    if (batch.length === 0) break;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE contacts SET share_installation_id = ${I}
         WHERE client_id = ${holder.id} AND share_installation_id IS NULL
           AND ghl_contact_id = ANY(${sql.param(batch)}::text[])
      `);
      await tx.execute(sql`
        UPDATE opportunities SET share_installation_id = ${I}
         WHERE client_id = ${holder.id} AND share_installation_id IS NULL
           AND ghl_contact_id = ANY(${sql.param(batch)}::text[])
      `);
      await mirrorScope(tx, t, { contacts: batch }, { alerting: "history" });
    });
    afterContact = batch[batch.length - 1];
  }
  // Cards with no contact, and their moves.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE opportunities SET share_installation_id = ${I}
       WHERE client_id = ${holder.id} AND share_installation_id IS NULL
    `);
    await mirrorOpportunities(tx, t, { contacts: null }, { onlyChanged: true });
    await mirrorTransitions(tx, t, { contacts: null });
  });

  // 5. Bind.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    const [inst] = rows<{ client_id: string | null; location_id: string; uninstalled_at: string | null }>(
      await tx.execute(sql`
        SELECT client_id::text AS client_id, location_id, uninstalled_at
          FROM ghl_installations WHERE id = ${I} FOR UPDATE
      `),
    );
    const [h] = rows<{ location: string | null; share: string | null }>(
      await tx.execute(sql`
        SELECT ghl_location_id AS location, ghl_share_installation_id::text AS share
          FROM clients WHERE id = ${holder.id} FOR UPDATE
      `),
    );
    const [tg] = rows<{ share: string | null }>(
      await tx.execute(sql`SELECT ghl_share_installation_id::text AS share FROM clients WHERE id = ${target.id} FOR UPDATE`),
    );
    if (!inst || inst.client_id !== holder.id || inst.uninstalled_at || inst.location_id !== h?.location) {
      throw new ShareError(
        409,
        `${holder.name} must be connected to exactly one GoHighLevel sub-account through the app before it can share it. Reconnect it, then try again.`,
      );
    }
    if (h.share && h.share !== I) throw new ShareError(409, "This sub-account's connection changed. Reload the page and try again.");
    if (tg?.share) throw new ShareError(409, `${target.name} already shares a sub-account.`);

    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ghl-share:${I}`}, 0))`);
    for (const id of plan.clients.map((c) => c.id).sort()) await lockClient(tx, id);

    await tx.execute(sql`
      UPDATE clients SET ghl_share_installation_id = ${I}, ghl_share_since = COALESCE(ghl_share_since, now())
       WHERE id IN (${holder.id}, ${target.id})
    `);
    await writeRules(tx, holder.id, plan.clients.map((c) => c.id), plan.rules);
    await copyWebhookMarkers(tx, holder.id, [target.id]);

    // Catch up on what the holder wrote while the copy ran.
    const changed = rows<{ gid: string }>(
      await tx.execute(sql`
        SELECT ghl_contact_id AS gid FROM contacts
         WHERE client_id = ${holder.id} AND updated_at >= ${copyStart}
      `),
    ).map((r) => r.gid);
    await mirrorEvents(tx, t, { since: copyStart });
    if (changed.length > 0) await mirrorScope(tx, t, { contacts: changed }, { alerting: "history" });
    await mirrorTagHistory(tx, t, { contacts: null });
  });

  // 6. Split, and say so.
  const outcome = await fullSplit(I);
  const meta = await actorMetadata(actor);
  for (const [clientId, other] of [
    [holder.id, target.name],
    [target.id, holder.name],
  ] as const) {
    await record({
      action: "ghl_share.add",
      targetType: "client",
      targetId: target.id,
      clientId,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        ...meta,
        holder: holder.name,
        added: target.name,
        with: other,
        rules: rulesForAudit(plan.rules),
      },
    });
  }
  await auditMoves(outcome.moved, plan.clients);

  const window = trailingWindowInclusive(PREVIEW_DAYS, holder.timezone);
  const fresh = await loadClient(target.id);
  return { leads: fresh ? await paidNewLeads(db, fresh, window) : 0 };
}

/** Write each client's tags, the no-tag choice and the keep switch, and bump the version. */
async function writeRules(tx: Exec, holderId: string, ids: readonly string[], rules: ShareRules): Promise<void> {
  // Clear first: at most one client of a share takes untagged leads (a unique index).
  await tx.execute(sql`UPDATE clients SET ghl_share_gets_untagged = false WHERE id = ANY(${uuidArray(ids)})`);
  for (const id of ids) {
    await tx.execute(sql`
      UPDATE clients SET ghl_share_tags = ${sql.param(rules.tags.get(id) ?? [])}::text[],
                         ghl_share_gets_untagged = ${rules.untagged === id}, updated_at = now()
       WHERE id = ${id}
    `);
  }
  await tx.execute(sql`
    UPDATE clients SET ghl_share_keep_removed = ${rules.keepRemoved}, ghl_share_version = ghl_share_version + 1
     WHERE id = ${holderId}
  `);
}

function rulesForAudit(rules: ShareRules) {
  return {
    tags: Object.fromEntries(rules.tags),
    untagged: rules.untagged,
    keepRemoved: rules.keepRemoved,
  };
}

async function auditMoves(moved: readonly MovedLead[], known: readonly Pick<Client, "id" | "name">[]): Promise<void> {
  const name = (id: string | null) => known.find((c) => c.id === id)?.name ?? "no client";
  for (const m of moved.slice(0, 200)) {
    for (const clientId of [m.from, m.to].filter((x): x is string => Boolean(x))) {
      await record({
        action: "ghl_share.moved",
        targetType: "contact",
        targetId: m.ghlContactId,
        clientId,
        metadata: { ghlContactId: m.ghlContactId, from: name(m.from), to: name(m.to) },
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Changing the tags
 * ------------------------------------------------------------------ */

async function shareOrThrow(clientId: string): Promise<{ share: Share; holder: Client; live: Client[] }> {
  const share = await loadShareForClient(db, clientId);
  if (!share) throw new ShareError(404, "This client doesn't share a GoHighLevel sub-account.");
  const holder = await loadClient(share.holder.id);
  if (!holder) throw new ShareError(404, "Client not found.");
  const live = [holder, ...(await Promise.all(liveMembers(share).map((m) => loadClient(m.id))))].filter(
    (c): c is Client => Boolean(c),
  );
  return { share, holder, live };
}

async function validatedRules(share: Share, live: Client[], input: ShareRulesInput): Promise<ShareRules> {
  const validated = validateShareRules(input, {
    clients: new Map(live.map((c) => [c.id, c.name])),
    knownTags: new Set((await clientTags(share.holder.id, { all: true })).map((t) => t.tag)),
  });
  if (!validated.ok) throw new ShareError(400, validated.error);
  return withArchived(share, validated.rules);
}

/** Archived members keep their tags: their leads count for no active client, not the no-tag choice. */
function withArchived(share: Share | null, rules: ShareRules): ShareRules {
  if (!share) return rules;
  const tags = new Map(rules.tags);
  for (const m of share.members) if (m.status === "archived") tags.set(m.id, m.tags);
  return { ...rules, tags };
}

export async function previewTags(clientId: string, input: ShareRulesInput): Promise<SharePreview> {
  const { share, holder, live } = await shareOrThrow(clientId);
  const rules = await validatedRules(share, live, input);
  return previewProposal({ share, holder, clients: live, adding: null, rules });
}

export async function saveShareTags(
  clientId: string,
  input: ShareRulesInput,
  version: number,
  actor: ShareActor,
): Promise<{ changed: number; movedLate: number }> {
  const { share, holder, live } = await shareOrThrow(clientId);
  const rules = await validatedRules(share, live, input);
  const window = trailingWindowInclusive(PREVIEW_DAYS, holder.timezone);
  const before = Object.fromEntries(await Promise.all(live.map(async (c) => [c.name, await paidNewLeads(db, c, window)])));

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ghl-share:${share.installationId}`}, 0))`);
    const [h] = rows<{ v: number }>(
      await tx.execute(sql`SELECT ghl_share_version AS v FROM clients WHERE id = ${holder.id} FOR UPDATE`),
    );
    if (Number(h?.v) !== version) {
      throw new ShareError(409, "Someone else just changed these tags. Reload the page to see their change.");
    }
    await writeRules(tx, holder.id, live.map((c) => c.id), rules);
  });

  const outcome = await fullSplit(share.installationId);
  await dispatchShareAlerts(outcome.placed);
  const after = Object.fromEntries(await Promise.all(live.map(async (c) => [c.name, await paidNewLeads(db, c, window)])));
  const meta = await actorMetadata(actor);
  for (const c of live) {
    await record({
      action: "ghl_share.tags",
      targetType: "client",
      targetId: holder.id,
      clientId: c.id,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        ...meta,
        holder: holder.name,
        rules: rulesForAudit(rules),
        leadsBefore: before,
        leadsAfter: after,
        movedLate: outcome.moved.length,
      },
    });
  }
  await auditMoves(outcome.moved, live);
  return { changed: outcome.changed, movedLate: outcome.moved.length };
}

/* ------------------------------------------------------------------ *
 * Stopping
 * ------------------------------------------------------------------ */

/**
 * Take a member out of the share: its copies are deleted (the holder keeps
 * the originals, and sharing again recreates them), its leads are re-split
 * among the clients left, and when only the holder remains every flag is
 * cleared — the holder's numbers are then exactly what they were before.
 */
export async function stopSharing(memberId: string, actor: ShareActor): Promise<{ holderOnly: boolean }> {
  const share = await loadShareForClient(db, memberId);
  if (!share) throw new ShareError(404, "This client doesn't share a GoHighLevel sub-account.");
  if (share.holder.id === memberId) {
    throw new ShareError(400, "This client holds the connection. Stop sharing with each of the other clients instead.");
  }
  const member = share.members.find((m) => m.id === memberId)!;
  const I = share.installationId;

  const holderOnly = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '240s'`);
    const locked = await lockShare(tx, I);
    if (!locked) throw new ShareError(409, "This sub-account is no longer shared. Reload the page.");
    const holderId = locked.share.holder.id;
    if (member.getsUntagged) {
      await tx.execute(sql`UPDATE clients SET ghl_share_gets_untagged = false WHERE id = ${memberId}`);
      await tx.execute(sql`UPDATE clients SET ghl_share_gets_untagged = true WHERE id = ${holderId}`);
    }
    await deleteCopies(tx, memberId, I);
    await tx.execute(sql`
      UPDATE clients SET ghl_share_installation_id = NULL, ghl_share_tags = '{}', ghl_share_gets_untagged = false,
                         ghl_share_since = NULL, first_webhook_at = NULL, last_webhook_at = NULL, updated_at = now()
       WHERE id = ${memberId}
    `);
    await tx.execute(sql`UPDATE clients SET ghl_share_version = ghl_share_version + 1 WHERE id = ${holderId}`);
    const left = locked.share.members.filter((m) => m.id !== memberId);
    if (left.length === 0) {
      await unshareHolder(tx, holderId, I);
      return true;
    }
    return false;
  });

  if (!holderOnly) {
    const outcome = await fullSplit(I);
    await dispatchShareAlerts(outcome.placed);
  }
  const meta = await actorMetadata(actor);
  for (const [clientId, other] of [
    [share.holder.id, member.name],
    [memberId, share.holder.name],
  ] as const) {
    await record({
      action: "ghl_share.remove",
      targetType: "client",
      targetId: memberId,
      clientId,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { ...meta, holder: share.holder.name, removed: member.name, with: other },
    });
  }
  return { holderOnly };
}

/** Delete a client's copies of a sub-account's rows. The holder's originals are untouched. */
async function deleteCopies(tx: Exec, clientId: string, installationId: string | null): Promise<number> {
  const stamped = installationId ? sql`share_installation_id = ${installationId}` : sql`share_counted IS NOT NULL`;
  await tx.execute(sql`
    DELETE FROM stage_transitions
     WHERE client_id = ${clientId}
       AND opportunity_id IN (SELECT id FROM opportunities WHERE client_id = ${clientId} AND ${stamped})
  `);
  await tx.execute(sql`DELETE FROM opportunities WHERE client_id = ${clientId} AND ${stamped}`);
  const [c] = rows<{ n: number }>(
    await tx.execute(sql`
      WITH gone AS (DELETE FROM contacts WHERE client_id = ${clientId} AND ${stamped} RETURNING 1)
      SELECT COUNT(*)::int AS n FROM gone
    `),
  );
  // Tag history goes with its contacts (ON DELETE CASCADE). A member has no
  // stages, cards or events of its own: every one here is a copy.
  await tx.execute(sql`DELETE FROM pipeline_stages WHERE client_id = ${clientId}`);
  await tx.execute(sql`
    DELETE FROM webhook_events WHERE client_id = ${clientId}
       AND ${installationId ? sql`headers->>'__sharedFrom' = ${installationId}` : sql`headers->>'__sharedFrom' IS NOT NULL`}
  `);
  return Number(c?.n ?? 0);
}

/** The holder alone again: every flag cleared, exactly its state before sharing. */
async function unshareHolder(tx: Exec, holderId: string, installationId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE contacts SET share_installation_id = NULL, share_counted = NULL, share_reason = NULL
     WHERE client_id = ${holderId} AND share_installation_id = ${installationId}
  `);
  await tx.execute(sql`
    UPDATE opportunities SET share_installation_id = NULL, share_counted = NULL
     WHERE client_id = ${holderId} AND share_installation_id = ${installationId}
  `);
  await tx.execute(sql`
    UPDATE clients SET ghl_share_installation_id = NULL, ghl_share_tags = '{}', ghl_share_gets_untagged = false,
                       ghl_share_since = NULL, ghl_share_keep_removed = true, updated_at = now()
     WHERE id = ${holderId}
  `);
}

/* ------------------------------------------------------------------ *
 * Re-split now, stages, archive, purge
 * ------------------------------------------------------------------ */

const lastResplit = new Map<string, number>();
const RESPLIT_COOLDOWN_MS = 5 * 60_000;

/**
 * Re-copy and re-split the whole share now, rather than at the hourly check.
 * At most once per five minutes per share on one server; a second run
 * meanwhile would only repeat idempotent work.
 */
export async function resplitShare(clientId: string): Promise<{ changed: number; complete: boolean }> {
  const share = await loadShareForClient(db, clientId);
  if (!share) throw new ShareError(404, "This client doesn't share a GoHighLevel sub-account.");
  const last = lastResplit.get(share.installationId) ?? 0;
  if (Date.now() - last < RESPLIT_COOLDOWN_MS) {
    throw new ShareError(409, "A re-split is already running. Try again in a minute.");
  }
  lastResplit.set(share.installationId, Date.now());
  const outcome = await fullSplit(share.installationId, { mirror: true, deadline: Date.now() + 240_000 });
  await dispatchShareAlerts(outcome.placed);
  return { changed: outcome.changed, complete: outcome.complete };
}

/**
 * After the holder's stage mapping changes: one mapping serves the whole
 * share, so every member's stages take it and their moves are relabelled.
 */
export async function mirrorShareStages(holderId: string): Promise<void> {
  const share = await loadShareForClient(db, holderId);
  if (!share || share.holder.id !== holderId) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ghl-share:${share.installationId}`}, 0))`);
    for (const m of liveMembers(share)) {
      await mirrorStages(tx, { holderId, memberId: m.id, installationId: share.installationId });
    }
  });
  for (const m of liveMembers(share)) await reclassifyTransitions(m.id);
}

/**
 * A member archived or unarchived: the version moves so the sweep re-splits if
 * this run is cut short, and the split runs now. Unarchiving re-copies first.
 */
export async function onMemberStatusChange(clientId: string, status: "archived" | "active"): Promise<void> {
  const share = await loadShareForClient(db, clientId);
  if (!share || share.holder.id === clientId) return;
  await db.execute(sql`UPDATE clients SET ghl_share_version = ghl_share_version + 1 WHERE id = ${share.holder.id}`);
  const outcome = await fullSplit(share.installationId, { mirror: status === "active" });
  await dispatchShareAlerts(outcome.placed);
}

/**
 * Remove the copied leads a client still holds from a sub-account it no longer
 * shares (one that moved to another agency, or an abandoned link). Growth
 */
export async function purgeFormerMember(clientId: string, actor: ShareActor): Promise<{ contacts: number }> {
  const client = await loadClient(clientId);
  if (!client) throw new ShareError(404, "Client not found.");
  if (client.ghlShareInstallationId || client.ghlLocationId) {
    throw new ShareError(409, "This client still has a GoHighLevel connection. Nothing was removed.");
  }
  const [bound] = rows<{ n: number }>(
    await db.execute(sql`SELECT COUNT(*)::int AS n FROM ghl_installations WHERE client_id = ${clientId}`),
  );
  if (Number(bound?.n) > 0) throw new ShareError(409, "This client still has a GoHighLevel connection. Nothing was removed.");
  const removed = await db.transaction(async (tx) => {
    await lockClient(tx, clientId);
    return deleteCopies(tx, clientId, null);
  });
  const meta = await actorMetadata(actor);
  await record({
    action: "ghl_share.purge",
    targetType: "client",
    targetId: clientId,
    clientId,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    metadata: { ...meta, contacts: removed },
  });
  return { contacts: removed };
}

/** Whether a client still holds copies from a sub-account it no longer shares. */
export async function holdsFormerCopies(clientId: string): Promise<number> {
  const [r] = rows<{ n: number }>(
    await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM contacts c
        JOIN clients k ON k.id = c.client_id
       WHERE c.client_id = ${clientId} AND c.share_counted IS NOT NULL AND k.ghl_share_installation_id IS NULL
    `),
  );
  return Number(r?.n ?? 0);
}

/* ------------------------------------------------------------------ *
 * Lifecycle guards
 * ------------------------------------------------------------------ */

export interface ShareRole {
  role: "holder" | "member";
  share: Share;
  holderName: string;
  /** The other live clients' names. */
  others: string[];
}

/** Whether a client holds or receives a shared sub-account, and with whom. */
export async function shareRoleOf(clientId: string): Promise<ShareRole | null> {
  const share = await loadShareForClient(db, clientId);
  if (!share) return null;
  const others = [share.holder, ...liveMembers(share)].filter((c) => c.id !== clientId).map((c) => c.name);
  return {
    role: share.holder.id === clientId ? "holder" : "member",
    share,
    holderName: share.holder.name,
    others,
  };
}

const list = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Removing or archiving the holder would cut every client in the share off,
 * so it is refused until sharing stops.
 */
export async function assertMayArchive(clientId: string): Promise<void> {
  const r = await shareRoleOf(clientId);
  if (!r || r.role !== "holder" || r.others.length === 0) return;
  throw new ShareError(
    409,
    `${r.holderName}'s GoHighLevel sub-account is shared with ${list(r.others)}. ` +
      "Stop sharing before removing or archiving it.",
  );
}

/** A location id typed on a client in a share: never on a member, never changed on the holder. */
export async function assertMaySetLocation(clientId: string): Promise<void> {
  const r = await shareRoleOf(clientId);
  if (!r) return;
  if (r.role === "member") {
    throw new ShareError(
      409,
      `This client gets GoHighLevel through ${r.holderName}'s shared sub-account. Reconnect it from ${r.holderName}'s Connections page.`,
    );
  }
  throw new ShareError(
    409,
    `${r.holderName}'s GoHighLevel sub-account is shared with ${list(r.others)}. Stop sharing before connecting it to another sub-account.`,
  );
}

/* ------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------ */

/**
 * New-lead alerts for people a split outside the webhook path placed by a tag.
 * The usual guards apply — a lead older than six hours, the hourly cap and the
 * one-message claim — so this sends only what a live delivery would have.
 */
export async function dispatchShareAlerts(placed: readonly PlacedLead[]): Promise<number> {
  if (placed.length === 0) return 0;
  const byClient = new Map<string, Client | null>();
  let sent = 0;
  for (const p of placed.slice(0, 500)) {
    if (!byClient.has(p.clientId)) byClient.set(p.clientId, await loadClient(p.clientId));
    const client = byClient.get(p.clientId);
    if (!client || !client.alertsEnabled) continue;
    const r = await alertNewLead(client, p.ghlContactId);
    if (r.sent) sent++;
  }
  return sent;
}

export type { SQL };
export type { Verdict };
