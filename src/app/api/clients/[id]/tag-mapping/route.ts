import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CANONICAL_STAGES } from "@/db/schema";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { record, requestContext } from "@/lib/audit";
import {
  cleanMappings,
  clientTags,
  loadTagMappings,
  saveTagMapping,
  tagMappingAllowed,
} from "@/lib/tag-funnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A first switch to tags rebuilds every lead the client has.
export const maxDuration = 300;

/**
 * "Map by tag" — count a client's leads from GoHighLevel tags instead of
 * pipeline stages. Offered only where `tagMappingAllowed` says (Reflexion
 * Digital, and test clients); everyone else gets a 403 and never sees it.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  if (!(await tagMappingAllowed(client))) {
    return NextResponse.json({ allowed: false });
  }

  const [mappings, tags] = await Promise.all([loadTagMappings(client.id), clientTags(client.id)]);
  return NextResponse.json({
    allowed: true,
    mode: client.crmMappingMode,
    everyContact: client.tagLeadEveryContact,
    mappings,
    tags,
    paidRule: { mode: client.paidLeadFilter, tag: client.paidLeadTag },
  });
}

/** `everyContact` and `mappings` may be left out to keep what is saved — how "switch back to pipeline" keeps the tag mapping for next time. */
const PutSchema = z.object({
  mode: z.enum(["pipeline", "tags"]),
  everyContact: z.boolean().optional(),
  mappings: z
    .array(
      z.object({
        tag: z.string().trim().min(1).max(200),
        canonicalStage: z.enum(CANONICAL_STAGES),
      }),
    )
    .max(500)
    .optional(),
});

/**
 * Save the mode and the mapping, then rebuild the client's tag funnel (or
 * clear it, switching back to pipeline). Every past figure is recounted, so the
 * change is audited — the trend chart marks the day, the same way it marks a
 * pipeline remap, so a jump in the numbers has a visible cause.
 */
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;

  if (!(await tagMappingAllowed(client))) {
    return NextResponse.json(
      { error: "Mapping by tag isn't available for this client." },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const mappings = parsed.data.mappings ? cleanMappings(parsed.data.mappings) : undefined;
  let rebuilt;
  try {
    rebuilt = await saveTagMapping(client.id, {
      mode: parsed.data.mode,
      everyContact: parsed.data.everyContact,
      mappings,
    });
  } catch (err) {
    // All or nothing (see saveTagMapping): the client is exactly as it was.
    console.error(`[tag-mapping] ${client.slug}: save failed —`, err);
    return NextResponse.json(
      {
        error: "Couldn't save. Nothing was changed — please try again.",
        ...(isSuperadmin(session) && err instanceof Error ? { diagnostic: err.message } : {}),
      },
      { status: 500 },
    );
  }

  await record({
    action: "tags.remap",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: {
      mode: parsed.data.mode,
      previousMode: client.crmMappingMode,
      everyContact: parsed.data.everyContact ?? client.tagLeadEveryContact,
      mappings: mappings?.length ?? null,
      leads: rebuilt?.leads ?? null,
    },
  });

  return NextResponse.json({ ok: true, mode: parsed.data.mode, rebuilt });
}
