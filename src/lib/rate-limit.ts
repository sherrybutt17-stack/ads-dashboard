/**
 * Minimal in-process fixed-window rate limiter.
 *
 * Scope and honesty about it: this is per-instance memory, so on a serverless
 * platform each lambda has its own counter and a determined attacker spread
 * across instances gets a higher effective ceiling. It still meaningfully blunts
 * a single-source password brute-force against `/api/auth`, which is the threat
 * it exists for. For hard guarantees, back it with a shared store (Vercel KV /
 * Upstash) keyed the same way — the call sites do not change.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  /** Milliseconds until the window resets (0 when allowed). */
  retryAfterMs: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  // Opportunistic prune so distinct keys can't grow the map without bound.
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterMs: 0 };
  }

  if (existing.count >= limit) {
    return { ok: false, retryAfterMs: existing.resetAt - now };
  }

  existing.count += 1;
  return { ok: true, retryAfterMs: 0 };
}

/**
 * Best-effort client IP from proxy headers, for use as a limiter key.
 *
 * ── Why the header order is what it is ────────────────────────────────
 *
 * A limiter keyed on a value the caller controls is not a limiter — spoof a
 * fresh IP per request and sign-up, sign-in and PDF rendering are all
 * unthrottled. So the question is which of these headers an attacker can set.
 *
 * On Vercel, `x-forwarded-for` is safe, and this was checked rather than
 * assumed: *"If you are trying to use Vercel behind a proxy, we currently
 * overwrite the X-Forwarded-For header and do not forward external IPs. This
 * restriction is in place to prevent IP spoofing."*
 *
 * `x-vercel-forwarded-for` is preferred anyway, for the one case their docs
 * carve out: *"x-forwarded-for could be overwritten if you're using a proxy on
 * top of Vercel."* Putting Cloudflare in front — the obvious move for
 * client-owned vanity domains — is exactly that case, and it would silently
 * hand the limiter a caller-supplied value. Vercel's own header cannot be
 * reached that way.
 *
 * The fallback still takes the FIRST entry: where these headers are trustworthy
 * they hold one address, and where a chain appears the leftmost is the original
 * client. Neither is currently exploitable on this deployment.
 */
export function clientIp(req: Request): string {
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  return (
    first(req.headers.get("x-vercel-forwarded-for")) ??
    first(req.headers.get("x-forwarded-for")) ??
    first(req.headers.get("x-real-ip")) ??
    "unknown"
  );
}
