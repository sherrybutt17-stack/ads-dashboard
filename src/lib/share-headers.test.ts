import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

/**
 * Response headers for the share route.
 *
 * This has a test because the naive version of it silently did not work. Both
 * `/r/:path*` and `/:path*` matched a share URL, and the response came back
 * with the GENERIC `Referrer-Policy` — the more specific rule lost. Nothing
 * errored; the header was simply the wrong one, and the only way to notice was
 * to look.
 *
 * That matters more here than for a normal header: the share token IS the path.
 * `strict-origin-when-cross-origin` sends the full path on same-origin
 * requests, so every subresource fetch would carry a live credential in a
 * `Referer`.
 */

type HeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
};

async function rules(): Promise<HeaderRule[]> {
  const fn = nextConfig.headers;
  if (!fn) throw new Error("next.config sets no headers()");
  return (await fn()) as HeaderRule[];
}

const valueOf = (rule: HeaderRule, key: string) =>
  rule.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

describe("share route response headers", () => {
  it("has a rule for /r/", async () => {
    const share = (await rules()).find((r) => r.source.startsWith("/r/"));
    expect(share).toBeDefined();
  });

  it("sends no referrer at all from a share URL", async () => {
    const share = (await rules()).find((r) => r.source.startsWith("/r/"))!;
    expect(valueOf(share, "Referrer-Policy")).toBe("no-referrer");
  });

  it("declares exactly ONE Referrer-Policy on the share rule", async () => {
    // The share list is built by filtering the base list and appending. A
    // botched filter would leave both values present, and which one applies is
    // then whatever the framework happens to do.
    const share = (await rules()).find((r) => r.source.startsWith("/r/"))!;
    const referrers = share.headers.filter(
      (h) => h.key.toLowerCase() === "referrer-policy",
    );
    expect(referrers).toHaveLength(1);
  });

  it("tells crawlers not to index a shared report", async () => {
    const share = (await rules()).find((r) => r.source.startsWith("/r/"))!;
    expect(valueOf(share, "X-Robots-Tag")).toContain("noindex");
  });

  it("keeps the baseline protections rather than replacing them", async () => {
    const share = (await rules()).find((r) => r.source.startsWith("/r/"))!;
    for (const key of [
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Permissions-Policy",
    ]) {
      expect(valueOf(share, key), `${key} missing from the share rule`).toBeTruthy();
    }
  });

  it("🔴 no OTHER rule also matches a share URL", async () => {
    /*
     * The actual defect. A second matching rule that sets `Referrer-Policy`
     * takes precedence in practice, which puts the token back in the `Referer`
     * header with no visible sign that anything is wrong.
     */
    const others = (await rules()).filter((r) => !r.source.startsWith("/r/"));
    for (const rule of others) {
      const matches = toRegExp(rule.source).test("/r/abc123");
      expect(
        matches,
        `"${rule.source}" also matches a share URL and would contest its headers`,
      ).toBe(false);
    }
  });

  it("the generic rule still covers everything else", async () => {
    // Guards the guard: excluding /r/ too aggressively (say, with `/x/:path*`)
    // would leave the whole app without its baseline headers.
    const generic = (await rules()).filter((r) => !r.source.startsWith("/r/"));
    for (const path of ["/login", "/c/acme", "/api/clients", "/users", "/audit"]) {
      expect(
        generic.some((r) => toRegExp(r.source).test(path)),
        `${path} would receive no security headers`,
      ).toBe(true);
    }
  });
});

/**
 * A workable stand-in for path-to-regexp, covering the two forms this config
 * uses: `:name*` and `:name(<regex>)`. Deliberately small — it exists to answer
 * "do these two sources overlap?", not to reimplement routing.
 */
function toRegExp(source: string): RegExp {
  const body = source
    .replace(/:[a-zA-Z]+\((.*?)\)/g, (_m, re) => `(?:${re})`)
    .replace(/:[a-zA-Z]+\*/g, ".*")
    .replace(/:[a-zA-Z]+/g, "[^/]+");
  return new RegExp(`^${body}$`);
}
