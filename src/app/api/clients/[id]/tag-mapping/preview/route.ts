import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClient } from "@/lib/auth";
import { trailingWindow } from "@/lib/dates";
import { tagMappingAllowed } from "@/lib/tag-funnel";
import { previewLeadCounts } from "@/lib/tag-funnel/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_DAYS = 30;

const Body = z.object({
  everyContact: z.boolean(),
  tags: z.array(z.string().trim().max(200)).max(500),
});

/**
 * Paid leads over the last 30 days, counted by pipeline (as today) and by the
 * tag mapping on screen — shown before saving, because saving recounts every
 * past figure too. Reads only; nothing is saved.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  if (!(await tagMappingAllowed(client))) {
    return NextResponse.json(
      { error: "Mapping by tag isn't available for this client." },
      { status: 403 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const counts = await previewLeadCounts(
    client,
    parsed.data,
    trailingWindow(PREVIEW_DAYS, client.timezone),
  );
  return NextResponse.json({ days: PREVIEW_DAYS, ...counts });
}
