import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getClientById } from "@/lib/clients";
import { addGoogleAccount, listGoogleAccounts } from "@/lib/google/accounts";
import { isGoogleConfigured } from "@/lib/google/oauth";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List a client's Google Ads accounts. Never returns the encrypted token. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const client = await getClientById(id);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const accounts = await listGoogleAccounts(id);
  return NextResponse.json({
    configured: isGoogleConfigured(),
    accounts: accounts.map((a) => ({
      id: a.id,
      customerId: a.customerId,
      accountName: a.accountName,
      currency: a.currency,
      timezone: a.timezone,
      isPrimary: a.isPrimary,
      status: a.status,
      hasTokenOverride: Boolean(a.refreshTokenEncrypted),
      lastSyncedAt: a.lastSyncedAt,
    })),
  });
}

const AddSchema = z.object({
  customerId: z.string().trim().min(1),
  /** Only for an account NOT reachable under the agency MCC. */
  refreshToken: z.string().trim().optional(),
});

/** Verify a Google Ads customer id against the API, then attach it to the client. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const client = await getClientById(id);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!isGoogleConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Google Ads is not configured yet. Add the agency developer token, OAuth client, refresh token and MCC id to the environment (see SETUP.md).",
      },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = AddSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await addGoogleAccount(
      id,
      parsed.data.customerId,
      parsed.data.refreshToken,
    );
    void audit.record({
      action: "google_account.add",
      targetType: "google_account",
      targetId: result.account.customerId,
      clientId: id,
      metadata: { hasTokenOverride: Boolean(parsed.data.refreshToken) },
      ...audit.requestContext(req),
    });
    return NextResponse.json({
      ok: true,
      account: {
        id: result.account.id,
        customerId: result.account.customerId,
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
