import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A one-shot credential letting a headless renderer fetch one report.
 *
 * ── The problem this solves ───────────────────────────────────────────
 *
 * Server-side PDF rendering means a hosted browser somewhere fetches a URL of
 * ours and returns the bytes. That browser has no session cookie, so every page
 * in this app answers it with a 401. Something has to authorise the fetch.
 *
 * ── Why not just mint a share link ────────────────────────────────────
 *
 * Share links already do exactly this — public path, token in the URL, renders
 * the report with no session. Reusing them was the first design and it is
 * wrong on two counts: every PDF would leave a row in the share-link list that
 * an operator never chose to create and has to think about revoking, and the
 * shortest share TTL is seven days for a credential that needs to live for
 * about ninety seconds.
 *
 * ── Stateless, and why that is safe HERE specifically ─────────────────
 *
 * This token is an HMAC over the exact thing it authorises — client, range,
 * platform, expiry — so there is nothing to look up and nothing to store. That
 * is normally a trade: a stateless token cannot be revoked before it expires.
 * Here the expiry is `TTL_SECONDS`, so "cannot be revoked" means "for the next
 * minute and a half", which is a shorter window than a revocation would take to
 * reach a human anyway.
 *
 * The payload is signed rather than encrypted. It contains no secret — a client
 * id and two dates — and a reader learning which report is being rendered
 * learns nothing they could not get from the filename.
 *
 * ── No new environment variable ───────────────────────────────────────
 *
 * The signing key is derived from `ENCRYPTION_KEY` under a fixed label rather
 * than being its own secret. Domain separation means this key cannot be used to
 * forge anything else even if it leaks, and every additional required env var is
 * one more way a deploy comes up half-working.
 */

const TTL_SECONDS = 90;
const LABEL = "report-render-token/v1";

export interface RenderClaims {
  clientId: string;
  start: string;
  end: string;
  platform: string;
}

function signingKey(): Buffer {
  const master = process.env.ENCRYPTION_KEY;
  if (!master) {
    throw new Error(
      "ENCRYPTION_KEY is not set — it is the root of the report render token.",
    );
  }
  return createHmac("sha256", master).update(LABEL).digest();
}

/**
 * The signed part, as a canonical string.
 *
 * 🔴 Field-separated with a character that cannot appear in any field. Joining
 * on nothing, or on a character a value could contain, makes the signature
 * ambiguous: `{clientId: "ab", start: "cd"}` and `{clientId: "abc", start: "d"}`
 * would produce the same bytes, and one valid token would authorise a report it
 * was not issued for. The separator is `\n`, which is impossible in a uuid, a
 * date key or a platform name.
 */
function canonical(claims: RenderClaims, exp: number): string {
  return [claims.clientId, claims.start, claims.end, claims.platform, exp].join(
    "\n",
  );
}

export function mintRenderToken(
  claims: RenderClaims,
  now: number = Date.now(),
): string {
  const exp = Math.floor(now / 1000) + TTL_SECONDS;
  const body = canonical(claims, exp);
  const sig = createHmac("sha256", signingKey()).update(body).digest("base64url");
  /*
   * The claims travel in the token rather than alongside it in query
   * parameters. If the range were a separate parameter the signature would not
   * cover it, and a valid token could be replayed against any window.
   */
  return `${Buffer.from(body, "utf8").toString("base64url")}.${sig}`;
}

export type RenderTokenFailure = "malformed" | "bad_signature" | "expired";

export function verifyRenderToken(
  token: string | undefined | null,
  now: number = Date.now(),
): { ok: true; claims: RenderClaims } | { ok: false; reason: RenderTokenFailure } {
  if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const body = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  const provided = token.slice(dot + 1);

  const expected = createHmac("sha256", signingKey())
    .update(body)
    .digest("base64url");

  /*
   * Constant-time, and length-checked first because `timingSafeEqual` throws on
   * a length mismatch rather than returning false — an exception here would
   * surface as a 500 and distinguish "wrong length" from "wrong bytes" by
   * status code alone.
   */
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  const parts = body.split("\n");
  if (parts.length !== 5) return { ok: false, reason: "malformed" };
  const [clientId, start, end, platform, expRaw] = parts;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };
  /*
   * Expiry is checked AFTER the signature. Checking it first would let an
   * unsigned, attacker-authored payload decide whether the expensive comparison
   * runs, and would answer "expired" — a different message — for a forgery.
   */
  if (exp * 1000 <= now) return { ok: false, reason: "expired" };

  if (!clientId || !start || !end || !platform) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, claims: { clientId, start, end, platform } };
}

export const RENDER_TOKEN_TTL_SECONDS = TTL_SECONDS;
