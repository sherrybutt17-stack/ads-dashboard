import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  contacts,
  opportunities,
  pipelineStages,
  stageTransitions,
  webhookEvents,
  type Client,
} from "@/db/schema";
import { decryptNullable } from "@/lib/crypto";
import { GhlClient } from "./client";
import { normalizeWebhookPayload, normalizeStatus, parseDate } from "./normalize";
import type { GhlAttributionSource, GhlContact } from "./types";

export interface ProcessResult {
  status: "processed" | "ignored" | "failed";
  transitionCreated: boolean;
  reason?: string;
  error?: string;
}

/**
 * Turn one raw webhook event into ledger rows.
 *
 * Safe to call more than once on the same event: GHL retries ~12x with jitter,
 * so delivery is at-least-once AND unordered. Idempotency comes from the unique
 * `dedupeKey` on stage_transitions — a redelivery collapses onto the existing
 * row rather than inflating every downstream funnel count.
 */
export async function processWebhookEvent(
  eventId: string,
  client: Client,
  payload: unknown,
): Promise<ProcessResult> {
  const evt = normalizeWebhookPayload(payload);

  if (!evt.opportunityId) {
    // Contact-only events (ContactCreate etc.) carry no opportunity. We still
    // record the contact so attribution is available when its opportunity
    // eventually arrives.
    if (evt.contactId) {
      /*
       * A tag-change event is the whole point of the tag fallback — it is how a
       * lead gets marked as Facebook-sourced when UTMs are unavailable. Bypass
       * the 24h freshness window so the tag lands immediately rather than the
       * lead sitting uncounted for a day.
       */
      const isTagEvent = /tag/i.test(evt.eventType ?? "");
      await upsertContactFromEvent(client, evt.contactId, { force: isTagEvent });
      return {
        status: "processed",
        transitionCreated: false,
        reason: isTagEvent ? "contact tag update" : "contact-only event",
      };
    }
    return {
      status: "ignored",
      transitionCreated: false,
      reason: "no opportunity or contact id in payload",
    };
  }

  if (!evt.pipelineStageId) {
    return {
      status: "ignored",
      transitionCreated: false,
      reason: "no pipeline stage id in payload",
    };
  }

  const ghl = await getGhlClientAsync(client);

  /*
   * Resolve the authoritative event time.
   *
   * The webhook payload has NO event timestamp — `dateAdded` is the
   * opportunity's creation date, which would silently backdate every transition
   * to the day the lead first appeared and destroy the daily/monthly reports.
   *
   * Priority: lastStageChangeAt from the REST API > envelope timestamp >
   * receipt time.
   */
  let changedAt: Date | null = null;
  let remoteStatus: string | null = null;
  let remoteName: string | null = null;
  let remoteCreatedAt: Date | null = null;

  if (ghl) {
    try {
      const remote = await ghl.getOpportunity(evt.opportunityId);
      if (remote) {
        changedAt = parseDate(remote.lastStageChangeAt) ?? null;
        remoteStatus = remote.status ?? null;
        remoteName = remote.name ?? null;
        remoteCreatedAt = parseDate(remote.createdAt) ?? null;
      }
    } catch {
      // A read failure must not drop the event — fall through to the envelope
      // timestamp. Losing precision is recoverable; losing the transition is not.
    }
  }
  changedAt ??= parseDate(evt.envelopeTimestamp) ?? new Date();

  // Resolve (or lazily create) the incoming stage.
  const toStage = await resolveStage(
    client.id,
    evt.pipelineStageId,
    evt.pipelineId,
  );

  const contactRow = evt.contactId
    ? await upsertContactFromEvent(client, evt.contactId)
    : null;

  return await db.transaction(async (tx) => {
    /*
     * Lock the opportunity row for the length of the transaction. Delivery is
     * at-least-once AND concurrent (a retry can arrive while the first is still
     * processing). Without the row lock, two deliveries both read the OLD stage,
     * both derive `from` from it, and both append a transition — duplicating the
     * append-only ledger and corrupting `from_stage`. FOR UPDATE serialises them,
     * so the second sees the stage the first already advanced to and either
     * short-circuits ("no stage change") or derives the correct `from`.
     */
    const [existing] = await tx
      .select()
      .from(opportunities)
      .where(
        and(
          eq(opportunities.clientId, client.id),
          eq(opportunities.ghlOpportunityId, evt.opportunityId!),
        ),
      )
      .limit(1)
      .for("update");

    const status = normalizeStatus(remoteStatus ?? evt.status);
    const values = {
      clientId: client.id,
      ghlOpportunityId: evt.opportunityId!,
      contactId: contactRow?.id ?? existing?.contactId ?? null,
      ghlContactId: evt.contactId ?? existing?.ghlContactId ?? null,
      name: remoteName ?? evt.name ?? existing?.name ?? null,
      ghlPipelineId: evt.pipelineId ?? existing?.ghlPipelineId ?? null,
      currentStageId: toStage?.id ?? null,
      currentStageGhlId: evt.pipelineStageId!,
      status: status ?? existing?.status ?? null,
      monetaryValue:
        evt.monetaryValue !== null
          ? String(evt.monetaryValue)
          : (existing?.monetaryValue ?? null),
      ghlCreatedAt:
        remoteCreatedAt ?? parseDate(evt.dateAdded) ?? existing?.ghlCreatedAt ?? null,
      lastStageChangeAt: changedAt,
      updatedAt: new Date(),
    };

    let opportunityRowId: string;
    let previousStageGhlId: string | null = null;
    let previousStageId: string | null = null;

    if (existing) {
      previousStageGhlId = existing.currentStageGhlId;
      previousStageId = existing.currentStageId;
      await tx
        .update(opportunities)
        .set(values)
        .where(eq(opportunities.id, existing.id));
      opportunityRowId = existing.id;
    } else {
      // Upsert rather than a bare insert: two concurrent first-deliveries of the
      // same brand-new opportunity would otherwise race to INSERT and the loser
      // would hit the (client_id, ghl_opportunity_id) unique violation, fail the
      // whole event, and defer its ledger write to a later retry.
      const [inserted] = await tx
        .insert(opportunities)
        .values(values)
        .onConflictDoUpdate({
          target: [opportunities.clientId, opportunities.ghlOpportunityId],
          set: values,
        })
        .returning({ id: opportunities.id });
      opportunityRowId = inserted.id;
    }

    // No stage change → nothing to append. This is the common case for
    // OpportunityUpdate events that only touched a name or monetary value.
    if (previousStageGhlId === evt.pipelineStageId) {
      return {
        status: "processed" as const,
        transitionCreated: false,
        reason: "no stage change",
      };
    }

    const fromStage = previousStageId
      ? await tx
          .select()
          .from(pipelineStages)
          .where(eq(pipelineStages.id, previousStageId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : null;

    const dedupeKey = `${opportunityRowId}:${evt.pipelineStageId}:${changedAt.toISOString()}`;

    const result = await tx
      .insert(stageTransitions)
      .values({
        clientId: client.id,
        opportunityId: opportunityRowId,
        contactId: contactRow?.id ?? null,
        fromStageId: previousStageId,
        toStageId: toStage?.id ?? null,
        fromStageGhlId: previousStageGhlId,
        toStageGhlId: evt.pipelineStageId!,
        fromCanonical: fromStage?.canonicalStage ?? null,
        toCanonical: toStage?.canonicalStage ?? null,
        changedAt,
        source: "webhook",
        dedupeKey,
        webhookEventId: eventId,
      })
      // The idempotency guarantee. A retried delivery lands here and is dropped.
      .onConflictDoNothing({ target: stageTransitions.dedupeKey })
      .returning({ id: stageTransitions.id });

    return {
      status: "processed" as const,
      transitionCreated: result.length > 0,
    };
  });
}

/**
 * Find the stage row, or create a placeholder for one we have never seen.
 *
 * A client adding a stage in GHL after onboarding must NOT cause events to be
 * dropped. We record it unmapped (`canonicalStage` null) and let the health
 * checklist surface it for the operator to map. The transition is preserved
 * either way, and can be reclassified later because we keep the raw GHL id.
 */
async function resolveStage(
  clientId: string,
  ghlStageId: string,
  ghlPipelineId: string | null,
) {
  const [found] = await db
    .select()
    .from(pipelineStages)
    .where(
      and(
        eq(pipelineStages.clientId, clientId),
        eq(pipelineStages.ghlStageId, ghlStageId),
      ),
    )
    .limit(1);
  if (found) return found;

  const [created] = await db
    .insert(pipelineStages)
    .values({
      clientId,
      ghlPipelineId: ghlPipelineId ?? "unknown",
      ghlStageId,
      ghlStageName: null,
      canonicalStage: null,
      discoveredFromWebhook: true,
    })
    .onConflictDoNothing({
      target: [pipelineStages.clientId, pipelineStages.ghlStageId],
    })
    .returning();

  if (created) return created;

  const [raced] = await db
    .select()
    .from(pipelineStages)
    .where(
      and(
        eq(pipelineStages.clientId, clientId),
        eq(pipelineStages.ghlStageId, ghlStageId),
      ),
    )
    .limit(1);
  return raced ?? null;
}

/**
 * Upsert a contact, fetching attribution from the REST API.
 *
 * Necessary because NO webhook carries attribution — the campaign a lead came
 * from is only reachable via GET /contacts/{id}. Refreshed at most once a day
 * per contact to stay well inside rate limits.
 */
async function upsertContactFromEvent(
  client: Client,
  ghlContactId: string,
  { force = false }: { force?: boolean } = {},
) {
  const [existing] = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.clientId, client.id),
        eq(contacts.ghlContactId, ghlContactId),
      ),
    )
    .limit(1);

  const stale =
    force ||
    !existing?.attributionFetchedAt ||
    Date.now() - existing.attributionFetchedAt.getTime() > 24 * 60 * 60 * 1000;

  let remote: GhlContact | null = null;
  if (stale) {
    const ghl = await getGhlClientAsync(client);
    if (ghl) {
      try {
        remote = await ghl.getContact(ghlContactId);
      } catch {
        // Attribution is enrichment, not the event itself. Never fail on it.
      }
    }
  }

  if (!remote) {
    if (existing) return existing;
    const [created] = await db
      .insert(contacts)
      .values({ clientId: client.id, ghlContactId })
      .onConflictDoNothing({
        target: [contacts.clientId, contacts.ghlContactId],
      })
      .returning();
    return created ?? existing ?? null;
  }

  const attr = pickAttribution(remote);
  const values = {
    clientId: client.id,
    ghlContactId,
    firstName: remote.firstName ?? null,
    lastName: remote.lastName ?? null,
    email: remote.email ?? null,
    phone: remote.phone ?? null,
    source: remote.source ?? null,
    utmSource: attr.utmSource,
    utmMedium: attr.utmMedium,
    utmCampaign: attr.utmCampaign,
    utmContent: attr.utmContent,
    utmTerm: attr.utmTerm,
    metaCampaignId: attr.metaCampaignId,
    metaAdsetId: attr.metaAdsetId,
    metaAdId: attr.metaAdId,
    fbclid: attr.fbclid,
    // Lowercased so the paid-lead tag comparison is case-insensitive without
    // needing a functional index or per-query LOWER().
    tags: extractTags(remote),
    rawAttribution: {
      attributionSource: remote.attributionSource ?? null,
      lastAttributionSource: remote.lastAttributionSource ?? null,
    },
    attributionFetchedAt: new Date(),
    ghlCreatedAt: parseDate(remote.dateAdded),
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(contacts)
    .values(values)
    .onConflictDoUpdate({
      target: [contacts.clientId, contacts.ghlContactId],
      set: values,
    })
    .returning();
  return row;
}

