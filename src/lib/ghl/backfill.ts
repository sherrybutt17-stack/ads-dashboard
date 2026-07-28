import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  contacts,
  opportunities,
  pipelineStages,
  stageTransitions,
  syncRuns,
  type Client,
} from "@/db/schema";
import { getGhlClientAsync } from "./process";
import { normalizeStatus, parseDate } from "./normalize";

/**
 * Day-0 backfill snapshot.
 *
 * This establishes the FLOOR of what is knowable, and it is important to be
 * precise about what it does and does not recover.
 *
 * GoHighLevel exposes no stage-transition history. For each existing
 * opportunity we can read exactly two facts: which stage it is in now, and when
 * it last moved (`lastStageChangeAt`). We therefore write ONE synthetic
 * transition per opportunity — an arrival at its current stage, at that
 * timestamp — marked `source='backfill_snapshot'` so it is distinguishable from
 * genuine observed history.
 *
 * What this does NOT recover, and never can:
 *   - the path an opportunity took to reach its current stage
 *   - how long it sat in any earlier stage
 *   - any transition that happened before its most recent one
 *
 * So a backfilled month shows arrivals but not true flow. Only data accumulated
 * after the webhook goes live is complete. Run this once, at onboarding.
 */
export async function backfillClientSnapshot(
  client: Client,
): Promise<{ opportunities: number; transitions: number }> {
  const [run] = await db
    .insert(syncRuns)
    .values({ clientId: client.id, kind: "ghl_backfill", status: "running" })
    .returning({ id: syncRuns.id });

  try {
    const ghl = await getGhlClientAsync(client);
    if (!ghl || !client.ghlLocationId) {
      throw new Error("Client has no GHL connection");
    }

    // Stage id → our row, so canonical mapping is resolved without a query per
    // opportunity.
    const stageRows = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.clientId, client.id));
    const stageByGhlId = new Map(stageRows.map((s) => [s.ghlStageId, s]));

    let oppCount = 0;
    let transitionCount = 0;

    for await (const batch of ghl.iterateOpportunities(client.ghlLocationId)) {
      for (const remote of batch) {
        if (!remote.id) continue;

        const stageGhlId = remote.pipelineStageId ?? null;
        const stage = stageGhlId ? stageByGhlId.get(stageGhlId) : undefined;

        // Link the contact if we already know it; full attribution enrichment
        // happens lazily when its first webhook arrives.
        let contactRowId: string | null = null;
        const ghlContactId = remote.contactId ?? remote.contact?.id ?? null;
        if (ghlContactId) {
          const [existingContact] = await db
            .select({ id: contacts.id })
            .from(contacts)
            .where(
              and(
                eq(contacts.clientId, client.id),
                eq(contacts.ghlContactId, ghlContactId),
              ),
            )
            .limit(1);
          if (existingContact) {
            contactRowId = existingContact.id;
          } else {
            const [created] = await db
              .insert(contacts)
              .values({ clientId: client.id, ghlContactId })
              .onConflictDoNothing({
                target: [contacts.clientId, contacts.ghlContactId],
              })
              .returning({ id: contacts.id });
            contactRowId = created?.id ?? null;
          }
        }

        const changedAt =
          parseDate(remote.lastStageChangeAt) ??
          parseDate(remote.createdAt) ??
          new Date();

        const values = {
          clientId: client.id,
          ghlOpportunityId: remote.id,
          contactId: contactRowId,
          ghlContactId,
          name: remote.name ?? null,
          ghlPipelineId: remote.pipelineId ?? null,
          currentStageId: stage?.id ?? null,
          currentStageGhlId: stageGhlId,
          status: normalizeStatus(remote.status ?? null),
          monetaryValue:
            typeof remote.monetaryValue === "number"
              ? String(remote.monetaryValue)
              : null,
          ghlCreatedAt: parseDate(remote.createdAt),
          lastStageChangeAt: changedAt,
          updatedAt: new Date(),
        };

        const [opp] = await db
          .insert(opportunities)
          .values(values)
          .onConflictDoUpdate({
            target: [opportunities.clientId, opportunities.ghlOpportunityId],
            set: values,
          })
          .returning({ id: opportunities.id });
        oppCount++;

        if (!stageGhlId || !opp) continue;

        const inserted = await db
          .insert(stageTransitions)
          .values({
            clientId: client.id,
            opportunityId: opp.id,
            contactId: contactRowId,
            // Deliberately null: we do not know where it came from, and
            // inventing a prior stage would fabricate history.
            fromStageId: null,
            fromStageGhlId: null,
            fromCanonical: null,
            toStageId: stage?.id ?? null,
            toStageGhlId: stageGhlId,
            toCanonical: stage?.canonicalStage ?? null,
            changedAt,
            source: "backfill_snapshot",
            dedupeKey: `${opp.id}:${stageGhlId}:${changedAt.toISOString()}`,
          })
          // Re-running the backfill must not duplicate, and must not collide
          // with a real webhook that already recorded the same arrival.
          .onConflictDoNothing({ target: stageTransitions.dedupeKey })
          .returning({ id: stageTransitions.id });

        if (inserted.length > 0) transitionCount++;
      }
    }

    await db
      .update(syncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        rowsWritten: transitionCount,
        meta: { opportunities: oppCount },
      })
      .where(eq(syncRuns.id, run.id));

    return { opportunities: oppCount, transitions: transitionCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}

/**
 * Re-classify transitions after a stage is newly mapped.
 *
 * When the operator maps a previously-unknown stage, transitions already
 * recorded against it carry a null canonical and are invisible to the funnel.
 * This is a legitimate exception to the append-only rule: it fills in a
 * derived label, never changes what happened or when.
 */
export async function reclassifyTransitions(clientId: string): Promise<number> {
  const stageRows = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.clientId, clientId));

  let updated = 0;
  for (const stage of stageRows) {
    if (!stage.canonicalStage) continue;

    const res = await db
      .update(stageTransitions)
      .set({ toCanonical: stage.canonicalStage, toStageId: stage.id })
      .where(
        and(
          eq(stageTransitions.clientId, clientId),
          eq(stageTransitions.toStageGhlId, stage.ghlStageId),
        ),
      )
      .returning({ id: stageTransitions.id });
    updated += res.length;

    await db
      .update(stageTransitions)
      .set({ fromCanonical: stage.canonicalStage, fromStageId: stage.id })
      .where(
        and(
          eq(stageTransitions.clientId, clientId),
          eq(stageTransitions.fromStageGhlId, stage.ghlStageId),
        ),
      );
  }
  return updated;
}
