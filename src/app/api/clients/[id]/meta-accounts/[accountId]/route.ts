import { NextRequest, NextResponse } from "next/server";
import { getClientById } from "@/lib/clients";
import { removeAdAccount } from "@/lib/meta/accounts";
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
  const client = await getClientById(id);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await removeAdAccount(id, accountId);
    void audit.record({
      action: "meta_account.remove",
      targetType: "meta_account",
      targetId: accountId,
      clientId: id,
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
