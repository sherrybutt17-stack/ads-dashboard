import { NextRequest, NextResponse } from "next/server";
import { runHealthChecks } from "@/lib/health";
import { isSuperadmin, requireClient } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;
  /*
   * The raw upstream errors go to superadmins only. An agency owner passes
   * `requireClient` for their own client — correctly — and still must not read
   * a Graph error naming our app id or a Google payload carrying our MCC. See
   * `health-errors.ts`.
   */
  const report = await runHealthChecks(client, {
    superadmin: isSuperadmin(session),
  });
  return NextResponse.json(report);
}
