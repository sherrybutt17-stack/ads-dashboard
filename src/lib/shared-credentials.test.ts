import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mayUseSharedCredential,
  metaTokenFor,
  googleRefreshTokenFor,
} from "./shared-credentials";
import { BOOTSTRAP_AGENCY_ID } from "@/db/schema";

/*
 * 🔴 Leak #1 and #12, and the reason they are one module.
 *
 * `MetaClient` fell back to `META_SYSTEM_USER_TOKEN` and `getAccessToken` fell
 * back to `GOOGLE_ADS_REFRESH_TOKEN` whenever a client had nothing of its own.
 * Opened to sign-up that reads: type any ad account id our system user can
 * reach, and the connect wizard verifies it, attaches it, and starts reporting
 * a stranger's spend. There is no exploit to write — the product does it.
 */

const OTHER = "cccccccc-0000-0000-0000-0000000000cc";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["META_SYSTEM_USER_TOKEN", "GOOGLE_ADS_REFRESH_TOKEN"]) {
    saved[k] = process.env[k];
  }
  process.env.META_SYSTEM_USER_TOKEN = "shared-meta-token";
  process.env.GOOGLE_ADS_REFRESH_TOKEN = "shared-google-refresh";
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("who may use the shared credential", () => {
  it("the bootstrap agency may", () => {
    // Not a loophole — it is the agency this codebase runs as today, and its
    // system-user token is the intended setup. Behaviour is unchanged for it.
    expect(mayUseSharedCredential(BOOTSTRAP_AGENCY_ID)).toBe(true);
  });

  it("🔴 nobody else may", () => {
    expect(mayUseSharedCredential(OTHER)).toBe(false);
    expect(mayUseSharedCredential("")).toBe(false);
  });
});

describe("metaTokenFor", () => {
  it("prefers the agency's own token over ours, always", () => {
    // Including for the bootstrap agency: an account attached with its own
    // token is in a Business Manager the system user may not even reach.
    expect(metaTokenFor(BOOTSTRAP_AGENCY_ID, "own-token")).toBe("own-token");
    expect(metaTokenFor(OTHER, "own-token")).toBe("own-token");
  });

  it("gives the bootstrap agency the shared token when it has none of its own", () => {
    expect(metaTokenFor(BOOTSTRAP_AGENCY_ID)).toBe("shared-meta-token");
    expect(metaTokenFor(BOOTSTRAP_AGENCY_ID, null)).toBe("shared-meta-token");
  });

  it("🔴 refuses another agency the shared token", () => {
    // THE assertion. If this ever returns a token, any agency can read any ad
    // account our system user has access to, through the ordinary connect flow.
    expect(() => metaTokenFor(OTHER)).toThrow(/no Facebook connection of its own/i);
  });

  it("throws with an instruction rather than returning null", () => {
    /*
     * A null would leave the caller to decide, and the tempting decision — carry
     * on and let the API 400 — surfaces as "Meta returned an error" in the
     * health panel instead of "this account is not connected". One is fixable,
     * the other is a mystery.
     */
    expect(() => metaTokenFor(OTHER)).toThrow(/setup page/i);
  });

  it("refuses even the bootstrap agency when no shared token is configured", () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    expect(() => metaTokenFor(BOOTSTRAP_AGENCY_ID)).toThrow();
  });
});

describe("googleRefreshTokenFor", () => {
  it("prefers the agency's own refresh token", () => {
    expect(googleRefreshTokenFor(OTHER, "own-refresh")).toBe("own-refresh");
  });

  it("🔴 refuses another agency the shared MCC refresh token", () => {
    /*
     * Worse than Meta's case in one way: every agency riding one MCC refresh
     * token and one developer token means a single tenant's abuse suspends API
     * access for everybody, with no per-tenant remedy short of rotating a
     * credential the whole platform depends on.
     */
    expect(() => googleRefreshTokenFor(OTHER)).toThrow(
      /no Google Ads connection of its own/i,
    );
  });

  it("still serves the bootstrap agency", () => {
    expect(googleRefreshTokenFor(BOOTSTRAP_AGENCY_ID)).toBe("shared-google-refresh");
  });
});
