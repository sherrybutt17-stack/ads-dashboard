import { and, eq, inArray, isNotNull, like, notLike, sql } from "drizzle-orm";
import { db } from "@/db";
import { pipelineStages, stageTransitions, type Client, type PipelineStage } from "@/db/schema";
import { decodeHistoryCursor, importGhlHistory, type HistoryCursor } from "./history";

/**
 * A client's GoHighLevel history, in one go — for scripts and tests.
 *
 * The setup page imports a page at a time instead, so a large location fits
 * the route's time limit (`importGhlHistory`, called with the cursor each
 * request returns). What is imported, and what never can be, is described
 * there.
 */
export async function backfillClientSnapshot(
  client: Client,
): Promise<{ opportunities: number; transitions: number }> {
  let cursor: HistoryCursor | null = null;
  for (;;) {
    const res = await importGhlHistory(client, { cursor, budgetMs: Number.POSITIVE_INFINITY });
    if (res.done || !res.cursor) {
      return { opportunities: res.totals.opportunities, transitions: res.totals.transitions };
    }
    cursor = decodeHistoryCursor(res.cursor);
  }
}

/**
 * Re-classify transitions after a stage is newly mapped.
 *
 * When the operator maps a previously-unknown stage, transitions already
 * recorded against it carry a null canonical and are invisible to the funnel.
 * This is a legitimate exception to the append-only rule: it fills in a
 * derived label, never changes what happened or when. Imported intakes are
 * the one kind handled apart — `refileIntakes`.
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
          // Intakes follow their pipeline instead — below.
          notLike(stageTransitions.dedupeKey, "%:intake:%"),
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
  return updated + (await refileIntakes(clientId, stageRows));
}

/**
 * Keep imported intakes where a lead counts: under their pipeline's New lead
 * stage, whichever stage that is now.
 *
 * 🔴 An intake records that an opportunity came in as a lead, not that it
 * entered the stage it was filed under. Relabelled like any other row,
 * remapping that stage to Contacted turned every past lead into a past
 * contact at its creation date. So an intake under a stage no longer mapped to
 * New lead moves to the pipeline's New lead stage — and while the pipeline has
 * none, it stops counting, as the import and the live path both count no lead
 * there, until a remap gives it one again.
 */
async function refileIntakes(clientId: string, stageRows: PipelineStage[]): Promise<number> {
  const byPipeline = new Map<string, PipelineStage[]>();
  for (const s of stageRows) {
    if (s.ghlPipelineId) byPipeline.set(s.ghlPipelineId, [...(byPipeline.get(s.ghlPipelineId) ?? []), s]);
  }
  const intakes = and(eq(stageTransitions.clientId, clientId), like(stageTransitions.dedupeKey, "%:intake:%"));
  let updated = 0;
  for (const stages of byPipeline.values()) {
    const leadStages = stages
      .filter((s) => s.canonicalStage === "new_lead")
      .sort((a, b) => (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER));
    const others = stages.filter((s) => s.canonicalStage !== "new_lead").map((s) => s.ghlStageId);
    if (leadStages.length > 0) {
      const restored = await db
        .update(stageTransitions)
        .set({ toCanonical: "new_lead" })
        .where(
          and(
            intakes,
            inArray(
              stageTransitions.toStageGhlId,
              leadStages.map((s) => s.ghlStageId),
            ),
            sql`${stageTransitions.toCanonical} IS DISTINCT FROM 'new_lead'`,
          ),
        )
        .returning({ id: stageTransitions.id });
      updated += restored.length;
    }
    if (others.length === 0) continue;
    const lead = leadStages[0];
    const moved = await db
      .update(stageTransitions)
      .set(lead ? { toCanonical: "new_lead", toStageId: lead.id, toStageGhlId: lead.ghlStageId } : { toCanonical: null })
      .where(
        and(
          intakes,
          inArray(stageTransitions.toStageGhlId, others),
          lead ? undefined : isNotNull(stageTransitions.toCanonical),
        ),
      )
      .returning({ id: stageTransitions.id });
    updated += moved.length;
  }
  return updated;
}