/** GHL returns tags as a string array; normalise defensively. */
function extractTags(contact: GhlContact): string[] {
  const raw = (contact as { tags?: unknown }).tags;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Merge first-touch and last-touch attribution.
 *
 * `attributionSource` is first touch and static; `lastAttributionSource` is
 * overwritten on each qualifying visit. For cost-per-lead we want the touch
 * that CREATED the lead, so first touch wins and last touch only fills gaps.
 */
function pickAttribution(contact: GhlContact) {
  const first = contact.attributionSource ?? {};
  const last = contact.lastAttributionSource ?? {};
  const pick = (k: keyof GhlAttributionSource): string | null => {
    const v = first[k] ?? last[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  return {
    utmSource: pick("utmSource"),
    utmMedium: pick("utmMedium") ?? pick("medium"),
    utmCampaign: pick("utmCampaign") ?? pick("campaign"),
    utmContent: pick("utmContent"),
    utmTerm: pick("utmTerm"),
    // Holds the Meta numeric campaign id when UTMs are configured on the ads.
    metaCampaignId: pick("campaignId"),
    metaAdsetId: pick("adGroupId"),
    metaAdId: pick("adId"),
    fbclid: pick("fbclid"),
  };
}

/**
 * Resolve a GHL REST client for this tenant.
 *
 * Prefers the OAuth installation when one exists — its access token is
 * refreshed on demand, whereas a PIT is static and must be rotated by hand.
 * Falls back to the PIT so clients connected before the marketplace app keep
 * working without reconnecting.
 *
 * Async because an expired OAuth token triggers a refresh round-trip.
 */
export async function getGhlClientAsync(
  client: Client,
): Promise<GhlClient | null> {
  if (client.ghlAuthMethod === "oauth") {
    const { getInstallationForClient, getValidAccessToken } = await import(
      "./oauth"
    );
    const installation = await getInstallationForClient(client.id);
    if (installation && !installation.uninstalledAt) {
      try {
        return new GhlClient(await getValidAccessToken(installation));
      } catch {
        // Refresh failed (revoked, or a refresh token that was already spent).
        // Fall through to the PIT rather than losing REST access entirely.
      }
    }
  }

  const token = decryptNullable(client.ghlTokenEncrypted);
  return token ? new GhlClient(token) : null;
}

/**
 * Synchronous PIT-only accessor.
 *
 * Retained for call sites that cannot await. Returns null for OAuth-only
 * clients — use `getGhlClientAsync` there.
 */
export function getGhlClient(client: Client): GhlClient | null {
  const token = decryptNullable(client.ghlTokenEncrypted);
  return token ? new GhlClient(token) : null;
}

/** Mark a raw event row with its processing outcome. */
export async function finalizeEvent(eventId: string, result: ProcessResult) {
  await db
    .update(webhookEvents)
    .set({
      status: result.status,
      error: result.error ?? result.reason ?? null,
      processedAt: new Date(),
    })
    .where(eq(webhookEvents.id, eventId));
}

/**
 * Bump liveness markers that the health checklist reads.
 *
 * `firstWebhookAt` is set once and never overwritten — it is the evidence that
 * the pipe has genuinely worked at least once, which is what the onboarding
 * wizard polls for. COALESCE keeps this to a single statement so two concurrent
 * deliveries cannot race to overwrite it.
 */
export async function touchClientWebhookMarkers(clientId: string) {
  const now = new Date();
  await db
    .update(clients)
    .set({
      lastWebhookAt: now,
      firstWebhookAt: sql`COALESCE(${clients.firstWebhookAt}, ${now})`,
      updatedAt: now,
    })
    .where(eq(clients.id, clientId));
}

/**
 * Record a communication touch from a message webhook.
 *
 * `first_touch_at` is set on any message (we reached out, or they replied) — the
 * "contact was made" signal, independent of a manual stage move. `first_call_at`
 * is set only on the first OUTBOUND CALL (`messageType === "CALL"`), the anchor
 * for speed-to-lead. Both use COALESCE so only the FIRST of each kind sticks and
 * GHL's at-least-once redeliveries are harmless.
 */
export async function recordMessageTouch(
  clientId: string,
  payload: unknown,
): Promise<{ isCall: boolean; contactMatched: boolean }> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const ghlContactId = typeof p.contactId === "string" ? p.contactId : null;
  if (!ghlContactId) return { isCall: false, contactMatched: false };

  const direction = typeof p.direction === "string" ? p.direction : null;
  const messageType =
    typeof p.messageType === "string" ? p.messageType.toUpperCase() : null;
  const dateStr =
    typeof p.dateAdded === "string"
      ? p.dateAdded
      : typeof p.timestamp === "string"
        ? p.timestamp
        : null;
  const at = (dateStr ? parseDate(dateStr) : null) ?? new Date();
  const isCall = messageType === "CALL" && direction === "outbound";

  const set: Record<string, unknown> = {
    firstTouchAt: sql`COALESCE(${contacts.firstTouchAt}, ${at})`,
    updatedAt: new Date(),
  };
  if (isCall) {
    set.firstCallAt = sql`COALESCE(${contacts.firstCallAt}, ${at})`;
  }

  const updated = await db
    .update(contacts)
    .set(set)
    .where(
      and(
        eq(contacts.clientId, clientId),
        eq(contacts.ghlContactId, ghlContactId),
      ),
    )
    .returning({ id: contacts.id });

  return { isCall, contactMatched: updated.length > 0 };
}
