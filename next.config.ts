import type { NextConfig } from "next";

/**
 * Baseline security response headers, applied to every route.
 *
 * A full Content-Security-Policy is intentionally NOT set here: the App Router
 * emits inline hydration scripts, so a meaningful CSP needs per-request nonces
 * (a middleware change) rather than a static header with `unsafe-inline`, which
 * would defeat the point. The headers below are the safe, high-value subset that
 * needs no nonce plumbing.
 */
const securityHeaders = [
  // Force HTTPS for two years incl. subdomains. Ignored by browsers over plain
  // http (local dev), so it is safe to send everywhere.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Stop MIME sniffing (a classic drive-by upload → script vector).
  { key: "X-Content-Type-Options", value: "nosniff" },
  // No framing — the dashboard is never meant to be embedded (clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
  // Don't leak full dashboard URLs (which can carry client slugs) to third parties.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Drop ambient access to powerful APIs the app never uses.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

/**
 * Shared reports get stricter treatment than the rest of the app.
 *
 * 🔴 **The token is IN the URL, and a URL leaks.** `strict-origin-when-cross-origin`
 * above sends the full path on same-origin requests and the bare origin
 * cross-origin — which is fine for a dashboard, where the path carries only a
 * slug, and wrong here, where the path IS the credential. `no-referrer` means no
 * subresource, redirect or outbound click can carry it anywhere.
 *
 * `noindex` on top: a share link pasted into anything a crawler can read must
 * not end up in a search index. The page also declares this in its metadata; a
 * header additionally covers non-HTML responses and crawlers that never parse
 * the document.
 */
const shareHeaders = [
  ...securityHeaders.filter((h) => h.key !== "Referrer-Policy"),
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

const nextConfig: NextConfig = {
  async headers() {
    /*
     * The generic rule EXCLUDES /r/ rather than being overridden by a more
     * specific rule listed alongside it.
     *
     * Measured, not assumed: with both `/r/:path*` and `/:path*` matching a
     * share URL, the response carried the generic
     * `Referrer-Policy: strict-origin-when-cross-origin` — the specific rule did
     * NOT win. Two matching sources that set the same header key do not resolve
     * the way "most specific wins" would suggest. Making the rules disjoint
     * removes the question entirely, which for a header whose job is to stop a
     * credential leaking is the only acceptable answer.
     */
    return [
      { source: "/r/:path*", headers: shareHeaders },
      // Everything that is NOT a share route. Negative lookahead in the param
      // pattern, which is how path-to-regexp expresses "all paths except".
      { source: "/:path((?!r/).*)", headers: securityHeaders },
    ];
  },
};

export default nextConfig;
