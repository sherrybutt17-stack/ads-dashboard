import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  agencies,
  clients,
  contactTagHistory,
  opportunities,
  stageTransitions,
  tagStageMappings,
  type Client,
  type Contact,
} from "@/db/schema";
import { CANONICAL_STAGES, type CanonicalStage } from "@/lib/stages";
import {
  normalizeTag,
  projectTagLeads,
  tagOpportunityId,
  type TagFunnelContact,
  type TagLead,
  type TagObservation,
} from "./project";

/**
 * Tags mode — the database half. See `./project.ts` for the rules and
 * `src/lib/metrics/ledger.ts` for how every screen reads the result.
 *
 * A tags-mode client's funnel is written into the same two tables a pipeline
 * client's is: one stand-in opportunity per lead (`opportunities.from_tags`),
 * and one `stage_transitions` row per step it reached (`source = 'tag'`). That
 * is what lets the dashboard, Boards, the client list, exports, share links and
 * reports all count tag leads without a second code path each.
 *
 * Unlike pipeline rows, these are derived: rebuilt from `contact_tag_history`
 * and `tag_stage_mappings` whenever either changes. GoHighLevel stage moves
 * keep being recorded for the same client meanwhile, untouched, so switching
 * back to pipeline is lossless.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<Tx, "execute" | "insert">;

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** True when a contact row carries any id an ad platform put there. */
export const FROM_AD = sql`(c.meta_campaign_id IS NOT NULL OR c.facebook_lead_id IS NOT NULL
  OR c.google_campaign_id IS NOT NULL OR c.gclid IS NOT NULL
  OR c.tiktok_campaign_id IS NOT NULL OR c.ttclid IS NOT NULL)`;

/* ------------------------------------------------------------------ *
 * Who gets the option
 * ------------------------------------------------------------------ */

/**
 * Whether "Map by tag" is offered for this client: its agency has it
 * (Reflexion Digital), or the client was given it on its own (a test client).
 * Everyone else keeps the pipeline setup with nothing new on screen.
 */
export async function tagMappingAllowed(
  client: Pick<Client, "agencyId" | "tagMappingAllowed" | "crmMappingMode">,
): Promise<boolean> {
  // A client already counted by tags keeps its controls, whatever the flags say.
  if (client.tagMappingAllowed || client.crmMappingMode === "tags") return true;
  if (!client.agencyId) return false;
  const [agency] = await db
    .select({ on: agencies.tagMappingEnabled })
    .from(agencies)
    .where(eq(agencies.id, client.agencyId))
    .limit(1);
  return Boolean(agency?.on);
}

/* ------------------------------------------------------------------ *
 * The mapping
 * ------------------------------------------------------------------ */

export interface TagMappingRow {
  tag: string;
  canonicalStage: CanonicalStage;
}

export async function loadTagMappings(clientId: string): Promise<TagMappingRow[]> {
  const found = await db
    .select({ tag: tagStageMappings.tag, canonicalStage: tagStageMappings.canonicalStage })
    .from(tagStageMappings)
    .where(eq(tagStageMappings.clientId, clientId))
    .orderBy(tagStageMappings.tag);
  return found.map((r) => ({ tag: r.tag, canonicalStage: r.canonicalStage as CanonicalStage }));
}

/**
 * Tidy a mapping from the browser: tags normalised as `contacts.tags` stores
 * them, blanks dropped, unknown steps refused, and one step per tag (the last
 * one given wins, so a tag moved between steps lands where it was dropped).
 */
export function cleanMappings(input: readonly { tag: string; canonicalStage: string }[]): TagMappingRow[] {
  const byTag = new Map<string, CanonicalStage>();
  for (const m of input) {
    const tag = normalizeTag(m.tag);
    if (!tag) continue;
    if (!(CANONICAL_STAGES as readonly string[]).includes(m.canonicalStage)) continue;
    byTag.set(tag, m.canonicalStage as CanonicalStage);
  }
  return [...byTag].map(([tag, canonicalStage]) => ({ tag, canonicalStage }));
}

