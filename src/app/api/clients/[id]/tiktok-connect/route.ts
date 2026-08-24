import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { safeFailure, safeFailureMessage } from "@/lib/api-failure";
import { kickFirstSync } from "@/lib/first-sync";
import { record, requestContext } from "@/lib/audit";
import { addTiktokAccount } from "@/lib/tiktok/accounts";
import {
  readTiktokStash,
  dropTiktokStash,
  discoverTiktokAdvertisers,
} from "@/lib/tiktok/connect";

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
 * The middle of the self-serve TikTok connect flow.
 *
 * `GET`  — what did the authorization give us access to?
 * `POST` — attach the advertisers the operator picked.
 *
 * Two steps, not one, for the same reason as the Meta and Google equivalents:
 * one TikTok grant can reach every advertiser an agency manages — the token
 * exchange hands back the whole `advertiser_ids` array — and attaching all of
 * them would put another tenant's spend on this dashboard. Which advertisers
 * belong to THIS client is a judgement made by a person.
 */

const AttachSchema = z
  .object({
    stash: z.string().min(8).max(64),
    advertiserIds: z.array(z.string().min(1).max(32)).min(1).max(50),
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
  const found = readTiktokStash(stashId, id);
  if (!found.ok) {
    return NextResponse.json({ error: stashError(found.reason) }, { status: 400 });
  }

  try {
    const { advertisers, detailUnavailable } = await discoverTiktokAdvertisers(
      found.accessToken,
    );
    return NextResponse.json({
      advertisers,
      /*
       * Passed through so the picker can say the currency column is unknown
       * rather than absent. Without it every row reads `? · ?` and an operator
       * cannot tell a TikTok account with no currency — which does not exist —
       * from a call that failed.
       */
      detailUnavailable,
      /*
       * No `tokenExpiresAt` counterpart to the Meta response: TikTok access
       * tokens do not expire and there is no refresh token, so there is no date
       * to warn about. The picker says so out loud rather than leaving a
       * conspicuous blank where Facebook shows a lapse date.
       */
      tokenExpires: false,
    });
  } catch (err) {
    // Logged in full server-side; the response carries only what a tenant may
    // read. See `api-failure.ts`.
    console.error("[tiktok-connect] discovery failed:", err);
    return NextResponse.json(
      safeFailure(
        err,
        "tiktok",
        { superadmin: isSuperadmin(got.session) },
        "Could not read the advertisers on that TikTok authorization.",
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

  const found = readTiktokStash(parsed.data.stash, id);
  if (!found.ok) {
    return NextResponse.json({ error: stashError(found.reason) }, { status: 400 });
  }

  /*
   * Re-discovered rather than trusting ids off the wire. It re-verifies the
   * grant can actually reach each advertiser — attaching one it cannot would
   * store an account that reports zero spend forever, which is
   * indistinguishable from a paused campaign on the dashboard.
   */
  const reachable = new Set(
    (await discoverTiktokAdvertisers(found.accessToken)).advertisers.map(
      (a) => a.advertiserId,
    ),
  );

  const attached: string[] = [];
  const failed: Array<{ advertiserId: string; error: string }> = [];
  const warnings: Array<{ advertiserId: string; message: string }> = [];

  for (const advertiserId of parsed.data.advertiserIds) {
    if (!reachable.has(advertiserId)) {
      failed.push({
        advertiserId,
        error: "That TikTok authorization cannot reach this advertiser.",
      });
      continue;
    }
    try {
      const result = await addTiktokAccount(id, advertiserId, found.accessToken);
      attached.push(advertiserId);

      /*
       * Surfaced, not swallowed. Mixed currencies cannot be summed, and a
       * timezone that disagrees with the client's makes "a day" mean two
       * different things across platforms on one dashboard. Neither blocks the
       * attach — the operator may know exactly why — but neither may be silent.
       */
      if (result.currencyMismatch) {
        warnings.push({
          advertiserId,
          message: `Reports in ${result.currencyMismatch.thisAccount}, but this client's spend is totalled in ${result.currencyMismatch.client}. Mixed currencies cannot be summed.`,
        });
      }
      if (result.timezoneMismatch) {
        warnings.push({
          advertiserId,
          message: `Buckets days in ${result.timezoneMismatch.thisAccount}, but this client reports in ${result.timezoneMismatch.client}. Day boundaries will differ from the other platforms.`,
        });
      }
    } catch (err) {
      failed.push({
        advertiserId,
        error: safeFailureMessage(err, "tiktok"),
      });
    }
  }

  // The credential now lives, encrypted, on the accounts themselves.
  if (attached.length > 0) dropTiktokStash(parsed.data.stash);

  await record({
    action: "tiktok.accounts_attached",
    targetType: "client",
    targetId: id,
    clientId: id,
    ...requestContext(req),
    metadata: { attached, failed: failed.map((f) => f.advertiserId) },
  });

  /*
   * Start pulling history now, rather than leaving the dashboard empty until
   * the nightly cron. `after()` so the picker's response returns immediately —
   * see `kickFirstSync`, which also guards against re-importing.
   */
  if (attached.length > 0) {
    after(async () => {
      await kickFirstSync(client, "tiktok");
    });
  }

  return NextResponse.json({ attached, failed, warnings });
}

function stashError(reason: "expired" | "wrong_client"): string {
  return reason === "expired"
    ? "That TikTok authorization has expired. Connect again from this client's setup page."
    : "That authorization belongs to a different client. Start again from this client's setup page.";
}
