import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  pipelineStages,
  CANONICAL_STAGES,
  REQUIRED_CANONICAL_STAGES,
} from "@/db/schema";
import { importPipelineStages } from "@/lib/clients";
import { reclassifyTransitions } from "@/lib/ghl/backfill";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { safeFailure } from "@/lib/api-failure";
import { record, requestContext } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current mapping, plus a fresh import from GHL when `?refresh=1`. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;

  if (req.nextUrl.searchParams.get("refresh") === "1") {
    try {
      await importPipelineStages(client);
    } catch (err) {
      return NextResponse.json(
        safeFailure(
          err,
          "ghl",
          { superadmin: isSuperadmin(session) },
          "Import failed",
        ),
        { status: 502 },
      );
    }
  }

  const rows = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.clientId, client.id))
    .orderBy(pipelineStages.displayOrder);

  const mapped = new Set(rows.map((r) => r.canonicalStage).filter(Boolean));
  return NextResponse.json({
    stages: rows,
    canonicalStages: CANONICAL_STAGES,
    // Only the required ones — `disqualified` is optional and must not read
    // as a setup defect for a client whose pipeline has no junk stage.
    unmappedCanonical: REQUIRED_CANONICAL_STAGES.filter((s) => !mapped.has(s)),
  });
}

const PutSchema = z.object({
  mappings: z.array(
    z.object({
      stageId: z.string().uuid(),
      canonicalStage: z.enum(CANONICAL_STAGES).nullable(),
    }),
  ),
});

/**
 * Save the mapping, then reclassify.
 *
 * Reclassification matters: transitions recorded against a previously-unmapped
 * stage are already in the ledger but invisible to the funnel because their
 * canonical label is null. Mapping the stage retroactively makes that history
 * countable — which is only possible because we kept the raw GHL stage id on
 * every transition rather than discarding unmapped events.
 */
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  /*
   * 🔴 This wrote pipeline stage mappings for whatever client id was in the
   * URL. Nothing established the client was the caller's, so it could remap
   * another agency's funnel — which does not error, does not look broken, and
   * silently reattributes every future lead to the wrong stage.
   */
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const body = await req.json().catch(() => null);
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  for (const m of parsed.data.mappings) {
    await db
      .update(pipelineStages)
      .set({ canonicalStage: m.canonicalStage, updatedAt: new Date() })
      .where(
        and(
          eq(pipelineStages.id, m.stageId),
          eq(pipelineStages.clientId, client.id),
        ),
      );
  }

  const reclassified = await reclassifyTransitions(id);

  /*
   * Audited, and it is not merely for accountability.
   *
   * Remapping a stage retroactively relabels history — `reclassifyTransitions`
   * can move thousands of past events into or out of the funnel in one call. So
   * a funnel that jumps overnight has two possible causes, "the ads changed" and
   * "someone remapped a stage", and they are indistinguishable in the numbers.
   * This entry is what lets the trend chart mark the second one on the day it
   * happened, instead of leaving a step change nobody can explain.
   */
  const ctxInfo = requestContext(req);
  await record({
    action: "stages.remap",
    targetType: "client",
    targetId: id,
    clientId: id,
    ...ctxInfo,
    metadata: {
      mappings: parsed.data.mappings.length,
      reclassifiedTransitions: reclassified,
    },
  });

  return NextResponse.json({ ok: true, reclassifiedTransitions: reclassified });
}
