import { describe, it, expect } from "vitest";
import { canonicalHostRedirect } from "./proxy-rules";

/**
 * One deployment, two addresses, one cookie jar per address.
 *
 * The bug this rule exists for cost a real afternoon: signed in on
 * `ads-dashboard-shaheer4.vercel.app`, started Connect Google there, Google
 * returned the browser to `dash.growthguild.us` — the address the app builds
 * its redirect URIs from — and the edge refused it as `unauthorized` because no
 * session cookie exists on that host. The refresh token was discarded and the
 * screen said nothing about which of two working addresses was the wrong one.
 */

const DASH = "https://dash.growthguild.us";

function redirect(url: string, opts: Partial<Parameters<typeof canonicalHostRedirect>[0]> = {}) {
  return canonicalHostRedirect({
    url,
    canonicalOrigin: DASH,
    isPreview: false,
    ...opts,
  });
}

describe("canonicalHostRedirect", () => {
  it("sends a vercel.app page request to the custom domain, path and query intact", () => {
    expect(
      redirect("https://ads-dashboard-shaheer4.vercel.app/c/parfaire?range=30d"),
    ).toBe("https://dash.growthguild.us/c/parfaire?range=30d");
  });

  it("leaves a request that is already on the custom domain alone", () => {
    expect(redirect("https://dash.growthguild.us/c/parfaire")).toBeNull();
  });

  it("🔴 never redirects /api/ — a webhook sender is not a browser", () => {
    /*
     * GoHighLevel may be pointed at whichever host the operator was given. A
     * sender that does not follow a 308 drops the delivery, and a dropped stage
     * change is funnel history no later sync can reconstruct: GHL has no
     * stage-transition API to re-read it from.
     */
    expect(
      redirect("https://ads-dashboard-shaheer4.vercel.app/api/webhooks/crm/tok123"),
    ).toBeNull();
    // Cron is the same shape, and a redirect can strip an Authorization header.
    expect(
      redirect("https://ads-dashboard-shaheer4.vercel.app/api/cron/meta-sync"),
    ).toBeNull();
    // Including the OAuth callback itself, which must be able to answer on
    // whatever host the provider was configured with.
    expect(
      redirect("https://ads-dashboard-shaheer4.vercel.app/api/oauth/google/callback?code=x"),
    ).toBeNull();
  });

  it("🔴 never redirects a preview deployment", () => {
    // A preview's only address IS a vercel.app name. Bouncing it to production
    // would make previews untestable — a slower failure than the one fixed.
    expect(
      redirect("https://dash-git-branch-team.vercel.app/", { isPreview: true }),
    ).toBeNull();
  });

  it("does nothing when the canonical origin is unknown or itself a vercel.app name", () => {
    expect(
      redirect("https://ads-dashboard-shaheer4.vercel.app/", { canonicalOrigin: null }),
    ).toBeNull();
    /*
     * 🔴 The safety property. If NEXT_PUBLIC_APP_URL is unset and the base URL
     * falls back to the deployment's own vercel.app hostname, this must be a
     * no-op rather than a redirect loop pointing a host at itself.
     */
    expect(
      redirect("https://ads-dashboard-shaheer4.vercel.app/", {
        canonicalOrigin: "https://ads-dashboard-shaheer4.vercel.app",
      }),
    ).toBeNull();
  });

  it("🔴 cannot take the custom domain down if the base URL is wrong", () => {
    /*
     * The reason the rule keys off the REQUEST host being vercel.app rather off
     * "not canonical". With a mistyped base URL, a broad rule would bounce every
     * visitor — including those on the working domain — to a host that may not
     * answer, and the site would need a redeploy to come back.
     */
    expect(
      redirect("https://dash.growthguild.us/c/parfaire", {
        canonicalOrigin: "https://typo.example.com",
      }),
    ).toBeNull();
  });

  it("ignores a malformed URL rather than throwing at the edge", () => {
    expect(redirect("not-a-url")).toBeNull();
    expect(
      redirect("https://ads-dashboard-shaheer4.vercel.app/", { canonicalOrigin: "nonsense" }),
    ).toBeNull();
  });

  it("preserves the path on localhost development, which is never a vercel.app host", () => {
    expect(
      redirect("http://localhost:3000/c/parfaire", {
        canonicalOrigin: "http://localhost:3000",
      }),
    ).toBeNull();
  });
});
