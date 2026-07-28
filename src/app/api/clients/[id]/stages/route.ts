import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { pipelineStages, CANONICAL_STAGES } from "@/db/schema";
import { getClientById, importPipelineStages } from "@/lib/clients";
import { reclassifyTransitions } from "@/lib/ghl/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current mapping, plus a fresh import from GHL when `?refresh=1`. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const client = await getClientById(id);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (req.nextUrl.searchParams.get("refresh") === "1") {
    try {
      await importPipelineStages(client);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Import failed" },
        { status: 502 },
      );
    }
  }

  const rows = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.clientId, id))
    .orderBy(pipelineStages.displayOrder);

  const mapped = new Set(rows.map((r) => r.canonicalStage).filter(Boolean));
  return NextResponse.json({
    stages: rows,
    canonicalStages: CANONICAL_STAGES,
    unmappedCanonical: CANONICAL_STAGES.filter((s) => !mapped.has(s)),
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
        and(eq(pipelineStages.id, m.stageId), eq(pipelineStages.clientId, id)),
      );
  }

  const reclassified = await reclassifyTransitions(id);
  return NextResponse.json({ ok: true, reclassifiedTransitions: reclassified });
}
