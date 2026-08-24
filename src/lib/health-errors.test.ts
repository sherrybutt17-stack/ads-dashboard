import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeFailure,
  describeStoredFailure,
  redactDiagnostics,
  type FailureSource,
} from "./health-errors";

/*
 * What an agency is allowed to read off a broken connection.
 *
 * The fixtures below are not invented. Each is the shape a real connector
 * produces, traced back to the line that builds it, because the whole risk here
 * is a classifier that passes on strings nobody actually sends and lets the real
 * ones through untouched.
 */

/**
 * Things that must never reach a tenant, whatever the wording around them.
 *
 * The last three are structural rather than specific, and they are what makes
 * this list worth having. The named patterns only catch leaks I thought of; the
 * structural ones catch the shape of ALL of them — redacted output is prose we
 * wrote, so a JSON fragment, a URL path or a long opaque identifier in it means
 * something upstream got through regardless of which connector produced it.
 *
 * They were added after checking: without them the GoHighLevel and TikTok
 * fixtures below passed while completely unredacted, leaking a location id and
 * an internal API path. Two rows of a table asserting nothing at all.
 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["our Meta app id", /\b\d{15,16}\b/],
  ["a Google manager account id", /loginCustomerId/i],
  ["an environment variable name", /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{3,}\b/],
  ["a request id", /request[_ ]?id/i],
  ["the phrase 'system user'", /system user/i],
  ["the phrase 'developer token'", /developer token/i],
  ["the phrase 'MCC'", /\bMCC\b/],
  ["a JSON fragment", /[{}[\]"]/],
  ["a URL path", /\/\w/],
  ["a long opaque identifier", /\b[A-Za-z0-9]{20,}\b/],
];

function assertClean(text: string) {
  for (const [what, pattern] of FORBIDDEN) {
    expect(pattern.test(text), `leaked ${what}: ${text}`).toBe(false);
  }
}

/** Message + hint, which is everything a non-superadmin sees. */
function visible(raw: unknown, source: FailureSource): string {
  const f = describeFailure(raw, source);
  return `${f.message} ${f.hint ?? ""}`;
}

describe("classifying upstream failures", () => {
  it("reads a dead Meta token as a dead Meta token", () => {
    const err = Object.assign(new Error("Error validating access token: Session has expired"), {
      status: 401,
      code: 190,
    });
    const f = describeFailure(err, "meta");
    expect(f.cause).toBe("credential_invalid");
    expect(f.hint).toMatch(/Continue with Facebook/);
  });

  it("separates 'cannot see this account' from 'token is dead'", () => {
    /*
     * The two get confused constantly and the fixes are opposite: one is
     * reconnecting, the other is getting the account shared back to the user who
     * already authorised. Meta reports the second as a 100 on a missing object.
     */
    const err = Object.assign(
      new Error(
        "Unsupported get request. Object with ID 'act_9001' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
      ),
      { status: 400, code: 100 },
    );
    expect(describeFailure(err, "meta").cause).toBe("no_access");
  });

  it("🔴 never reports throttling as a broken credential", () => {
    /*
     * The failure `tiktok/client.ts` documents having been bitten by. A rate
     * limit told as "your sign-in expired" sends someone to re-authorise a
     * healthy account — and re-authorising burns the one thing that would have
     * fixed it, which is time.
     */
    for (const code of [4, 17, 32, 613, 80000, 80004]) {
      const err = Object.assign(new Error("(#17) User request limit reached"), { code });
      const f = describeFailure(err, "meta");
      expect(f.cause).toBe("rate_limited");
      expect(f.hint).toMatch(/nothing needs reconnecting/i);
    }
    const tiktok = Object.assign(new Error("rate limited"), { code: 50002 });
    expect(describeFailure(tiktok, "tiktok").cause).toBe("rate_limited");
  });

  it("routes TikTok 40105 to a reconnect", () => {
    // The only warning TikTok gives: its tokens never expire and there is no
    // refresh, so a revocation arrives with no notice and no amber window.
    const err = Object.assign(new Error("Access denied"), { code: 40105 });
    expect(describeFailure(err, "tiktok").cause).toBe("credential_invalid");
  });

  it("🔴 calls our own missing configuration ours", () => {
    /*
     * `google/client.ts` throws these verbatim. Both contain the word "token",
     * so a naive classifier reads them as a dead credential and tells a customer
     * to reconnect an account that was never the problem — forever, because
     * nothing they can do sets an environment variable.
     */
    for (const raw of [
      "GOOGLE_ADS_LOGIN_CUSTOMER_ID (your MCC id) is not set.",
      "GOOGLE_ADS_DEVELOPER_TOKEN is not set.",
    ]) {
      const f = describeFailure(new Error(raw), "google");
      expect(f.cause).toBe("not_configured");
      expect(f.hint).toMatch(/Nothing you can fix from here/);
      assertClean(`${f.message} ${f.hint}`);
    }
  });

  it("recognises a network fault as one", () => {
    for (const raw of ["fetch failed", "socket hang up", "connect ETIMEDOUT 1.2.3.4:443"]) {
      expect(describeFailure(new Error(raw), "google").cause).toBe("upstream_down");
    }
  });

  it("🔴 guesses nothing", () => {
    /*
     * The property that makes the rest safe to trust. An unrecognised error is
     * `unknown` and says so — a classifier that reaches for the nearest cause is
     * worse than none, because a confident wrong diagnosis gets acted on.
     */
    for (const raw of ["", "boom", "Unexpected token < in JSON at position 0", "42"]) {
      expect(describeFailure(new Error(raw), "meta").cause).toBe("unknown");
    }
  });

  it("survives a non-Error throw without crashing the check", () => {
    for (const thrown of [null, undefined, 7, { nope: true }, "plain string"]) {
      expect(() => describeFailure(thrown, "meta")).not.toThrow();
    }
  });

  it("🔴 ignores a string `code`, which is a network errno, not a platform code", () => {
    /*
     * Node sets `err.code = "ECONNRESET"`. Comparing that against Meta's numeric
     * list matches nothing while looking like it tried — so the field is only
     * read when it is a number, and the errno is classified from the text.
     */
    const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(describeFailure(err, "meta").cause).toBe("upstream_down");
  });
});

