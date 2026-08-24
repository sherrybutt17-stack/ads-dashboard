import { NextRequest, NextResponse } from "next/server";
import { removeAdAccount } from "@/lib/meta/accounts";
import { requireClient } from "@/lib/auth";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Detach an ad account.
 *
 * Marks it removed rather than hard-deleting, so metrics already pulled under
 * it stay in `fb_daily_metrics` and historical totals do not silently drop.
 */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; accountId: string }> },
) {
  const { id, accountId } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  try {
    await removeAdAccount(client.id, accountId);
    void audit.record({
      action: "meta_account.remove",
      targetType: "meta_account",
      targetId: accountId,
      clientId: client.id,
      ...audit.requestContext(_req),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
