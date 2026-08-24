import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTiktokAuthorizeUrl,
  exchangeTiktokCode,
  isTiktokConnectConfigured,
  tiktokRedirectUri,
} from "./oauth";

/*
 * TikTok's OAuth differs from Meta's and Google's in four ways, and every one of
 * them fails SILENTLY rather than loudly — the flow completes, a token-shaped
 * value is stored, and the first symptom is a dashboard reading $0 with a green
 * health check. That is the exact failure this whole application exists to
 * replace, so each difference gets a test.
 */

const ENV = { ...process.env };

beforeEach(() => {
  process.env.TIKTOK_APP_ID = "app-1";
  process.env.TIKTOK_APP_SECRET = "secret-1";
  process.env.NEXT_PUBLIC_APP_URL = "https://example.test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ENV };
});

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response;

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

const OK = {
  code: 0,
  message: "OK",
  data: { access_token: "tok-abc", advertiser_ids: ["7012345678901234567"] },
};

describe("configuration", () => {
  it("is unconfigured when either half is missing", () => {
    delete process.env.TIKTOK_APP_SECRET;
    expect(isTiktokConnectConfigured()).toBe(false);
  });

  it("builds the redirect from NEXT_PUBLIC_APP_URL", () => {
    expect(tiktokRedirectUri()).toBe(
      "https://example.test/api/oauth/tiktok/callback",
    );
  });

  it("🔴 tolerates a trailing slash on the base url", () => {
    /*
     * TikTok matches the registered Advertiser redirect URL character for
     * character, and a double slash is a different string. The failure lands at
     * the exchange with a message that does not mention the URL, so it is
     * expensive to trace back to one stray character in an env var.
     */
    process.env.NEXT_PUBLIC_APP_URL = "https://example.test/";
    expect(tiktokRedirectUri()).toBe(
      "https://example.test/api/oauth/tiktok/callback",
    );
  });
});

describe("authorize url", () => {
  it("carries app_id, redirect_uri and state", () => {
    const url = new URL(buildTiktokAuthorizeUrl("signed-state"));
    expect(url.origin + url.pathname).toBe(
      "https://business-api.tiktok.com/portal/auth",
    );
    expect(url.searchParams.get("app_id")).toBe("app-1");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("redirect_uri")).toBe(tiktokRedirectUri());
  });

  it("🔴 sends no scope parameter", () => {
    /*
     * Scopes are frozen when the TikTok app is created, not requested per
     * authorization. Adding a `scope` param here would look like it was doing
     * something while changing nothing — and would hide the real constraint,
     * which is that a missing scope needs an entirely new app.
     */
    const url = new URL(buildTiktokAuthorizeUrl("s"));
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("token exchange", () => {
  it("posts exactly app_id, secret and auth_code as JSON", async () => {
    const spy = stubFetch(async () => json(OK));
    await exchangeTiktokCode("the-auth-code");

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe(
      "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
    );
    expect(init.method).toBe("POST");
    /*
     * 🔴 Form-encoding this reaches a DIFFERENT endpoint (`/oauth/token/`) that
     * answers a different question. The content type is load-bearing.
     */
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );

    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      app_id: "app-1",
      secret: "secret-1",
      auth_code: "the-auth-code",
    });
    // Neither exists on this endpoint. Sending them is how the first draft failed.
    expect(body).not.toHaveProperty("grant_type");
    expect(body).not.toHaveProperty("redirect_uri");
    expect(body).not.toHaveProperty("code");
  });

  it("returns the token and the advertiser ids", async () => {
    stubFetch(async () => json(OK));
    const out = await exchangeTiktokCode("c");
    expect(out.accessToken).toBe("tok-abc");
    expect(out.advertiserIds).toEqual(["7012345678901234567"]);
  });

  it("🔴 throws on a non-zero body code despite the HTTP 200", async () => {
    /*
     * The trap. `res.ok` is true and `res.status` is 200 on a REFUSED exchange.
     * A version of this that checked only the HTTP status would return
     * `accessToken: undefined` as a success.
     */
    stubFetch(async () => json({ code: 40002, message: "Auth code expired" }));
    await expect(exchangeTiktokCode("stale")).rejects.toThrow(/Auth code expired/);
  });

  it("🔴 never returns an undefined token as success", async () => {
    // code 0 but no data — the shape that would slip past a code-only check.
    stubFetch(async () => json({ code: 0, message: "OK", data: {} }));
    await expect(exchangeTiktokCode("c")).rejects.toThrow(/no access token/i);
  });

  it("reports a non-JSON response rather than throwing a parse error", async () => {
    stubFetch(
      async () =>
        ({ ok: false, status: 502, text: async () => "<html>gateway</html>" }) as unknown as Response,
    );
    await expect(exchangeTiktokCode("c")).rejects.toThrow(/non-JSON/);
  });

  it("refuses to run unconfigured", async () => {
    delete process.env.TIKTOK_APP_ID;
    const spy = stubFetch(async () => json(OK));
    await expect(exchangeTiktokCode("c")).rejects.toThrow(/TIKTOK_APP_ID/);
    // And does not reach the network with an empty app id.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("🔴 the callback reads auth_code, not code", () => {
  /*
   * The highest-value guard in this file, and the one thing no unit test of
   * `exchangeTiktokCode` can catch: TikTok's callback carries BOTH `code` and
   * `auth_code`, and its own documentation contradicts itself about which to
   * use. Only `auth_code` is accepted by the token endpoint. Reading `code`
   * yields a plausible string that exchanges for nothing, and the error message
   * does not name the parameter — so the mistake is expensive to find and
   * trivial to reintroduce.
   */
  const SRC = readFileSync(
    join(__dirname, "..", "..", "app", "api", "oauth", "tiktok", "callback", "route.ts"),
    "utf8",
  );

  /*
   * Negative assertions run against code with comments removed.
   *
   * Without this they are unrunnable: the callback documents both of these traps
   * in prose, so "the source must not contain `tokenExpiresAt`" fails on the
   * comment that explains why it is absent. Stripping only block comments and
   * whole-line `//` is enough here and leaves `https://` intact, which a naive
   * strip would eat.
   */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("reads the auth_code parameter", () => {
    expect(CODE).toContain('searchParams.get("auth_code")');
  });

  it("never reads the code parameter", () => {
    expect(
      CODE.includes('searchParams.get("code")'),
      "the TikTok callback must read auth_code — `code` is the decoy TikTok also sends",
    ).toBe(false);
  });

  it("records no fabricated token expiry", () => {
    /*
     * TikTok tokens do not expire and there is no refresh token. Meta's callback
     * stores `tokenExpiresAt`; copying that here would put a date in the audit
     * log and on the account that means nothing, and would eventually drive a
     * health check to warn about a lapse that cannot happen.
     */
    expect(CODE).not.toMatch(/tokenExpiresAt/);
  });
});