/** Every tag on the client's contacts, most used first, with mapped tags kept even at zero. */
export async function clientTags(clientId: string): Promise<{ tag: string; contacts: number }[]> {
  const result = await db.execute<{ tag: string; contacts: number }>(sql`
    SELECT tag, SUM(n)::int AS contacts FROM (
      SELECT t.tag, COUNT(DISTINCT c.id) AS n
      FROM contacts c CROSS JOIN LATERAL unnest(c.tags) AS t(tag)
      WHERE c.client_id = ${clientId} AND t.tag <> ''
      GROUP BY t.tag
      UNION ALL
      SELECT tag, 0 FROM tag_stage_mappings WHERE client_id = ${clientId}
    ) x
    GROUP BY tag
    ORDER BY contacts DESC, tag
    LIMIT 1000
  `);
  return rows<{ tag: string; contacts: number }>(result).map((r) => ({
    tag: r.tag,
    contacts: Number(r.contacts) || 0,
  }));
}

/* ------------------------------------------------------------------ *
 * When each tag appeared
 * ------------------------------------------------------------------ */

/**
 * Fill `contact_tag_history` for a client from what we already hold. Safe to
 * run any number of times: rows are only added, never moved.
 *
 * 1. The raw webhook log. Tag updates have streamed in since 6 Nov 2026, each
 *    payload carrying the contact's full tag list. A tag first seen in a later
 *    payload than the contact's first one arrived at that moment — an exact
 *    date. One already there in the first payload could have been added any
 *    time before, so it takes the contact's creation time instead.
 *
 *    🔴 Only payloads from once this client's tag updates were streaming. A
 *    ContactCreate logged before then (the app sent those from late October)
 *    would otherwise be the "first look", and a tag added in the unwatched gap
 *    would be dated — exactly, and permanently — to the next update that
 *    happened to carry it.
 * 2. Each contact's current tags, for everything the log never saw — dated to
 *    the contact's creation, the same honest floor.
 *
 * In that order, so an exact date is never pre-empted by a fallback one.
 */
export async function seedTagHistory(exec: Pick<Tx, "execute">, clientId: string): Promise<void> {
  await exec.execute(sql`
    WITH stream AS (
      SELECT MIN(received_at) AS started
      FROM webhook_events
      WHERE client_id = ${clientId} AND event_type = 'ContactTagUpdate'
    ),
    ev AS (
      SELECT CASE
               WHEN e.event_type ILIKE '%contact%' AND e.event_type NOT ILIKE '%opportunit%'
                 THEN COALESCE(e.payload->>'contactId', e.payload->>'contact_id', e.payload->>'id')
               ELSE COALESCE(e.payload->>'contactId', e.payload->>'contact_id')
             END AS ghl_contact_id,
             e.received_at,
             e.payload->'tags' AS tags
      FROM webhook_events e
      WHERE e.client_id = ${clientId}
        AND jsonb_typeof(e.payload->'tags') = 'array'
        AND e.received_at >= (SELECT started FROM stream)
    ),
    first_obs AS (
      SELECT ghl_contact_id, MIN(received_at) AS at
      FROM ev WHERE ghl_contact_id IS NOT NULL
      GROUP BY ghl_contact_id
    ),
    first_tag AS (
      SELECT ev.ghl_contact_id, lower(trim(t.tag)) AS tag, MIN(ev.received_at) AS at
      FROM ev CROSS JOIN LATERAL jsonb_array_elements_text(ev.tags) AS t(tag)
      WHERE ev.ghl_contact_id IS NOT NULL AND trim(t.tag) <> ''
      GROUP BY ev.ghl_contact_id, lower(trim(t.tag))
    )
    INSERT INTO contact_tag_history (contact_id, client_id, tag, first_seen_at, exact)
    SELECT c.id, c.client_id, ft.tag,
           CASE WHEN ft.at > fo.at THEN ft.at ELSE COALESCE(c.ghl_created_at, c.created_at) END,
           ft.at > fo.at
    FROM first_tag ft
    JOIN first_obs fo ON fo.ghl_contact_id = ft.ghl_contact_id
    JOIN contacts c ON c.client_id = ${clientId} AND c.ghl_contact_id = ft.ghl_contact_id
    ON CONFLICT (contact_id, tag) DO NOTHING
  `);

  await exec.execute(sql`
    INSERT INTO contact_tag_history (contact_id, client_id, tag, first_seen_at, exact)
    SELECT c.id, c.client_id, t.tag, COALESCE(c.ghl_created_at, c.created_at), false
    FROM contacts c CROSS JOIN LATERAL unnest(c.tags) AS t(tag)
    WHERE c.client_id = ${clientId} AND t.tag <> ''
    ON CONFLICT (contact_id, tag) DO NOTHING
  `);
}