describe("what a tenant is allowed to read", () => {
  /**
   * Real leaking strings, each traced to the line that builds it.
   *
   * These are the reason the module exists. If any one of them survives into a
   * message or hint, an agency is reading our infrastructure off a health row.
   */
  const LEAKS: Array<[FailureSource, string]> = [
    [
      "meta",
      // meta/client.ts:356 — `body.error.message`, verbatim from Graph.
      "Error validating access token: The user has not authorized application 1234567890123456.",
    ],
    [
      "google",
      // google/client.ts:266 — interpolates the ENTIRE response body.
      'Google Ads 403 listing accessible customers: {"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED","details":[{"loginCustomerId":"7788990011","request_id":"AbC-dEf123"}]}}',
    ],
    [
      "google",
      "GOOGLE_ADS_DEVELOPER_TOKEN is not set.",
    ],
    [
      "ghl",
      // ghl/client.ts:66 — interpolates the body AND the path, and the path
      // carries a location id.
      'GHL 401 on /locations/ve9EPM428h8vShlRW1KT: {"statusCode":401,"message":"Invalid JWT","error":"Unauthorized"}',
    ],
    [
      "tiktok",
      "TikTok returned no data on /open_api/v1.3/advertiser/info/",
    ],
  ];

  it.each(LEAKS)("%s: strips the infrastructure out of a real error", (source, raw) => {
    assertClean(visible(raw, source));
  });

  it("🔴 still says which pipe broke and what to do", () => {
    /*
     * The redaction is only worth having if it keeps the diagnosis. Replacing
     * everything with "something went wrong" would gut the one feature this
     * checklist exists for — it is the answer to a spreadsheet whose six empty
     * blocks went unnoticed for months.
     */
    for (const [source, raw] of LEAKS) {
      const f = describeFailure(raw, source);
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.hint).toBeTruthy();
      // Names the platform, so a row is actionable without reading the label.
      expect(f.message).toMatch(/Meta|Google|TikTok|GoHighLevel/);
    }
  });

  it("classifies a stored error exactly like a live one", () => {
    /*
     * `sync_runs.error` is already a string by the time anything reads it, so a
     * classifier that needed the original Error subclass would work on live
     * throws and silently degrade on stored ones — the wider surface of the two.
     */
    const raw = "Error validating access token: Session has expired";
    expect(describeStoredFailure(raw, "meta")?.cause).toBe(
      describeFailure(new Error(raw), "meta").cause,
    );
    expect(describeStoredFailure(null, "meta")).toBeNull();
    expect(describeStoredFailure("", "meta")).toBeNull();
  });
});

