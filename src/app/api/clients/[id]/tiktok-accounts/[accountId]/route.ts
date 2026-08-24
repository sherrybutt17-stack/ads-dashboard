import { NextRequest, NextResponse } from "next/server";
import { removeTiktokAccount } from "@/lib/tiktok/accounts";
import { requireClient } from "@/lib/auth";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Detach a TikTok advertiser.
 *
 * Marks it removed rather than hard-deleting, so metrics already pulled under
 * it stay in `tiktok_daily_metrics` and historical totals do not silently drop.
 * Same contract as the Meta and Google equivalents.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; accountId: string }> },
) {
  const { id, accountId } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  try {
  // `client.id` rather than the raw `id` param: the same value, but taken
  // from the row `requireClient` actually authorized, so the check and the
  // use cannot drift apart in a later edit.
    await removeTiktokAccount(client.id, accountId);
    void audit.record({
      action: "tiktok_account.remove",
      targetType: "tiktok_account",
      targetId: accountId,
      clientId: client.id,
      ...audit.requestContext(req),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
