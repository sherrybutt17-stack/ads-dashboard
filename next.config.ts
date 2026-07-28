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

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
