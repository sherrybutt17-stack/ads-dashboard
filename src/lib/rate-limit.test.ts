import { describe, it, expect } from "vitest";
import { rateLimit, clientIp } from "./rate-limit";

/**
 * The fixed-window limiter itself.
 *
 * `rate-limit-usage.test.ts` already checks that every call SITE reads `.ok` —
 * and says in its own header that "a unit test of `rateLimit` itself passes
 * because the function is correct". That was an assumption: no such test
 * existed. This is it.
 *
 * What it guards is the login endpoint. If the window never resets, a client
 * locks themselves out permanently after one bad afternoon; if the counter
 * never trips, `/api/auth` is open to an unbounded password guess. Both are
 * silent — the happy path looks identical either way.
 *
 * 🔴 Every test passes an explicit `now` and a unique key. The bucket map is
 * module state shared by the whole file, so a test that relied on the real
 * clock or reused a key would pass or fail depending on what ran before it.
 */

let n = 0;
/** A key no other test has touched. */
const key = () => `test-key-${n++}`;

describe("rateLimit", () => {
  it("allows exactly `limit` calls inside the window", () => {
    const k = key();
    const t = 1_000_000;

    for (let i = 0; i < 5; i++) {
      expect(rateLimit(k, 5, 60_000, t).ok).toBe(true);
    }
    // The sixth is the first refusal — off by one here is the difference
    // between allowing 5 and allowing 6 password attempts.
    expect(rateLimit(k, 5, 60_000, t).ok).toBe(false);
  });

  it("reports how long until the window resets", () => {
    const k = key();
    const t = 1_000_000;
    rateLimit(k, 1, 60_000, t);

    const denied = rateLimit(k, 1, 60_000, t + 15_000);
    expect(denied.ok).toBe(false);
    // Drives the `Retry-After` header; a wrong value tells the caller to come
    // back while still blocked, or long after the block has lifted.
    expect(denied.retryAfterMs).toBe(45_000);
  });

  it("reports 0 when allowed", () => {
    expect(rateLimit(key(), 5, 60_000, 1_000_000).retryAfterMs).toBe(0);
  });

  it("🔴 reopens once the window has passed", () => {
    const k = key();
    const t = 1_000_000;
    rateLimit(k, 1, 60_000, t);
    expect(rateLimit(k, 1, 60_000, t + 59_999).ok).toBe(false);

    // Without this a client is locked out permanently after one bad afternoon,
    // and the only remedy is a redeploy.
    expect(rateLimit(k, 1, 60_000, t + 60_000).ok).toBe(true);
  });

  it("starts a fresh window rather than resuming the old count", () => {
    const k = key();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) rateLimit(k, 3, 60_000, t);

    // After the reset the full allowance is available again.
    for (let i = 0; i < 3; i++) {
      expect(rateLimit(k, 3, 60_000, t + 60_001).ok).toBe(true);
    }
    expect(rateLimit(k, 3, 60_000, t + 60_001).ok).toBe(false);
  });

  it("🔴 keeps keys independent", () => {
    const a = key();
    const b = key();
    const t = 1_000_000;

    rateLimit(a, 1, 60_000, t);
    expect(rateLimit(a, 1, 60_000, t).ok).toBe(false);
    // One IP exhausting its allowance must not lock out everybody else —
    // the difference between rate limiting and an outage.
    expect(rateLimit(b, 1, 60_000, t).ok).toBe(true);
  });

  it("does not extend the window when a blocked caller keeps hammering", () => {
    const k = key();
    const t = 1_000_000;
    rateLimit(k, 1, 60_000, t);

    // Fixed window, not sliding: refusals are free and do not push the reset
    // out, so an attacker cannot hold a real user locked out indefinitely.
    for (let i = 0; i < 20; i++) rateLimit(k, 1, 60_000, t + 1_000);
    expect(rateLimit(k, 1, 60_000, t + 60_001).ok).toBe(true);
  });

  it("⚠️ a limit of 0 still allows one call per window", () => {
    /*
     * Documenting a quirk, not endorsing it. The "no bucket yet" branch returns
     * `ok` before the limit is consulted, so `limit: 0` behaves exactly like
     * `limit: 1` rather than refusing outright.
     *
     * Not a live defect — every call site passes a literal of 3 or more — but
     * it matters if one ever computes its limit, because `limit: 0` reads as
     * "closed" and behaves as "open once". Asserted so the behaviour is a known
     * quantity rather than a surprise found during an incident.
     */
    const k = key();
    const t = 1_000_000;
    expect(rateLimit(k, 0, 60_000, t).ok).toBe(true);
    expect(rateLimit(k, 0, 60_000, t).ok).toBe(false);
  });
});

describe("clientIp", () => {
  it("takes the first hop of x-forwarded-for", () => {
    const req = new Request("https://x.test", {
      headers: { "x-forwarded-for": "203.0.113.9, 70.41.3.18, 150.172.238.178" },
    });
    /*
     * The first entry is the client; the rest are proxies. Taking the last
     * would key every request on our own edge address, which collapses the
     * whole limiter into one global bucket — every user sharing one allowance.
     */
    expect(clientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("https://x.test", {
      headers: { "x-real-ip": "  198.51.100.7  " },
    });
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  it("🔴 returns a constant rather than empty when nothing identifies the caller", () => {
    /*
     * `"unknown"` is deliberate: an empty string would make the key collapse to
     * the bare prefix, which is still one shared bucket — but silently, and
     * only for requests arriving without proxy headers. A named constant keeps
     * that case visible in any debugging.
     */
    expect(clientIp(new Request("https://x.test"))).toBe("unknown");
    expect(
      clientIp(new Request("https://x.test", { headers: { "x-real-ip": "   " } })),
    ).toBe("unknown");
  });
});

/**
 * 🔴 Which header the limiter trusts.
 *
 * A limiter keyed on a caller-controlled value is not a limiter. On Vercel
 * `x-forwarded-for` is overwritten at the edge specifically to prevent
 * spoofing, so this is not currently exploitable — but that guarantee is voided
 * by "a proxy on top of Vercel", which is exactly what a client-owned vanity
 * domain fronted by Cloudflare would be.
 */
describe("clientIp", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://example.com", { headers });

  it("prefers Vercel's own header over the spoofable one", () => {
    /*
     * The ordering that matters. If both are present and they disagree, the one
     * a proxy in front of Vercel could have written must lose.
     */
    expect(
      clientIp(
        req({
          "x-vercel-forwarded-for": "203.0.113.9",
          "x-forwarded-for": "1.1.1.1",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  it("falls back through x-forwarded-for to x-real-ip", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(req({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("takes the leftmost address of a chain", () => {
    // Where a chain appears at all, the leftmost is the original client; the
    // rest are proxies that would collapse every caller onto one key.
    expect(
      clientIp(req({ "x-forwarded-for": "203.0.113.9, 70.41.3.18, 150.172.238.178" })),
    ).toBe("203.0.113.9");
  });

  it("🔴 never returns empty, which would collapse every caller onto one key", () => {
    // An empty key is worse than no limiter: it throttles everybody together,
    // so one noisy caller locks out every real user.
    expect(clientIp(req({}))).toBe("unknown");
    expect(clientIp(req({ "x-forwarded-for": "" }))).toBe("unknown");
    expect(clientIp(req({ "x-forwarded-for": "  ,  " }))).toBe("unknown");
  });
});
