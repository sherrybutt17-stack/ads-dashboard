import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getClientById } from "@/lib/clients";
import { addAdAccount, listAdAccounts } from "@/lib/meta/accounts";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List a client's ad accounts. Never returns the encrypted token. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const client = await getClientById(id);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const accounts = await listAdAccounts(id);
  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      adAccountId: a.adAccountId,
      accountName: a.accountName,
      currency: a.currency,
      timezone: a.timezone,
      isPrimary: a.isPrimary,
      status: a.status,
      hasTokenOverride: Boolean(a.tokenEncrypted),
      lastSyncedAt: a.lastSyncedAt,
    })),
  });
}

const AddSchema = z.object({
  adAccountId: z.string().trim().min(1),
  /** Only for an account in a different Business Manager. */
  token: z.string().trim().optional(),
});

/** Verify an ad account against Meta, then attach it to the client. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const client = await getClientById(id);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = AddSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await addAdAccount(
      id,
      parsed.data.adAccountId,
      parsed.data.token,
    );
    void audit.record({
      action: "meta_account.add",
      targetType: "meta_account",
      targetId: result.account.adAccountId,
      clientId: id,
      metadata: { hasTokenOverride: Boolean(parsed.data.token) },
      ...audit.requestContext(req),
    });
    return NextResponse.json({
      ok: true,
      account: {
        id: result.account.id,
        adAccountId: result.account.adAccountId,
        accountName: result.account.accountName,
        currency: result.account.currency,
        timezone: result.account.timezone,
        isPrimary: result.account.isPrimary,
      },
      currencyMismatch: result.currencyMismatch ?? null,
      timezoneMismatch: result.timezoneMismatch ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed" },
      { status: 502 },
    );
  }
}
