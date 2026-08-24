import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { safeFailure, safeFailureMessage } from "@/lib/api-failure";
import { kickFirstSync } from "@/lib/first-sync";
import { record, requestContext } from "@/lib/audit";
import { addAdAccount } from "@/lib/meta/accounts";
import {
  readMetaStash,
  dropMetaStash,
  discoverMetaAccounts,
} from "@/lib/meta/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/*
 * 🔴 Needed for the `after()` first-import below, not for the request itself.
 * `after()` work runs on the same invocation, so it inherits this ceiling — at
 * the platform default the 90-day pull would be killed within seconds and the
 * operator would be left on the empty dashboard this exists to prevent.
 */
export const maxDuration = 300;

/**
 * The middle of the self-serve Facebook connect flow.
 *
 * `GET`  — what did the sign-in give us access to?
 * `POST` — attach the accounts the operator picked.
 *
 * Two steps, not one, for the same reason as the Google equivalent: a media
 * buyer's Facebook login can reach every account the agency manages, and
 * attaching all of them would put another tenant's spend on this dashboard.
 * Which accounts belong to THIS client is a judgement made by a person.
 */

const AttachSchema = z
  .object({
    stash: z.string().min(8).max(64),
    adAccountIds: z.array(z.string().min(1).max(32)).min(1).max(50),
  })
  .strict();

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;

  const stashId = req.nextUrl.searchParams.get("stash") ?? "";

  // Checked against THIS client — the stash id travels through a URL.
  const found = readMetaStash(stashId, id);
  if (!found.ok) {
    return NextResponse.json({ error: stashError(found.reason) }, { status: 400 });
  }

  try {
    const accounts = await discoverMetaAccounts(found.accessToken);
    return NextResponse.json({
      accounts,
      // Surfaced so the picker can say "this connection lapses on DATE" at the
      // moment of connecting, rather than leaving it to be discovered later.
      tokenExpiresAt: found.tokenExpiresAt?.toISOString() ?? null,
    });
  } catch (err) {
    // Logged in full server-side; the response carries only what a tenant may
    // read. See `api-failure.ts`.
    console.error("[meta-connect] discovery failed:", err);
    return NextResponse.json(
      safeFailure(
        err,
        "meta",
        { superadmin: isSuperadmin(got.session) },
        "Could not read the ad accounts on that Facebook login.",
      ),
      { status: 502 },
    );
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const parsed = AttachSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid selection" }, { status: 400 });
  }

  const found = readMetaStash(parsed.data.stash, id);
  if (!found.ok) {
    return NextResponse.json({ error: stashError(found.reason) }, { status: 400 });
  }

  /*
   * Re-discovered rather than trusting ids off the wire. It re-verifies the
   * token can actually reach each account — attaching one it cannot would store
   * an account that reports zero spend forever, which is indistinguishable from
   * a paused campaign on the dashboard.
   */
  const reachable = new Map(
    (await discoverMetaAccounts(found.accessToken)).map((a) => [a.adAccountId, a]),
  );

  const attached: string[] = [];
  const failed: Array<{ adAccountId: string; error: string }> = [];

  for (const adAccountId of parsed.data.adAccountIds) {
    const node = reachable.get(adAccountId);
    if (!node) {
      failed.push({
        adAccountId,
        error: "That Facebook login cannot reach this ad account.",
      });
      continue;
    }
    try {
      /*
       * The user token is stored per account, so this client's syncs use the
       * grant that was actually given rather than the shared system user token.
       * Its expiry rides along — see `meta_ad_accounts.token_expires_at`.
       */
      await addAdAccount(id, adAccountId, found.accessToken, found.tokenExpiresAt);
      attached.push(adAccountId);
    } catch (err) {
      failed.push({
        adAccountId,
        error: safeFailureMessage(err, "meta"),
      });
    }
  }

  // The credential now lives, encrypted, on the accounts themselves.
  if (attached.length > 0) dropMetaStash(parsed.data.stash);

  await record({
    action: "meta.accounts_attached",
    targetType: "client",
    targetId: id,
    clientId: id,
    ...requestContext(req),
    metadata: { attached, failed: failed.map((f) => f.adAccountId) },
  });

  /*
   * Start pulling history now, rather than leaving the dashboard empty until
   * the nightly cron. `after()` so this response returns immediately — see
   * `kickFirstSync`, which also guards against re-importing.
   */
  if (attached.length > 0) {
    after(async () => {
      await kickFirstSync(client, "meta");
    });
  }

  return NextResponse.json({ attached, failed });
}

function stashError(reason: "expired" | "wrong_client"): string {
  return reason === "expired"
    ? "That Facebook sign-in has expired. Connect again from this client's setup page."
    : "That sign-in belongs to a different client. Start again from this client's setup page.";
}
