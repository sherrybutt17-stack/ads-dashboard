import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GoogleAdsClient, normalizeCustomerId } from "./client";

/**
 * `login-customer-id` — the header that decides whether a Google Ads call
 * returns this client's data, someone else's error, or a silent nothing.
 *
 * 🔴 This is the defect the plan flagged as "silent until nothing works". The
 * original code read one global `GOOGLE_ADS_LOGIN_CUSTOMER_ID` for every
 * account. That is correct only while every client account is linked beneath the
 * agency's own Manager account. The moment a client signs in with THEIR Google
 * account, their accounts sit under their manager — or under none at all — and
 * our MCC id produces either a permission error or, worse, a perfectly
 * well-formed request that returns no rows for an account with obvious spend.
 *
 * Three cases, and the third is the one that is easy to get wrong: "no manager"
 * has to be represented distinctly from "not configured", or it collapses back
 * into the agency default.
 */

// The header resolution is private; reach it the way the request path does.
const headerFor = (client: GoogleAdsClient): Record<string, string> =>
  (client as unknown as { loginHeader: () => Record<string, string> }).loginHeader();

const AGENCY_MCC = "999-888-7777";
let original: string | undefined;

beforeEach(() => {
  original = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = AGENCY_MCC;
});
afterEach(() => {
  if (original === undefined) delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  else process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = original;
});

describe("login-customer-id resolution", () => {
  it("falls back to the agency MCC when nothing is stored", () => {
    // Every account that exists today has `login_customer_id = null`, so this
    // is the path that must not change.
    expect(headerFor(new GoogleAdsClient())).toEqual({
      "login-customer-id": "9998887777",
    });
    expect(headerFor(new GoogleAdsClient("refresh-token"))).toEqual({
      "login-customer-id": "9998887777",
    });
    expect(headerFor(new GoogleAdsClient("refresh-token", null))).toEqual({
      "login-customer-id": "9998887777",
    });
  });

  it("uses the account's own manager when one is stored", () => {
    expect(headerFor(new GoogleAdsClient("t", "123-456-7890"))).toEqual({
      "login-customer-id": "1234567890",
    });
  });

  it("🔴 OMITS the header entirely for an account with no manager", () => {
    /*
     * The subtle one. An empty string is a decision — "this account is reached
     * directly, there is no manager above it" — and it must not fall through to
     * the agency default. Two ways to get this wrong, both silent:
     *
     *   · treating "" as unset  → our MCC id goes out, and Google returns
     *     nothing for an account we plainly have access to
     *   · sending an empty-valued header → Google rejects the request outright
     */
    expect(headerFor(new GoogleAdsClient("t", ""))).toEqual({});
    expect(headerFor(new GoogleAdsClient("t", "   "))).toEqual({});
  });

  it("strips the dashes Google's UI shows", () => {
    // Customer ids are displayed as 123-456-7890 and must be sent as digits, in
    // both the URL and this header. An operator will paste what they can see.
    expect(normalizeCustomerId("123-456-7890")).toBe("1234567890");
    expect(headerFor(new GoogleAdsClient("t", "  123-456-7890  "))).toEqual({
      "login-customer-id": "1234567890",
    });
  });

  it("still fails loudly when neither a per-account id nor the env var exists", () => {
    // A missing MCC is a configuration error, and a configuration error that
    // produces an empty header would look like an API problem instead.
    delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    expect(() => headerFor(new GoogleAdsClient())).toThrow(
      /GOOGLE_ADS_LOGIN_CUSTOMER_ID/,
    );
    // …but an account that declares "no manager" is unaffected by the env var.
    expect(headerFor(new GoogleAdsClient("t", ""))).toEqual({});
  });
});
