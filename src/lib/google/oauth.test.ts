import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isGoogleConfigured, isAgencyGoogleConfigured } from "./oauth";

/**
 * Which env vars mean "Google is switched on".
 *
 * There are two ways a Google Ads account reaches this app and they need
 * different credentials:
 *
 *   - **Model A** — the client links their account to our MCC and one shared
 *     agency refresh token reads all of them.
 *   - **Model B** — the client signs in with their own Google and their token
 *     is stored, encrypted, against their own account.
 *
 * 🔴 One predicate answered for both, and it demanded Model A's two variables.
 * It gates the wizard's Google step, the add-account route and the nightly
 * cron, so a Model B install rendered "not configured" and never showed the
 * Connect button. Nothing errored — the feature simply was not there.
 */

const KEYS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
] as const;

function env(values: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const k of KEYS) vi.stubEnv(k, values[k]);
}

const APP = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_CLIENT_ID: "client-id",
  GOOGLE_ADS_CLIENT_SECRET: "client-secret",
} as const;

beforeEach(() => env({}));
afterEach(() => vi.unstubAllEnvs());

describe("isGoogleConfigured", () => {
  it("🔴 is true for a Model B install — no agency MCC anywhere", () => {
    /*
     * The regression. Client sign-in needs the developer token and the OAuth
     * client and nothing else: each account carries its own refresh token, and
     * `googleRefreshTokenFor` prefers it over the shared one.
     */
    env(APP);
    expect(isGoogleConfigured()).toBe(true);
  });

  it("is true for a Model A install as well", () => {
    env({
      ...APP,
      GOOGLE_ADS_REFRESH_TOKEN: "refresh",
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1234567890",
    });
    expect(isGoogleConfigured()).toBe(true);
  });

  it.each(Object.keys(APP) as Array<keyof typeof APP>)(
    "is false without %s",
    (missing) => {
      // These three are what any call needs, either model. Missing one is a
      // genuine "cannot talk to Google", which is what the gate should mean.
      const partial = { ...APP } as Record<string, string | undefined>;
      delete partial[missing];
      env(partial);
      expect(isGoogleConfigured()).toBe(false);
    },
  );

  it("treats an empty string as unset", () => {
    // `GOOGLE_ADS_DEVELOPER_TOKEN=""` is how `.env.example` ships it, so the
    // unconfigured state is empty strings rather than absent keys.
    env({ ...APP, GOOGLE_ADS_DEVELOPER_TOKEN: "" });
    expect(isGoogleConfigured()).toBe(false);
  });
});

describe("isAgencyGoogleConfigured", () => {
  it("🔴 is false for a Model B install", () => {
    /*
     * The distinction the split exists for. Model B can connect accounts and
     * sync them, and cannot attach one by pasting a Customer ID — that path
     * reads through the shared agency token, which this install does not have.
     */
    env(APP);
    expect(isAgencyGoogleConfigured()).toBe(false);
  });

  it("is true only with the shared agency credential AND its MCC id", () => {
    env({ ...APP, GOOGLE_ADS_REFRESH_TOKEN: "refresh" });
    expect(isAgencyGoogleConfigured()).toBe(false);

    env({ ...APP, GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1234567890" });
    expect(isAgencyGoogleConfigured()).toBe(false);

    env({
      ...APP,
      GOOGLE_ADS_REFRESH_TOKEN: "refresh",
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1234567890",
    });
    expect(isAgencyGoogleConfigured()).toBe(true);
  });

  it("still needs the app credentials underneath", () => {
    // An agency token without a developer token cannot make a call, so this
    // must not report a working Model A.
    env({
      GOOGLE_ADS_CLIENT_ID: "client-id",
      GOOGLE_ADS_CLIENT_SECRET: "client-secret",
      GOOGLE_ADS_REFRESH_TOKEN: "refresh",
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1234567890",
    });
    expect(isAgencyGoogleConfigured()).toBe(false);
  });

  it("🔴 is strictly narrower than isGoogleConfigured", () => {
    /*
     * The property that stops the two drifting back together. If a future edit
     * makes the agency check pass where the app check fails, something is
     * reporting a usable Model A over credentials that cannot make a request.
     */
    const combos: Array<Partial<Record<(typeof KEYS)[number], string>>> = [
      {},
      APP,
      { ...APP, GOOGLE_ADS_REFRESH_TOKEN: "r" },
      { ...APP, GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1" },
      { ...APP, GOOGLE_ADS_REFRESH_TOKEN: "r", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1" },
      { GOOGLE_ADS_REFRESH_TOKEN: "r", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1" },
    ];
    for (const c of combos) {
      env(c);
      if (isAgencyGoogleConfigured()) expect(isGoogleConfigured()).toBe(true);
    }
  });
});
