import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { shareLinks, type ShareLink } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { parseAdPlatform } from "@/lib/platforms";
import { appBaseUrlOr } from "@/lib/app-url";

/**
 * Share links — a read-only URL onto one client's report for one fixed period.
 *
 * The threat model, stated rather than implied: **the URL is the credential.**
 * It will be pasted into an email, forwarded, quoted in a reply chain, and
 * possibly logged by three mail providers on the way. Everything here follows
 * from accepting that rather than pretending otherwise:
 *
 *   · 256 bits of entropy, so guessing is not a route.
 *   · Only the HASH is stored, so a database leak does not hand over live links.
 *   · Mandatory expiry, because a forwarded URL cannot be recalled.
 *   · Revocation, because expiry is too slow when a link goes somewhere wrong.
 *   · An optional password, for when "anyone with the URL" is not good enough.
 *   · A frozen period, so what the link shows is what the sender saw.
 *
 * What a share link deliberately does NOT grant: lead-level data. The report it
 * opens is aggregate only. A board pack does not need forty people's names,
 * emails and phone numbers, and a link that travels this freely should not carry
 * them. That exclusion lives in the report route's section list, and is the
 * reason it is a list rather than "the whole dashboard, minus the chrome".
 */

/** How long a link may live. Anything longer is a link nobody remembers making. */
export const SHARE_TTL_DAYS = [7, 30, 90] as const;
export type ShareTtlDays = (typeof SHARE_TTL_DAYS)[number];
export const DEFAULT_SHARE_TTL_DAYS: ShareTtlDays = 30;

/** Minimum length for the optional gate. Short enough to read down a phone. */
export const MIN_SHARE_PASSWORD = 6;

export interface MintShareInput {
  clientId: string;
  rangeStart: string;
  rangeEnd: string;
  platform: string;
  label?: string | null;
  ttlDays: number;
  password?: string | null;
  createdBy?: string | null;
}

export interface MintedShare {
  /** Shown to the operator exactly once. Not recoverable afterwards. */
  token: string;
  row: ShareLink;
}

/**
 * SHA-256 of the bearer token, hex.
 *
 * A plain hash rather than scrypt, deliberately, and the distinction matters:
 * scrypt exists to make *low-entropy* secrets expensive to guess. This token is
 * 256 random bits, so there is nothing to guess and the only thing a slow hash
 * would buy is a slow lookup on the read path of a public URL.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** URL-safe, no padding — it has to survive being pasted into an email. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function mintShareLink(input: MintShareInput): Promise<MintedShare> {
  const token = newToken();
  const ttl = Number(input.ttlDays);
  const days = (SHARE_TTL_DAYS as readonly number[]).includes(ttl)
    ? ttl
    : DEFAULT_SHARE_TTL_DAYS;

  const [row] = await db
    .insert(shareLinks)
    .values({
      clientId: input.clientId,
      tokenHash: hashToken(token),
      label: input.label?.trim() || null,
      rangeStart: input.rangeStart,
      rangeEnd: input.rangeEnd,
      platform: parseAdPlatform(input.platform),
      passwordHash: input.password ? hashPassword(input.password) : null,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      createdBy: input.createdBy ?? null,
    })
    .returning();

  return { token, row };
}

/**
 * Why a token did not resolve.
 *
 * Separated from a plain null because the report route has to tell an expired
 * link apart from a revoked one apart from a typo — "this link expired on 3
 * August" is a message the recipient can act on; "not found" sends them back to
 * whoever sent it for no reason.
 *
 * The distinction is safe to reveal: it says nothing about whether any OTHER
 * token exists, only about the one already in the reader's hand.
 */
export type ShareFailure = "not_found" | "expired" | "revoked" | "unavailable";

export type ShareResolution =
  | { ok: true; link: ShareLink }
  | { ok: false; reason: ShareFailure };

