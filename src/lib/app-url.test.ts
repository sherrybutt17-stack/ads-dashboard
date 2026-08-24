import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appBaseUrl, appBaseUrlOr } from "./app-url";

/**
 * Where this deployment thinks it lives.
 *
 * This is a four-line function and it decides the contents of a password-reset
 * email, an address-verification email, a scheduled-report email, four OAuth
 * `redirect_uri`s, and the webhook URL an operator pastes into GoHighLevel.
 * Every one of those is written once and read by something we do not control —
 * a mail client, Google's consent screen, GHL's outbound webhook — so a wrong
 * answer is not corrected on the next render. It is delivered.
 *
 * That is why these tests are mostly about the ORDER of the fallbacks rather
 * than about parsing.
 */

const KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "NODE_ENV",
  "PORT",
] as const;

/*
 * `vi.stubEnv` rather than assigning to `process.env` — @types/node declares
 * NODE_ENV read-only, so a direct assignment runs under vitest and fails
 * `tsc --noEmit`, which is a test that only breaks in CI.
 */
function env(values: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const k of KEYS) vi.stubEnv(k, values[k]);
}

beforeEach(() => env({}));
afterEach(() => vi.unstubAllEnvs());

describe("appBaseUrl", () => {
  it("prefers an explicit setting over everything else", () => {
    // The operator's answer wins even where we could work one out ourselves —
    // a custom domain in front of a Vercel deployment is the normal case, and
    // we must send people to the domain they recognise.
    env({
      NEXT_PUBLIC_APP_URL: "https://dash.example.com",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "proj.vercel.app",
      VERCEL_URL: "proj-abc123.vercel.app",
    });
    expect(appBaseUrl()).toBe("https://dash.example.com");
  });

  describe("🔴 when NEXT_PUBLIC_APP_URL is unset", () => {
    /*
     * The defect this module exists for. Fifteen call sites each answered
     * `?? "http://localhost:3000"`, so a production deploy missing one env var
     * mailed `http://localhost:3000/reset?token=…` to a real person and
     * reported the mail as sent.
     */
    it("uses the stable production domain, not the per-deploy hostname", () => {
      env({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "dash.vercel.app",
        VERCEL_URL: "dash-git-abc123-team.vercel.app",
        NODE_ENV: "production",
      });
      /*
       * Both are reachable today, and only one is reachable in a month. A
       * password-reset link is followed minutes later, but a scheduled-report
       * link has a TTL measured in days and a share link outlives several
       * deployments — pointing them at a deployment hostname is a link that
       * works in every test and rots in the field.
       */
      expect(appBaseUrl()).toBe("https://dash.vercel.app");
    });

    it("uses the deployment's own hostname on a preview branch", () => {
      // The one case where the production domain is the wrong answer: a
      // preview's OAuth round-trip and links must come back to the preview.
      env({
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_PRODUCTION_URL: "dash.vercel.app",
        VERCEL_URL: "dash-git-abc123-team.vercel.app",
        NODE_ENV: "production",
      });
      expect(appBaseUrl()).toBe("https://dash-git-abc123-team.vercel.app");
    });

    it("adds the scheme Vercel omits", () => {
      // `VERCEL_URL` is a bare hostname. Concatenated as-is it produces
      // `dash.vercel.app/reset?token=…`, which a mail client renders as a
      // relative path and resolves against its own origin.
      env({ VERCEL_URL: "dash.vercel.app", NODE_ENV: "production" });
      expect(appBaseUrl()).toBe("https://dash.vercel.app");
    });

    it("falls back to localhost in development", () => {
      env({ NODE_ENV: "development" });
      expect(appBaseUrl()).toBe("http://localhost:3000");
    });

    it("honours a non-default dev port", () => {
      env({ NODE_ENV: "development", PORT: "4000" });
      expect(appBaseUrl()).toBe("http://localhost:4000");
    });

    it("🔴 returns null rather than localhost in production", () => {
      /*
       * The heart of it. A localhost URL is correct in development and is
       * never correct in production, so with nothing to go on we say so and
       * let each caller decide — the alert payload omits its link, the PDF
       * route answers 501, the wizard shows what it has. All three are honest.
       * `http://localhost:3000` in a stranger's inbox is not.
       */
      env({ NODE_ENV: "production" });
      expect(appBaseUrl()).toBeNull();
    });
  });

  describe("normalising what it is given", () => {
    it("strips every trailing slash, not just one", () => {
      // Two of the old call sites used /\/$/ and two used /\/+$/, so the same
      // env var produced `https://x.com//api/webhooks/…` in half the app.
      env({ NEXT_PUBLIC_APP_URL: "https://dash.example.com///" });
      expect(appBaseUrl()).toBe("https://dash.example.com");
    });

    it("adds a scheme to a bare hostname", () => {
      env({ NEXT_PUBLIC_APP_URL: "dash.example.com" });
      expect(appBaseUrl()).toBe("https://dash.example.com");
    });

    it("leaves an http:// setting alone", () => {
      // Self-hosting behind a terminating proxy is legitimate; do not force
      // https onto a URL someone stated deliberately.
      env({ NEXT_PUBLIC_APP_URL: "http://internal.lan:8080" });
      expect(appBaseUrl()).toBe("http://internal.lan:8080");
    });

    it("treats blank and whitespace-only as unset", () => {
      // `NEXT_PUBLIC_APP_URL=` in a dashboard is an empty string, not an
      // absent key, and `"" ?? fallback` keeps the empty string.
      env({ NEXT_PUBLIC_APP_URL: "   ", VERCEL_URL: "dash.vercel.app" });
      expect(appBaseUrl()).toBe("https://dash.vercel.app");
    });

    it("keeps a path prefix for an app mounted under a subpath", () => {
      env({ NEXT_PUBLIC_APP_URL: "https://example.com/dashboard/" });
      expect(appBaseUrl()).toBe("https://example.com/dashboard");
    });
  });
});

describe("appBaseUrlOr", () => {
  it("passes the base through when it is known", () => {
    env({ NEXT_PUBLIC_APP_URL: "https://dash.example.com" });
    expect(appBaseUrlOr("http://localhost:3000")).toBe("https://dash.example.com");
  });

  it("returns the caller's fallback when it is not", () => {
    /*
     * Each caller keeps its own answer to "and if we still cannot tell": the
     * alert senders omit the link entirely, the report link is left relative,
     * the setup wizard shows localhost because a developer running locally is
     * exactly who sees it. Centralising the derivation must not centralise
     * that judgement.
     */
    env({ NODE_ENV: "production" });
    expect(appBaseUrlOr(null)).toBeNull();
    expect(appBaseUrlOr("")).toBe("");
  });
});
