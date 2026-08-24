import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { safeFailure, safeFailureMessage } from "@/lib/api-failure";
import { kickFirstSync } from "@/lib/first-sync";
import { record, requestContext } from "@/lib/audit";
import { addGoogleAccount } from "@/lib/google/accounts";
import {
  readGoogleStash,
  dropGoogleStash,
  discoverGoogleAccounts,
} from "@/lib/google/connect";

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
 * The middle of the self-serve Google connect flow.
 *
 * `GET`  — what did the sign-in give us access to?
 * `POST` — attach the accounts the operator picked.
 *
 * The two are separate because authorizing with an account that can see forty
 * customers must not attach forty customers. Which ones belong to this client is
 * a judgement, and one made by a person.
 */

const AttachSchema = z
  .object({
    stash: z.string().min(8).max(64),
    customerIds: z.array(z.string().min(1).max(24)).min(1).max(50),
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

  // Checked against THIS client — the stash id travels through a URL, and one
  // minted for another client must not be usable here.
  const found = readGoogleStash(stashId, id);
  if (!found.ok) {
    return NextResponse.json({ error: stashError(found.reason) }, { status: 400 });
  }

  try {
    const { accounts, partial } = await discoverGoogleAccounts(found.refreshToken);
    return NextResponse.json({
      accounts,
      /*
       * Surfaced rather than swallowed. A user with access to five managers, one
       * of them suspended, gets the other four — but silently returning a short
       * list is how someone concludes an account "isn't there" and goes looking
       * in the wrong place.
       */
      partial,
    });
  } catch (err) {
    // Logged in full server-side; the response carries only what a tenant may
    // read. See `api-failure.ts`.
    console.error("[google-connect] discovery failed:", err);
    return NextResponse.json(
      safeFailure(
        err,
        "google",
        { superadmin: isSuperadmin(got.session) },
        "Could not read the accounts on that Google login.",
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

  const found = readGoogleStash(parsed.data.stash, id);
  if (!found.ok) {
    return NextResponse.json({ error: stashError(found.reason) }, { status: 400 });
  }

  // Re-discovered rather than trusting ids off the wire: it re-verifies that the
  // authorizing account can actually reach each one, and it is where the
  // per-account `login-customer-id` comes from. Attaching an id the token
  // cannot reach would store an account that reports zero forever.
  const { accounts, partial } = await discoverGoogleAccounts(found.refreshToken);
  const byId = new Map(accounts.map((a) => [a.customerId, a]));

  const attached: string[] = [];
  const failed: Array<{ customerId: string; error: string }> = [];

  for (const customerId of parsed.data.customerIds) {
    const node = byId.get(customerId);
    if (!node) {
      /*
       * 🔴 Two different causes, and only one of them is the operator's
       * problem.
       *
       * Discovery walks each accessible manager and swallows a branch that
       * fails, so that one suspended manager does not cost the other four.
       * That means an absent account is either genuinely out of reach OR a
       * branch that happened to error on this pass — and telling someone their
       * login "cannot reach" an account they can see in Ads Manager sends them
       * to re-authorize, re-link, and eventually to support, for a 500 that
       * would have cleared on a retry.
       *
       * `partial` is exactly the signal that distinguishes them, and it was
       * already being computed and thrown away here.
       */
      failed.push({
        customerId,
        error: partial
          ? "Could not list every account this login can reach — part of the " +
            "hierarchy did not respond. Try again; if it repeats, the account " +
            "may genuinely be out of reach."
          : "That Google login cannot reach this account.",
      });
      continue;
    }
    if (node.isManager) {
      // Manager accounts hold no spend of their own; attaching one guarantees a
      // permanently empty dashboard.
      failed.push({
        customerId,
        error: "This is a manager account — pick the accounts beneath it instead.",
      });
      continue;
    }
    try {
      await addGoogleAccount(
        id,
        customerId,
        found.refreshToken,
        // 🔴 The manager to reach it through, resolved at discovery. Without
        // this the sync would fall back to the agency MCC and return nothing.
        node.loginCustomerId,
      );
      attached.push(customerId);
    } catch (err) {
      failed.push({
        customerId,
        error: safeFailureMessage(err, "google"),
      });
    }
  }

  // The credential now lives, encrypted, on the accounts themselves.
  if (attached.length > 0) dropGoogleStash(parsed.data.stash);

  await record({
    action: "google.accounts_attached",
    targetType: "client",
    targetId: id,
    clientId: id,
    ...requestContext(req),
    metadata: { attached: attached.length, failed: failed.length },
  });

  /*
   * Start pulling history now, rather than leaving the dashboard empty until
   * the nightly cron. `after()` so this response returns immediately — see
   * `kickFirstSync`, which also guards against re-importing.
   */
  if (attached.length > 0) {
    after(async () => {
      await kickFirstSync(client, "google");
    });
  }

  return NextResponse.json({ attached, failed });
}

function stashError(reason: "expired" | "wrong_client"): string {
  return reason === "wrong_client"
    ? "That sign-in was for a different client. Start again from this client's setup page."
    : "That Google sign-in has expired. It only stays open for a few minutes — please sign in again.";
}
