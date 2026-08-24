import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isUpstreamError,
  safeFailure,
  safeFailureMessage,
} from "./api-failure";
import type { FailureSource } from "./health-errors";

/*
 * What comes back out of a setup-wizard route that just failed.
 *
 * Two opposite mistakes are possible here and this file exists to catch both:
 * leaking a third party's prose to a tenant, and redacting our OWN prose into
 * uselessness. The second is the easier one to ship by accident, because it
 * looks like security while quietly turning "that account belongs to another
 * client" into "Meta rejected the request".
 */

/** Same structural net as `health-errors.test.ts`. See the note there. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["our Meta app id", /\b\d{15,16}\b/],
  ["a Google manager account id", /loginCustomerId/i],
  ["an environment variable name", /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{3,}\b/],
  ["a JSON fragment", /[{}[\]"]/],
  ["a URL path", /\/[a-z]+\//i],
];

function expectSafe(text: string) {
  for (const [what, pattern] of FORBIDDEN) {
    expect(`${what}: ${text}`).not.toMatch(pattern);
  }
}

/**
 * Errors shaped like the real ones.
 *
 * Built by hand rather than imported, because importing `google/client.ts`
 * would drag `./oauth` and a database connection into a test of a module whose
 * entire point is having no dependencies. The risk that trade-off introduces —
 * a class renamed while these fixtures keep the old name and pass — is closed by
 * the `wiring` block at the bottom, which reads the real sources.
 */
function upstream(
  name: string,
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const err = new Error(message);
  err.name = name;
  return Object.assign(err, extra);
}

describe("isUpstreamError", () => {
  it("recognises the four API error classes by name", () => {
    for (const name of [
      "MetaApiError",
      "GoogleAdsError",
      "GhlApiError",
      "TiktokApiError",
    ]) {
      expect(isUpstreamError(upstream(name, "boom"))).toBe(true);
    }
  });

  it("does not treat our own throws as upstream", () => {
    expect(isUpstreamError(new Error("Account not found"))).toBe(false);
    expect(isUpstreamError(new TypeError("x is not a function"))).toBe(false);
    expect(isUpstreamError("a string")).toBe(false);
    expect(isUpstreamError(null)).toBe(false);
    expect(isUpstreamError(undefined)).toBe(false);
  });
});

describe("safeFailure — a third party's words", () => {
  /*
   * Each message is the shape its connector really produces. The Meta one names
   * our app id, the Google one our manager account, the GHL one a location id
   * inside a path — which is precisely why "just show the error" stopped being
   * acceptable the day a second agency existed.
   */
  const CASES: Array<{
    label: string;
    err: Error;
    source: FailureSource;
    cause: string;
  }> = [
    {
      label: "Meta, dead token",
      err: upstream(
        "MetaApiError",
        "Error validating access token: The user has not authorized application 1234567890123456",
        { status: 400, code: 190 },
      ),
      source: "meta",
      cause: "credential_invalid",
    },
    {
      label: "Meta, no permission on the account",
      err: upstream(
        "MetaApiError",
        '(#200) Requires ads_management permission {"error":{"code":200}}',
        { status: 403, code: 200 },
      ),
      source: "meta",
      cause: "no_access",
    },
    {
      label: "Meta, throttled",
      err: upstream("MetaApiError", "(#17) User request limit reached", {
        status: 400,
        code: 17,
      }),
      source: "meta",
      cause: "rate_limited",
    },
    {
      label: "Google, whole body interpolated",
      err: upstream(
        "GoogleAdsError",
        'Google Ads 403: {"error":{"details":[{"loginCustomerId":"7654321098"}]},"requestId":"abc"}',
        { status: 403 },
      ),
      source: "google",
      cause: "no_access",
    },
    {
      label: "GoHighLevel, path carries a location id",
      err: upstream(
        "GhlApiError",
        "GHL 401 on /locations/ve9EPM428h8vShlRW1KT: invalid token",
        { status: 401 },
      ),
      source: "ghl",
      cause: "credential_invalid",
    },
    {
      label: "TikTok, authoriser lost access",
      err: upstream("TiktokApiError", "advertiser not authorized", {
        code: 40105,
      }),
      source: "tiktok",
      cause: "credential_invalid",
    },
  ];

  for (const { label, err, source, cause } of CASES) {
    it(`redacts ${label}`, () => {
      const safe = safeFailure(err, source, {});
      expect(safe.cause).toBe(cause);
      expectSafe(safe.error);
      if (safe.hint) expectSafe(safe.hint);
      // The point of classifying rather than blanking: the reader still learns
      // which pipe broke.
      expect(safe.error.length).toBeGreaterThan(10);
    });
  }

  it("names the platform the call was made against, not the one in the text", () => {
    // A socket timeout carries no clue whose socket it was; `source` supplies it.
    const safe = safeFailure(
      upstream("TiktokApiError", "fetch failed", {}),
      "tiktok",
      {},
    );
    expect(safe.error).toContain("TikTok");
  });
});

