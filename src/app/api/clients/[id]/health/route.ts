import { NextRequest, NextResponse } from "next/server";
import { getClientById } from "@/lib/clients";
import { runHealthChecks } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const client = await getClientById(id);
  if (!client) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const report = await runHealthChecks(client);
  return NextResponse.json(report);
}