/**
 * The live path: a contact was just (re)read from GoHighLevel. Record any tag
 * we have not seen on it before, then rebuild that one lead.
 *
 * A tag counts as newly ADDED — dated now, exactly — only when we already knew
 * this contact's tags and it was not among them. On first sight we cannot tell
 * a new tag from an old one, so it takes the contact's creation time.
 *
 * Never throws: this rides on webhook processing, and a failure here must not
 * cost the event. A missed rebuild is repaired by the next save or import.
 */
export async function recordContactTags(
  client: Pick<Client, "id" | "agencyId" | "crmMappingMode" | "tagMappingAllowed">,
  before: Pick<Contact, "tags" | "attributionFetchedAt"> | null,
  after: Pick<Contact, "id" | "tags" | "ghlCreatedAt" | "createdAt">,
  now: Date = new Date(),
): Promise<void> {
  try {
    // Only clients that can be counted by tags at all; nobody else pays for this.
    if (!(await tagMappingAllowed(client))) return;

    const knewTags = Boolean(before?.attributionFetchedAt);
    const old = new Set(before?.tags ?? []);
    const arrived = after.ghlCreatedAt ?? after.createdAt;
    const seen = [...new Set((after.tags ?? []).map(normalizeTag).filter(Boolean))].map((tag) => {
      const added = knewTags && !old.has(tag);
      return {
        contactId: after.id,
        clientId: client.id,
        tag,
        firstSeenAt: added ? now : arrived,
        exact: added,
      };
    });

    await db.transaction(async (tx) => {
      /*
       * 🔴 The mode is read HERE, under the lock a save holds — not taken from
       * the client this request loaded. A lead arriving while the client is
       * first switched to tags loaded it as a pipeline client; it now waits
       * for the save, then sees "tags" and is counted, instead of being
       * skipped by the webhook and missed by a save that read contacts before
       * it landed.
       */
      await lockClient(tx, client.id);
      const [row] = await tx
        .select({ mode: clients.crmMappingMode, everyContact: clients.tagLeadEveryContact })
        .from(clients)
        .where(eq(clients.id, client.id))
        .limit(1);
      if (!row || row.mode !== "tags") return;
      if (seen.length > 0) {
        await tx.insert(contactTagHistory).values(seen).onConflictDoNothing();
      }
      await projectAndWrite(tx, client.id, [after.id], row.everyContact);
    });
  } catch (err) {
    console.error(
      `[tag-funnel] ${client.id}: contact ${after.id} not rebuilt —`,
      err instanceof Error ? err.message : err,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Building the funnel
 * ------------------------------------------------------------------ */

export interface RebuildResult {
  leads: number;
  steps: number;
}

/**
 * Rebuild a client's tag funnel — all of it, or just some contacts.
 *
 * Everything happens inside one transaction holding a per-client lock, so a
 * webhook rebuilding one lead and a save rebuilding all of them cannot
 * interleave and leave a half-written lead behind.
 *
 * A client not in tags mode has its tag rows removed instead (whole-client
 * calls only), so they cannot go stale while it is counted by pipeline.
 */
export async function rebuildTagFunnel(
  clientId: string,
  opts: { contactIds?: string[]; seed?: boolean } = {},
): Promise<RebuildResult | null> {
  if (opts.contactIds && opts.contactIds.length === 0) return { leads: 0, steps: 0 };
  return db.transaction(async (tx) => {
    await lockClient(tx, clientId);
    const [client] = await tx
      .select({ mode: clients.crmMappingMode, everyContact: clients.tagLeadEveryContact })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!client) return null;
    if (client.mode !== "tags") {
      if (!opts.contactIds) await clearTagRows(tx, clientId);
      return null;
    }
    if (opts.seed) await seedTagHistory(tx, clientId);
    return projectAndWrite(tx, clientId, opts.contactIds ?? null, client.everyContact);
  });
}

/** Remove every tag row for a client — it is counted by pipeline now. */
async function clearTagRows(tx: Pick<Tx, "execute">, clientId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM stage_transitions WHERE client_id = ${clientId} AND source::text = 'tag'
  `);
  await tx.execute(sql`
    DELETE FROM opportunities WHERE client_id = ${clientId} AND from_tags
  `);
}

async function lockClient(tx: Pick<Tx, "execute">, clientId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tag-funnel:${clientId}`}, 0))`);
}

/** Load the scope's inputs, project them, and write the result — inside `tx`. */
async function projectAndWrite(
  tx: Executor,
  clientId: string,
  scope: string[] | null,
  everyContact: boolean,
): Promise<RebuildResult> {
  // One array parameter: drizzle spreads a bare array into a row, which ANY() refuses.
  const inScope = (column: SQL) => (scope ? sql`AND ${column} = ANY(${sql.param(scope)}::uuid[])` : sql``);

  const mapRows = rows<{ tag: string; stage: string }>(
    await tx.execute(sql`
      SELECT tag, canonical_stage::text AS stage FROM tag_stage_mappings WHERE client_id = ${clientId}
    `),
  );
  const map = new Map(mapRows.map((r) => [r.tag, r.stage as CanonicalStage]));

  const contactRows = rows<{
    id: string;
    ghl_contact_id: string;
    name: string | null;
    lead_at: string | Date;
    from_ad: boolean;
  }>(
    await tx.execute(sql`
      SELECT c.id::text AS id,
             c.ghl_contact_id,
             COALESCE(NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''), c.email, c.phone) AS name,
             COALESCE(c.ghl_created_at, c.created_at) AS lead_at,
             ${FROM_AD} AS from_ad
      FROM contacts c
      WHERE c.client_id = ${clientId} ${inScope(sql`c.id`)}
    `),
  );
  const contacts: TagFunnelContact[] = contactRows.map((r) => ({
    id: r.id,
    ghlContactId: r.ghl_contact_id,
    name: r.name,
    leadAt: new Date(r.lead_at),
    fromAd: Boolean(r.from_ad),
  }));

  const obsRows =
    map.size === 0
      ? []
      : rows<{ contact_id: string; tag: string; first_seen_at: string | Date }>(
          await tx.execute(sql`
            SELECT h.contact_id::text AS contact_id, h.tag, h.first_seen_at
            FROM contact_tag_history h
            JOIN tag_stage_mappings m ON m.client_id = h.client_id AND m.tag = h.tag
            WHERE h.client_id = ${clientId} ${inScope(sql`h.contact_id`)}
          `),
        );
  const observations: TagObservation[] = obsRows.map((r) => ({
    contactId: r.contact_id,
    tag: r.tag,
    firstSeenAt: new Date(r.first_seen_at),
  }));

  const leads = projectTagLeads(contacts, observations, map, { everyContact });
  return writeLeads(tx, clientId, scope, leads);
}

/**
 * Replace the scope's tag rows with `leads`.
 *
 * Stand-in opportunities are upserted on their fixed id (`tag:<contact>`), so a
 * lead keeps the same row across rebuilds. Its steps are replaced wholesale:
 * they are a pure function of the inputs, and a step can move (a tag mapped to
 * a different step) as easily as appear.
 */
async function writeLeads(
  tx: Executor,
  clientId: string,
  scope: string[] | null,
  leads: TagLead[],
): Promise<RebuildResult> {
  const scopeSql = scope ? sql`AND contact_id = ANY(${sql.param(scope)}::uuid[])` : sql``;

  await tx.execute(sql`
    DELETE FROM stage_transitions
    WHERE client_id = ${clientId}
      AND source::text = 'tag'
      AND opportunity_id IN (
        SELECT id FROM opportunities WHERE client_id = ${clientId} AND from_tags ${scopeSql}
      )
  `);
  const keep = leads.map((l) => tagOpportunityId(l.ghlContactId));
  await tx.execute(sql`
    DELETE FROM opportunities
    WHERE client_id = ${clientId} AND from_tags ${scopeSql}
      AND NOT (ghl_opportunity_id = ANY(${sql.param(keep)}::text[]))
  `);

  const now = new Date();
  const oppByContact = new Map<string, string>();
  for (const batch of chunks(leads, 400)) {
    const written = await tx
      .insert(opportunities)
      .values(
        batch.map((l) => ({
          clientId,
          ghlOpportunityId: tagOpportunityId(l.ghlContactId),
          contactId: l.contactId,
          ghlContactId: l.ghlContactId,
          name: l.name,
          ghlPipelineId: null,
          currentStageId: null,
          currentStageGhlId: `tag:${l.current.stage}`,
          status: l.status,
          monetaryValue: null,
          ghlCreatedAt: l.leadAt,
          lastStageChangeAt: l.current.at,
          fromTags: true,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [opportunities.clientId, opportunities.ghlOpportunityId],
        set: {
          contactId: sql`excluded.contact_id`,
          ghlContactId: sql`excluded.ghl_contact_id`,
          name: sql`excluded.name`,
          currentStageId: sql`NULL`,
          currentStageGhlId: sql`excluded.current_stage_ghl_id`,
          status: sql`excluded.status`,
          monetaryValue: sql`NULL`,
          ghlCreatedAt: sql`excluded.ghl_created_at`,
          lastStageChangeAt: sql`excluded.last_stage_change_at`,
          fromTags: sql`true`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ id: opportunities.id, contactId: opportunities.contactId });
    for (const w of written) if (w.contactId) oppByContact.set(w.contactId, w.id);
  }

  const steps = leads.flatMap((l) => {
    const opportunityId = oppByContact.get(l.contactId);
    if (!opportunityId) return [];
    return l.steps.map((s) => ({
      clientId,
      opportunityId,
      contactId: l.contactId,
      fromStageId: null,
      toStageId: null,
      fromStageGhlId: null,
      toStageGhlId: `tag:${s.stage}`,
      fromCanonical: null,
      toCanonical: s.stage,
      changedAt: s.at,
      source: "tag" as const,
      dedupeKey: `tag:${opportunityId}:${s.stage}`,
      webhookEventId: null,
    }));
  });
  for (const batch of chunks(steps, 800)) {
    await tx
      .insert(stageTransitions)
      .values(batch)
      .onConflictDoNothing({ target: stageTransitions.dedupeKey });
  }

  return { leads: leads.length, steps: steps.length };
}

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

export interface TagMappingInput {
  mode: "pipeline" | "tags";
  /** Left out: keep what is saved. */
  everyContact?: boolean;
  /** Left out: keep what is saved. */
  mappings?: TagMappingRow[];
}

/**
 * Save a client's mode and tag mapping, and rebuild (or clear) its tag funnel
 * — all in ONE transaction. A failure part-way leaves the client exactly as it
 * was; a client switched to tags with its tag rows missing would read zero
 * leads on every screen.
 *
 * The mapping is kept when switching back to pipeline, so switching to tags
 * again later starts where it left off.
 */
export async function saveTagMapping(
  clientId: string,
  input: TagMappingInput,
): Promise<RebuildResult | null> {
  return db.transaction(async (tx) => {
    await lockClient(tx, clientId);
    const [updated] = await tx
      .update(clients)
      .set({
        crmMappingMode: input.mode,
        ...(input.everyContact === undefined ? {} : { tagLeadEveryContact: input.everyContact }),
        updatedAt: new Date(),
      })
      .where(eq(clients.id, clientId))
      .returning({ everyContact: clients.tagLeadEveryContact });
    if (!updated) return null;
    if (input.mappings) {
      await tx.delete(tagStageMappings).where(eq(tagStageMappings.clientId, clientId));
      if (input.mappings.length > 0) {
        await tx.insert(tagStageMappings).values(
          input.mappings.map((m) => ({ clientId, tag: m.tag, canonicalStage: m.canonicalStage })),
        );
      }
    }
    if (input.mode !== "tags") {
      await clearTagRows(tx, clientId);
      return null;
    }
    await seedTagHistory(tx, clientId);
    return projectAndWrite(tx, clientId, null, updated.everyContact);
  });
}
