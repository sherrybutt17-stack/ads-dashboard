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

/** Best-effort client IP from proxy headers, for use as a limiter key. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