export async function resolveShareToken(
  token: string | undefined,
  now: Date = new Date(),
): Promise<ShareResolution> {
  // Cheap structural reject before touching the database — the URL is public,
  // so this path is reachable by anything that crawls a link.
  if (!token || token.length < 32 || token.length > 128) {
    return { ok: false, reason: "not_found" };
  }

  /*
   * A database failure is NOT "this link is invalid".
   *
   * The distinction matters because the two have opposite remedies: a reader
   * told their link is invalid goes back to the sender for a new one, which
   * will fail identically, while the actual problem — an unmigrated or
   * unreachable database — is ours and needs no action from them at all.
   * Collapsing an outage into "not found" is the same class of dishonesty as a
   * dashboard rendering a paused ad account and an unreachable API as the same
   * empty box.
   */
  let link: ShareLink | undefined;
  try {
    [link] = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashToken(token)))
      .limit(1);
  } catch (err) {
    console.error("[share] lookup failed:", err);
    return { ok: false, reason: "unavailable" };
  }

  if (!link) return { ok: false, reason: "not_found" };
  // Revoked outranks expired: someone who deliberately killed a link should not
  // see it reported as merely having timed out.
  if (link.revokedAt) return { ok: false, reason: "revoked" };
  if (link.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, link };
}

/**
 * Record that a link was opened.
 *
 * Best-effort and never allowed to fail the render: a share link that 500s
 * because a counter could not be written is a worse outcome than a count that
 * is occasionally low.
 */
export async function recordShareView(id: string, now: Date = new Date()) {
  try {
    await db
      .update(shareLinks)
      .set({ lastViewedAt: now, viewCount: sql`${shareLinks.viewCount} + 1` })
      .where(eq(shareLinks.id, id));
  } catch {
    // Intentionally swallowed — see above.
  }
}

/** Verify the optional gate. Constant-time via scrypt, same as user passwords. */
export function checkSharePassword(link: ShareLink, attempt: string): boolean {
  if (!link.passwordHash) return true;
  return verifyPassword(attempt, link.passwordHash);
}

/**
 * A short-lived proof that the password was entered, for the viewer's cookie.
 *
 * Bound to the link id AND to its password hash, so changing or removing the
 * password invalidates every proof already issued — otherwise "I rotated the
 * password" would be a change that protects nothing.
 */
export function sharePassProof(link: ShareLink): string {
  return createHash("sha256")
    .update(`${link.id}:${link.passwordHash ?? ""}`)
    .digest("hex");
}

/**
 * Cookie holding that proof. Scoped to the link, so unlocking one shared report
 * never unlocks another that happens to use the same password.
 */
export function passCookieName(linkId: string): string {
  return `share_${linkId}`;
}

export function checkPassProof(link: ShareLink, presented: string | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(sharePassProof(link));
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function listShareLinks(clientId: string): Promise<ShareLink[]> {
  return db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.clientId, clientId))
    .orderBy(desc(shareLinks.createdAt))
    .limit(50);
}

/**
 * Revoke a link.
 *
 * Scoped by `clientId` as well as `id` — the caller has already been authorised
 * for a client, and matching on both means a mistaken or malicious id from
 * another tenant deletes nothing rather than deleting someone else's link.
 */
export async function revokeShareLink(
  id: string,
  clientId: string,
): Promise<boolean> {
  const rows = await db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(shareLinks.id, id),
        eq(shareLinks.clientId, clientId),
        // Already revoked → report "no change" rather than moving the timestamp
        // and making the audit trail lie about when it happened.
        sql`${shareLinks.revokedAt} IS NULL`,
      ),
    )
    .returning({ id: shareLinks.id });
  return rows.length > 0;
}

/**
 * The absolute URL an operator copies.
 *
 * Same env var as `webhookUrlFor`, so the deployment has one place to say what
 * it is called. The path is short on purpose: Chrome stamps the source URL into
 * the print margin unless the reader unticks "Headers and footers", and that
 * checkbox is not reachable from CSS or JS. A short URL on the agency's own
 * domain is the difference between a footer that reads as a letterhead and one
 * that reads as a leaked internal tool.
 */
export function shareUrlFor(token: string): string {
  const base = appBaseUrlOr("http://localhost:3000");
  return `${base}/r/${token}`;
}