describe("safeFailure — our own words", () => {
  /*
   * 🔴 The regression guard. These are the messages the wizard is FOR.
   */
  const OURS = [
    "Ad account id is required",
    "That ad account is already attached to another client",
    "Account not found",
    "Unknown client",
    "No token provided or stored",
  ];

  for (const message of OURS) {
    it(`passes through "${message}" unchanged`, () => {
      const safe = safeFailure(new Error(message), "meta", {});
      expect(safe.error).toBe(message);
      expect(safe.cause).toBeUndefined();
      expect(safe.hint).toBeUndefined();
    });
  }

  it("does not attach a diagnostic to a message it did not redact", () => {
    // Otherwise a superadmin reads the same sentence twice, the second time
    // under a heading implying it is extra detail.
    const safe = safeFailure(new Error("Account not found"), "meta", {
      superadmin: true,
    });
    expect(safe.diagnostic).toBeUndefined();
  });
});

describe("safeFailure — our own missing configuration", () => {
  /*
   * A plain `Error`, so the origin test alone would pass it through — and its
   * text names the environment variable that holds the credential.
   */
  const CONFIG = [
    "GOOGLE_ADS_DEVELOPER_TOKEN is not set.",
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID (your MCC id) is not set.",
    "META_SYSTEM_USER_TOKEN is not set",
  ];

  for (const message of CONFIG) {
    it(`redacts "${message}"`, () => {
      const safe = safeFailure(new Error(message), "google", {});
      expect(safe.cause).toBe("not_configured");
      expectSafe(safe.error);
      expect(safe.error).not.toContain("GOOGLE_ADS");
      // Said out loud to be ours, so nobody re-enters a credential forever.
      expect(`${safe.error} ${safe.hint}`).toMatch(/our side|contact support/i);
    });
  }
});

describe("safeFailure — a bug, not an answer", () => {
  it("does not dress a TypeError up as an explanation", () => {
    const safe = safeFailure(
      new TypeError("Cannot read properties of undefined (reading 'adAccountId')"),
      "meta",
      {},
    );
    expect(safe.error).not.toContain("undefined");
    expect(safe.error).not.toContain("adAccountId");
    expect(safe.cause).toBe("unknown");
  });

  it("survives a throw that is not an Error at all", () => {
    for (const thrown of [null, undefined, "boom", 42, { oops: true }]) {
      const safe = safeFailure(thrown, "meta", {});
      expect(typeof safe.error).toBe("string");
      expect(safe.error.length).toBeGreaterThan(0);
      expectSafe(safe.error);
    }
  });

  it("takes the caller's fallback when one is given", () => {
    const safe = safeFailure(new TypeError("nope"), "meta", {}, "Sync failed");
    expect(safe.error).toBe("Sync failed");
  });
});

describe("safeFailure — who sees the raw text", () => {
  const err = upstream(
    "MetaApiError",
    "Error validating access token: The user has not authorized application 1234567890123456",
    { status: 400, code: 190 },
  );

  it("withholds the diagnostic from an agency operator", () => {
    /*
     * An agency owner passes every ownership check for their own client and is
     * still a customer — the string names OUR app registration.
     */
    const safe = safeFailure(err, "meta", { superadmin: false });
    expect(safe.diagnostic).toBeUndefined();
    expect(Object.keys(safe)).not.toContain("diagnostic");
  });

  it("gives it to a superadmin verbatim", () => {
    const safe = safeFailure(err, "meta", { superadmin: true });
    expect(safe.diagnostic).toBe(err.message);
  });

  it("treats a viewer with no flags as untrusted", () => {
    expect(safeFailure(err, "meta", {}).diagnostic).toBeUndefined();
  });
});

