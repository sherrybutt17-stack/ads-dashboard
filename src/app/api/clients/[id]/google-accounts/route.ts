import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addGoogleAccount, listGoogleAccounts } from "@/lib/google/accounts";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { safeFailure } from "@/lib/api-failure";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List a client's Google Ads accounts. Never returns the encrypted token. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const accounts = await listGoogleAccounts(client.id);
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
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;
  const superadmin = isSuperadmin(session);

  if (!isGoogleConfigured()) {
    /*
     * Two registers for the same fact. The setup instructions name our
     * developer token and our MCC — worth reading if you can act on them, and a
     * description of shared credentials to anyone who cannot. An agency owner
     * is in the second group, so they get told it is ours and that they cannot
     * fix it, which is the part that stops them re-entering a customer id ten
     * times against a connector that was never switched on.
     */
    return NextResponse.json(
      {
        ok: false,
        error: superadmin
          ? "Google Ads is not configured yet. Set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET (see SETUP.md §2b). The agency refresh token and MCC id are Model A only — client sign-in does not need them."
          : "Google Ads is not fully set up on our side",
        hint: superadmin
          ? undefined
          : "Nothing you can fix from here. Contact support and we'll sort it.",
        cause: "not_configured",
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
      client.id,
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
    /*
     * The worst offender of the set: `google/client.ts` interpolates the entire
     * response body, and a Google Ads error payload carries our MCC id and the
     * developer token's approval state.
     */
    return NextResponse.json(
      {
        ok: false,
        ...safeFailure(
          err,
          "google",
          { superadmin },
          "Could not attach that account.",
        ),
      },
      { status: 502 },
    );
  }
}
