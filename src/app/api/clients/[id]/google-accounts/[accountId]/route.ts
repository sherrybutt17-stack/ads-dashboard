import { NextRequest, NextResponse } from "next/server";
import { removeGoogleAccount } from "@/lib/google/accounts";
import { requireClient } from "@/lib/auth";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Detach a Google Ads account (soft-removed; historical spend is retained). */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; accountId: string }> },
) {
  const { id, accountId } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  try {
    await removeGoogleAccount(client.id, accountId);
    void audit.record({
      action: "google_account.remove",
      targetType: "google_account",
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