describe("safeFailureMessage", () => {
  it("returns the safe string alone, for per-account failure rows", () => {
    const msg = safeFailureMessage(
      upstream("MetaApiError", "(#190) token expired 1234567890123456", {
        code: 190,
      }),
      "meta",
    );
    expectSafe(msg);
    expect(typeof msg).toBe("string");
  });

  it("still passes our own row-level messages through", () => {
    const msg = safeFailureMessage(
      new Error("That Facebook login cannot reach this ad account."),
      "meta",
    );
    expect(msg).toBe("That Facebook login cannot reach this ad account.");
  });
});

/* ------------------------------------------------------------------ *
 * Wiring
 *
 * Detection is by `err.name`, so a renamed class would turn redaction off
 * silently — the tests above would keep passing on their fixtures while every
 * real error walked straight through. These read the real sources.
 * ------------------------------------------------------------------ */

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

describe("wiring", () => {
  const CLASSES: Array<[string, string[]]> = [
    ["MetaApiError", ["src", "lib", "meta", "client.ts"]],
    ["GoogleAdsError", ["src", "lib", "google", "client.ts"]],
    ["GhlApiError", ["src", "lib", "ghl", "client.ts"]],
    ["TiktokApiError", ["src", "lib", "tiktok", "client.ts"]],
  ];

  for (const [name, path] of CLASSES) {
    it(`${name} still sets the name this module matches on`, () => {
      const text = source(...path);
      expect(text).toContain(`export class ${name} extends Error`);
      expect(text).toContain(`this.name = "${name}";`);
    });
  }

  /**
   * Routes that reach a platform and report the outcome to a browser.
   *
   * Listed rather than globbed: a new connector route should fail this test and
   * be added deliberately, which is the only moment anyone will think about
   * whose words its errors carry.
   */
  const ROUTES: string[][] = [
    ["src", "app", "api", "clients", "[id]", "verify", "route.ts"],
    ["src", "app", "api", "clients", "[id]", "stages", "route.ts"],
    ["src", "app", "api", "clients", "[id]", "sync", "route.ts"],
    ["src", "app", "api", "clients", "[id]", "meta-accounts", "route.ts"],
    ["src", "app", "api", "clients", "[id]", "google-accounts", "route.ts"],
    ["src", "app", "api", "clients", "[id]", "meta-connect", "route.ts"],
    ["src", "app", "api", "clients", "[id]", "google-connect", "route.ts"],
    ["src", "app", "api", "clients", "[id]", "tiktok-connect", "route.ts"],
  ];

  /**
   * The OAuth callbacks, which are worse than the routes above.
   *
   * Their message does not land in a JSON body read by one script — it is put
   * into a URL and redirected to. URLs get pasted into support threads, kept in
   * history and handed onward as a referrer, so these redact with no superadmin
   * exemption at all.
   */
  const CALLBACKS: string[][] = [
    ["src", "app", "api", "oauth", "callback", "route.ts"],
    ["src", "app", "api", "oauth", "meta", "callback", "route.ts"],
    ["src", "app", "api", "oauth", "google", "callback", "route.ts"],
    ["src", "app", "api", "oauth", "tiktok", "callback", "route.ts"],
  ];

  for (const path of [...ROUTES, ...CALLBACKS]) {
    const label = path.slice(3).join("/");
    it(`${label} redacts rather than echoing the upstream error`, () => {
      const text = source(...path);
      expect(text).toContain("@/lib/api-failure");
      /*
       * The exact line this whole module replaces. Matching on it means the
       * check fails if someone adds a new catch block in the old shape, not
       * merely if they delete the import.
       */
      expect(text).not.toMatch(
        /(error|message):\s*err instanceof Error \? err\.message/,
      );
    });
  }

  it("no superadmin exemption reaches a message that travels in a URL", () => {
    for (const path of CALLBACKS) {
      const text = source(...path);
      expect(text).not.toContain("isSuperadmin");
      // `safeFailureMessage` is the no-diagnostic form; `safeFailure` is not.
      expect(text).toContain("safeFailureMessage");
    }
  });
});