describe("the redaction boundary", () => {
  const CHECKS = [
    { id: "a", diagnostic: "OAuthException: app 1234567890123456" },
    { id: "b" },
  ];

  it("🔴 drops the raw string for anyone who is not a superadmin", () => {
    for (const viewer of [{}, { superadmin: false }]) {
      const out = redactDiagnostics(CHECKS, viewer);
      expect(out.every((c) => !("diagnostic" in c))).toBe(true);
    }
  });

  it("🔴 defaults to redacted when the viewer is not described", () => {
    // A caller that forgets the argument must get the SAFE answer. The failure
    // mode of the next person to add a surface should be a missing diagnostic,
    // not a leaked one.
    expect("diagnostic" in redactDiagnostics(CHECKS, {})[0]).toBe(false);
  });

  it("keeps it for a superadmin", () => {
    expect(redactDiagnostics(CHECKS, { superadmin: true })[0].diagnostic).toBe(
      CHECKS[0].diagnostic,
    );
  });

  it("removes the key rather than blanking it", () => {
    // `JSON.stringify` omits `undefined`, so an empty string would ship a field
    // that reads as "we looked and found nothing" instead of "not for you".
    const [first] = redactDiagnostics(CHECKS, {});
    expect(Object.keys(first)).toEqual(["id"]);
  });
});

/* ------------------------------------------------------------------ *
 * Where it is wired
 * ------------------------------------------------------------------ */

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

const HEALTH = source("src", "lib", "health.ts");
const HEALTH_ROUTE = source("src", "app", "api", "clients", "[id]", "health", "route.ts");
const SETUP_PAGE = source("src", "app", "c", "[slug]", "setup", "page.tsx");
const DATA_STATE = source("src", "components", "DataState.tsx");

describe("wiring", () => {
  it("parses the sources it is checking", () => {
    expect(HEALTH).toContain("export async function runHealthChecks");
    expect(HEALTH_ROUTE).toContain("runHealthChecks(");
  });

  it("🔴 both callers gate the diagnostics on superadmin, not on ownership", () => {
    /*
     * `requireClient` and `isAgencyOperator` both pass for an agency owner
     * looking at their own client — correctly. Neither is the right gate here:
     * the strings describe credentials shared across tenants.
     */
    for (const src of [HEALTH_ROUTE, SETUP_PAGE]) {
      expect(src).toMatch(/superadmin:\s*isSuperadmin\(/);
    }
  });

  it("🔴 no check surfaces a raw error as its own message", () => {
    // The shape that started this: `message: err.message`, straight from Graph
    // or from a GHL response body, as the headline of a red row.
    expect(HEALTH).not.toMatch(/message:\s*err instanceof Error \? err\.message/);
    expect(HEALTH).not.toMatch(/message:\s*`Last sync failed: \$\{pipe\.lastError/);
    expect(HEALTH).not.toMatch(/hint:\s*lastTerminal\.error/);
  });

  it("🔴 the dashboard's empty state classifies before showing", () => {
    // Second surface, easy to miss: `adPipeState` handed `pipe.lastError` to
    // anyone `isAgencyOperator` — which since tenancy means customers.
    expect(DATA_STATE).not.toMatch(/diagnostic:\s*opts\.staff \? \(pipe\.lastError/);
    expect(DATA_STATE).toContain("describeStoredFailure");
  });

  it("🔴 the hardcoded hints no longer narrate our shared credentials", () => {
    /*
     * These were written when the only reader was us:
     *   "Check the system user has access, or the per-account token override."
     *   "Check the MCC link is accepted, the developer token is valid…"
     * Both describe infrastructure an agency has no relationship with and
     * cannot act on. Guarded by string rather than by review, because the
     * tempting fix for a vague health row is to put the detail back.
     */
    const hints = HEALTH.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(hints).not.toMatch(/system user has access/);
    expect(hints).not.toMatch(/MCC link is accepted/);
    expect(hints).not.toMatch(/developer token is valid/);
  });
});
