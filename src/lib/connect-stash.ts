import { randomBytes } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { connectStash } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";

/**
 * The gap between "they signed in" and "these accounts are this client's".
 *
 * Both self-serve flows have it. A media buyer's Facebook account can reach
 * every account the agency manages; a Google account can sit above forty
 * customers. Attaching all of them because someone connected one client would
 * put another tenant's spend on this dashboard — so consent and selection are
 * two steps, and the credential waits here in between.
 *
 * ── 🔴 Why this is a table, and why it used to be a Map ───────────────
 *
 * Each provider kept its own `Map` in module scope, on the argument that an
 * in-process stash cannot leave a row holding live access to a client's ad
 * account for a decision that was abandoned two minutes after it started. The
 * argument was right; the consequence was that neither feature worked.
 *
 * On Vercel the OAuth callback and the account picker are different route
 * handlers — different serverless functions, each scaling to its own instances.
 * The Map written by the callback was never the Map read by the picker, so both
 * flows reported "that sign-in has expired" on **every** attempt, at any speed.
 * And because that is exactly what a genuine 15-minute timeout says, it read as
 * something the operator had done slowly rather than as a design that cannot
 * work on this platform.
 *
 * So the original concern is answered by rules rather than by absence: the
 * token is encrypted at rest, `expiresAt` is fifteen minutes out, every read
 * prunes what has passed, the row is deleted the moment accounts are attached,
 * and it cascades with the client. The exposure window is the one the Map had.
 *
 * ── One implementation, two providers ─────────────────────────────────
 *
 * Meta and Google had a stash each, near-identical and separately maintained.
 * The tenant check below is what stops a stash minted while connecting one
 * client from attaching another client's ad accounts — a rule that must not
 * exist in two copies that can drift apart.
 */

export type ConnectProvider = "meta" | "google";

const STASH_TTL_MS = 15 * 60_000;

/**
 * Delete everything past its expiry.
 *
 * On the read path rather than in a cron: a sweeper that silently stops running
 * leaves live credentials lying about and tells nobody, which is the shape of
 * failure this application exists to refuse. Every read pays for its own
 * cleanup, and the index on `expires_at` keeps that cheap.
 */
async function prune(): Promise<void> {
  await db.delete(connectStash).where(lte(connectStash.expiresAt, new Date()));
}

export async function putConnectStash(
  provider: ConnectProvider,
  clientId: string,
  token: string,
  tokenExpiresAt: Date | null = null,
): Promise<string> {
  await prune();
  const id = randomBytes(18).toString("base64url");
  await db.insert(connectStash).values({
    id,
    provider,
    clientId,
    // Encrypted at rest, as every other stored credential is. A row in a
    // database is exactly where a plaintext token must never sit.
    tokenEncrypted: encrypt(token),
    tokenExpiresAt,
    expiresAt: new Date(Date.now() + STASH_TTL_MS),
  });
  return id;
}

export type ConnectStashLookup =
  | { ok: true; clientId: string; token: string; tokenExpiresAt: Date | null }
  | { ok: false; reason: "expired" | "wrong_client" };

/**
 * Retrieve a stashed connection.
 *
 * `expectedClientId` is checked rather than trusted from the caller: the stash
 * id travels through a URL, and a stash minted for one client must not be
 * usable to attach accounts to another.
 *
 * `provider` is part of the lookup for the same reason — a stash redeemed down
 * the wrong provider's path would hand a Google refresh token to code that
 * expects a Meta access token, and the first thing that would do is fail
 * somewhere far from the cause.
 */
export async function readConnectStash(
  provider: ConnectProvider,
  id: string,
  expectedClientId: string,
): Promise<ConnectStashLookup> {
  await prune();
  const [found] = await db
    .select()
    .from(connectStash)
    .where(and(eq(connectStash.id, id), eq(connectStash.provider, provider)))
    .limit(1);

  // Unknown and expired are the same answer on purpose — `prune` has just
  // deleted anything past its time, and "start the sign-in again" is the only
  // useful instruction in either case.
  if (!found) return { ok: false, reason: "expired" };
  if (found.clientId !== expectedClientId) {
    return { ok: false, reason: "wrong_client" };
  }
  return {
    ok: true,
    clientId: found.clientId,
    token: decrypt(found.tokenEncrypted),
    tokenExpiresAt: found.tokenExpiresAt,
  };
}

export async function dropConnectStash(
  provider: ConnectProvider,
  id: string,
): Promise<void> {
  await db
    .delete(connectStash)
    .where(and(eq(connectStash.id, id), eq(connectStash.provider, provider)));
}
