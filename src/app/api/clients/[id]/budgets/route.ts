import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, requireClient } from "@/lib/auth";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { parseAdPlatform } from "@/lib/platforms";
import { listBudgets, setBudget, deleteBudget, loadPacing } from "@/lib/budgets";

/**
 * The monthly budget agreements for one client's platform.
 *
 * **Staff only**, via `requireClient`. A budget is a commercial term between the
 * agency and the client, not a dashboard preference: a client-role login able to
 * edit it could set the target its own pacing is judged against, which makes
 * every "on pace" reading meaningless. Reading is staff-only here for the same
 * reason the editing surface is — the pacing figures a client sees arrive with
 * their dashboard, already computed.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `yyyy-MM`. Anchored, so "2026-08-01" is a 400 rather than a silent mismatch. */
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected a yyyy-MM month");

const Body = z
  .object({
    platform: z.enum(["meta", "google", "tiktok"]).default("meta"),
    effectiveFrom: MONTH,
    /**
     * `null` is a real value — "no budget from this month on" — and is why this
     * is nullable rather than optional. An absent key is a malformed request;
     * an explicit null is an instruction.
     */
    monthlyAmount: z
      .number()
      .nonnegative("A budget cannot be negative")
      .max(100_000_000)
      .nullable(),
  })
  // Strict: a key added to the form without being added here is a 400 at the
  // boundary rather than a value silently dropped on the floor.
  .strict();

const DeleteBody = z
  .object({
    platform: z.enum(["meta", "google", "tiktok"]).default("meta"),
    effectiveFrom: MONTH,
  })
  .strict();

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const platform = parseAdPlatform(req.nextUrl.searchParams.get("platform"));
  const monthParam = req.nextUrl.searchParams.get("month");
  const month = MONTH.safeParse(monthParam).success ? monthParam! : undefined;

  const [budgets, pacing] = await Promise.all([
    listBudgets(client.id, platform),
    loadPacing(client, platform, { monthKey: month }),
  ]);

  return NextResponse.json({ budgets, pacing });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }
  const { platform, effectiveFrom, monthlyAmount } = parsed.data;

  const gate = rateLimit(`budgets:${client.id}`, 30, 10 * 60_000);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const session = await getSessionUser();
  const actor = session?.userId ?? "unknown";

  await setBudget({
    clientId: client.id,
    platform,
    effectiveFrom,
    monthlyAmount,
    updatedBy: actor,
  });

  /*
   * Audited, and the amount is part of the record. A budget is the number every
   * pacing verdict is measured against, so "who changed the target, when, and
   * from what" is exactly the question asked after a month reads as on-target
   * when it was not.
   */
  await record({
    action: "budget.set",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: { platform, effectiveFrom, monthlyAmount },
  });

  const [budgets, pacing] = await Promise.all([
    listBudgets(client.id, platform),
    loadPacing(client, platform),
  ]);
  return NextResponse.json({ budgets, pacing });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const parsed = DeleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }
  const { platform, effectiveFrom } = parsed.data;

  const gate = rateLimit(`budgets:${client.id}`, 30, 10 * 60_000);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  await deleteBudget(client.id, platform, effectiveFrom);

  await record({
    action: "budget.deleted",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: { platform, effectiveFrom },
  });

  const [budgets, pacing] = await Promise.all([
    listBudgets(client.id, platform),
    loadPacing(client, platform),
  ]);
  return NextResponse.json({ budgets, pacing });
}
