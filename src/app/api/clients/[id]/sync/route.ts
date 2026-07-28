import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getClientById } from "@/lib/clients";
import { backfillClientMetrics, syncClientMetrics } from "@/lib/meta/sync";
import { backfillClientSnapshot } from "@/lib/ghl/backfill";
import { trailingWindowInclusive } from "@/lib/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BodySchema = z.object({
  action: z
    .enum(["meta_sync", "meta_backfill", "ghl_backfill"])
    .default("meta_sync"),
  days: z.number().int().min(1).max(365).default(90),
});

/** Manual sync triggers, used by the onboarding wizard and the Re-test button. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const client = await getClientById(id);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  try {
    switch (parsed.data.action) {
      case "meta_sync": {
        const window = trailingWindowInclusive(7, client.timezone);
        const res = await syncClientMetrics(client, {
          since: window.startKey,
          until: window.endKey,
          includeReach: true,
        });
        return NextResponse.json({ ok: true, ...res });
      }
      case "meta_backfill": {
        const rows = await backfillClientMetrics(client, parsed.data.days);
        return NextResponse.json({ ok: true, rowsWritten: rows });
      }
      case "ghl_backfill": {
        const res = await backfillClientSnapshot(client);
        return NextResponse.json({
          ok: true,
          ...res,
          note: "Snapshot only — one synthetic arrival per opportunity. GHL cannot supply the path each lead took, so true stage flow begins from when the webhook went live.",
        });
      }
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Sync failed" },
      { status: 502 },
    );
  }
}
