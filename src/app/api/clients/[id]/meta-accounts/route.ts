import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addAdAccount, listAdAccounts } from "@/lib/meta/accounts";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { safeFailure } from "@/lib/api-failure";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List a client's ad accounts. Never returns the encrypted token. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  // `client.id` rather than the raw `id` param: the same value, but taken
  // from the row `requireClient` actually authorized, so the check and the
  // use cannot drift apart in a later edit.
  const accounts = await listAdAccounts(client.id);
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
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;

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
      client.id,
      parsed.data.adAccountId,
      parsed.data.token,
    );
    void audit.record({
      action: "meta_account.add",
      targetType: "meta_account",
      targetId: result.account.adAccountId,
      clientId: client.id,
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
    /*
     * `addAdAccount` throws both kinds: Meta's own rejection of the id, and our
     * "already attached to another client". `safeFailure` keeps the second
     * intact — it is the only message that tells the operator what to do.
     */
    return NextResponse.json(
      {
        ok: false,
        ...safeFailure(
          err,
          "meta",
          { superadmin: isSuperadmin(session) },
          "Could not attach that ad account.",
        ),
      },
      { status: 502 },
    );
  }
}
