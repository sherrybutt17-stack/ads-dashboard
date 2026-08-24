import { PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";

/**
 * Turning an upstream error into something an agency may safely read.
 *
 * ── 🔴 Why this exists ────────────────────────────────────────────────
 *
 * Every connector's error message is written by a third party, for a developer,
 * with no idea who will eventually see it. While this was a single-agency tool
 * that was fine — the only reader was us, and the raw string is the fastest
 * possible diagnosis. Multi-tenancy changes who is reading, and the strings
 * turn out to name our infrastructure rather than the customer's:
 *
 *   · Meta returns `Error validating access token: The user has not authorized
 *     application 1234567890` — our app id, to a customer.
 *   · `google/client.ts` interpolates the ENTIRE response body, and Google Ads
 *     error payloads carry `loginCustomerId` — our MCC — plus the developer
 *     token's approval state and a request id.
 *   · A missing environment variable arrives as
 *     `GOOGLE_ADS_LOGIN_CUSTOMER_ID (your MCC id) is not set.`, which names the
 *     variable and tells the reader what it holds.
 *   · `GhlApiError` interpolates the response body and the path, and the path
 *     contains a location id.
 *   · Anything non-API — a Postgres failure inside a sync — lands in
 *     `sync_runs.error` verbatim and reaches the same screens.
 *
 * None of that is actionable for the person reading it, and some of it is a
 * description of shared credentials they have no relationship with.
 *
 * ── Classify, don't censor ────────────────────────────────────────────
 *
 * The naive fix is to replace the string with "Something went wrong", which
 * guts the one feature this checklist exists to provide: saying WHICH pipe is
 * broken and WHAT to do about it. So instead each error is mapped to one of a
 * small closed set of causes, and each cause has our own wording plus a next
 * action. The reader loses the request id and keeps the diagnosis.
 *
 * ── 🔴 Conservative by construction ───────────────────────────────────
 *
 * An unrecognised error becomes `unknown`, never a guess. `tiktok/client.ts`
 * already documents why, having been bitten by it: a code that was classified
 * as both "token is dead" and "rate limited" sent operators to re-authorise
 * accounts that were merely throttled. A wrong classification is worse than no
 * classification in both directions, so structured codes are always consulted
 * before text, and the text patterns are specific phrases rather than words
 * like "token" that appear in half of all error messages.
 *
 * This module has no imports beyond the label map, so it is testable without a
 * database — the same rule `client-scope.ts`, `roles.ts` and `password-policy.ts`
 * are built to.
 */

/** GoHighLevel is not an ad platform but fails the same six ways. */
export type FailureSource = AdPlatform | "ghl";

const SOURCE_LABEL: Record<FailureSource, string> = {
  ...PLATFORM_LABEL,
  ghl: "GoHighLevel",
};

/**
 * What went wrong, at the resolution the reader can act on.
 *
 * The set is deliberately small. More causes would mean finer classification,
 * and finer classification is exactly where a wrong answer comes from — these
 * six are the ones whose next action genuinely differs.
 */
export type FailureCause =
  /** The credential is dead. Someone has to re-authorise. */
  | "credential_invalid"
  /** The credential is fine; it just cannot see this account any more. */
  | "no_access"
  /** Throttled. Resolves itself. */
  | "rate_limited"
  /** The platform did not answer, or the network did not. */
  | "upstream_down"
  /** Our own configuration is missing. Not the customer's problem to fix. */
  | "not_configured"
  /** Recognised as a failure, not recognised as any of the above. */
  | "unknown";

export interface RedactedFailure {
  cause: FailureCause;
  /** Our words. Safe for any viewer, including the client-role one. */
  message: string;
  /** What to do, when there is something the reader can do. */
  hint?: string;
}

/**
 * The parts of a thrown error worth classifying on.
 *
 * Structural rather than `instanceof`, for two reasons. It keeps this module
 * dependency-free, and — the load-bearing one — `sync_runs.error` is a STRING
 * by the time anything reads it, so a classifier that needed the original class
 * would work on live throws and silently degrade on stored ones. The same
 * function has to handle both or the two paths drift.
 */
export interface FailureFacts {
  message: string;
  /** HTTP status, where the thrower recorded one. */
  status?: number;
  /** The platform's own numeric code — Meta's `code`, TikTok's `code`. */
  code?: number;
}

/** Pull whatever structure an unknown throw happens to carry. */
export function failureFacts(err: unknown): FailureFacts {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; status?: unknown; code?: unknown };
    return {
      message: typeof e.message === "string" ? e.message : String(err),
      status: typeof e.status === "number" ? e.status : undefined,
      // Node network errors carry a STRING code (`ECONNRESET`); only a numeric
      // one is a platform code, and treating `"ENOTFOUND"` as one would compare
      // it against Meta's list and match nothing while looking like it tried.
      code: typeof e.code === "number" ? e.code : undefined,
    };
  }
  return { message: typeof err === "string" ? err : String(err) };
}

/* ------------------------------------------------------------------ *
 * Matchers
 *
 * Ordered by confidence, not by severity: a numeric code the platform
 * documents beats a phrase we matched in prose, every time.
 * ------------------------------------------------------------------ */

/** Meta codes whose meaning is "back off", from `MetaApiError.isRateLimit`. */
const META_RATE_LIMIT = new Set([4, 17, 32, 613, 80000, 80004]);
/** Meta OAuthException (190) and invalid session (102). */
const META_CREDENTIAL = new Set([190, 102]);
/** Meta permission errors — the credential works, the object is not visible. */
const META_NO_ACCESS = new Set([10, 200, 3]);

/** TikTok, from `TiktokApiError`. 40105 = authoriser lost advertiser access. */
const TIKTOK_CREDENTIAL = new Set([40105]);
const TIKTOK_RATE_LIMIT = new Set([50002]);

/**
 * Our own missing configuration, checked FIRST.
 *
 * `GOOGLE_ADS_DEVELOPER_TOKEN is not set.` contains the word "token" and would
 * otherwise be read as a dead credential — sending a customer to reconnect an
 * account whose connection was never the problem, over and over, while the
 * actual fault sat in an environment variable only we can set.
 */
function isNotConfigured(text: string): boolean {
  return / is not set\.?$/i.test(text) || /\bnot configured\b/i.test(text);
}

function isCredentialText(text: string): boolean {
  return (
    /error validating access token/i.test(text) ||
    // `TiktokClient` throws this when the account row holds no token at all,
    // which is a connection to redo rather than a setting we are missing.
    /^no (tiktok|meta|google) access token\.?$/i.test(text) ||
    /session has expired/i.test(text) ||
    /has not authorized application/i.test(text) ||
    /\bOAuthException\b/.test(text) ||
    /\binvalid_grant\b/i.test(text) ||
    /\binvalid_client\b/i.test(text) ||
    /\bunauthorized_client\b/i.test(text) ||
    /\bAUTHENTICATION_ERROR\b/.test(text) ||
    /\bOAUTH_TOKEN_[A-Z_]+\b/.test(text) ||
    /appsecret_proof/i.test(text) ||
    /\bno stored token\b/i.test(text)
  );
}

function isNoAccessText(text: string): boolean {
  return (
    /does not exist, cannot be loaded due to missing permissions/i.test(text) ||
    /\bUSER_PERMISSION_DENIED\b/.test(text) ||
    /\bCUSTOMER_NOT_ENABLED\b/.test(text) ||
    /\bNOT_ADS_USER\b/.test(text) ||
    /\bPERMISSION_DENIED\b/.test(text) ||
    /not visible to this authorization/i.test(text)
  );
}

function isRateLimitText(text: string): boolean {
  return (
    /\bRESOURCE_EXHAUSTED\b/.test(text) ||
    /\bQUOTA_ERROR\b/.test(text) ||
    /\brate limit/i.test(text) ||
    /request limit reached/i.test(text)
  );
}

function isUpstreamDownText(text: string): boolean {
  return (
    /\bfetch failed\b/i.test(text) ||
    /\bsocket hang up\b/i.test(text) ||
    /\bE(CONNRESET|CONNREFUSED|TIMEDOUT|NOTFOUND|AI_AGAIN)\b/.test(text) ||
    /\bnetwork\b/i.test(text) ||
    /\btimed? ?out\b/i.test(text)
  );
}

/** The classification itself, with no wording attached. */
function causeOf(facts: FailureFacts, source: FailureSource): FailureCause {
  const text = facts.message ?? "";

  // Ours before theirs — see `isNotConfigured`.
  if (isNotConfigured(text)) return "not_configured";

  // Documented numeric codes, per platform. Highest confidence available.
  if (facts.code !== undefined) {
    if (source === "meta") {
      if (META_RATE_LIMIT.has(facts.code)) return "rate_limited";
      if (META_CREDENTIAL.has(facts.code)) return "credential_invalid";
      if (META_NO_ACCESS.has(facts.code)) return "no_access";
    }
    if (source === "tiktok") {
      if (TIKTOK_RATE_LIMIT.has(facts.code)) return "rate_limited";
      if (TIKTOK_CREDENTIAL.has(facts.code)) return "credential_invalid";
    }
  }

  // HTTP status, which every source sets the same way.
  if (facts.status !== undefined) {
    if (facts.status === 429) return "rate_limited";
    if (facts.status === 401) return "credential_invalid";
    if (facts.status === 403 || facts.status === 404) return "no_access";
    if (facts.status >= 500) return "upstream_down";
  }

  // Prose, last and least trusted.
  if (isRateLimitText(text)) return "rate_limited";
  if (isCredentialText(text)) return "credential_invalid";
  if (isNoAccessText(text)) return "no_access";
  if (isUpstreamDownText(text)) return "upstream_down";

  return "unknown";
}

/**
 * Reconnect instructions, which are the one genuinely per-source thing here.
 *
 * Naming the actual button matters more than it looks: "re-authorise the
 * integration" sends someone hunting through settings, and the difference
 * between a customer fixing their own dead token in ten seconds and opening a
 * ticket is whether the sentence told them where to click.
 */
const RECONNECT: Record<FailureSource, string> = {
  meta: "Reconnect with Continue with Facebook on this page.",
  google: "Reconnect with Continue with Google on this page.",
  tiktok: "Reconnect with Continue with TikTok on this page.",
  ghl: "Re-install the marketplace app on this sub-account, or replace the Private Integration Token.",
};

/**
 * The whole point of the module: an error anyone may read.
 *
 * Note what is NOT here — no ids, no request ids, no environment variable
 * names, no response bodies, and nothing that describes a credential shared
 * between tenants. A reader learns which pipe is broken and what to do, and
 * learns nothing about the machinery behind it.
 */
export function describeFailure(
  err: unknown,
  source: FailureSource,
): RedactedFailure {
  const facts = failureFacts(err);
  const cause = causeOf(facts, source);
  const name = SOURCE_LABEL[source];

  switch (cause) {
    case "credential_invalid":
      return {
        cause,
        message: `${name} sign-in is no longer valid`,
        hint: RECONNECT[source],
      };

    case "no_access":
      return {
        cause,
        message: `Connected, but ${name} no longer shows this account to that sign-in`,
        hint: `The account may have been removed from the ${name} user who authorised it, or moved to a different business. ${RECONNECT[source]}`,
      };

    case "rate_limited":
      return {
        cause,
        message: `${name} is rate-limiting us`,
        /*
         * Explicitly "nothing to do". Throttling looks identical to a broken
         * connection on a checklist, and the wrong instinct — reconnect the
         * account — burns the one thing that would have fixed it, which is
         * time.
         */
        hint: "Nothing is broken and nothing needs reconnecting. This clears on its own and the next sync will pick it up.",
      };

    case "upstream_down":
      return {
        cause,
        message: `${name} did not respond`,
        hint: "A platform outage or a network fault, not a problem with this connection. Re-test in a few minutes.",
      };

    case "not_configured":
      return {
        cause,
        /*
         * Named as ours out loud. The alternative — a generic failure — sends a
         * customer to re-check credentials that were never the fault, and they
         * cannot succeed however many times they try.
         */
        message: `${name} is not fully set up on our side`,
        hint: "Nothing you can fix from here. Contact support and we'll sort it.",
      };

    case "unknown":
      return {
        cause,
        message: `${name} rejected the request`,
        hint: "Re-test in a few minutes. If it keeps failing, contact support and we'll look at the detail.",
      };
  }
}

/**
 * The same treatment for an error that has already been stored as text.
 *
 * `sync_runs.error` and `report_schedules.last_error` hold the stringified form
 * of exactly the throws above, so classification runs on the message alone —
 * which is why `causeOf` was built to work without the structured fields rather
 * than merely tolerating their absence.
 */
export function describeStoredFailure(
  raw: string | null | undefined,
  source: FailureSource,
): RedactedFailure | null {
  if (!raw) return null;
  return describeFailure(raw, source);
}

/* ------------------------------------------------------------------ *
 * The boundary
 * ------------------------------------------------------------------ */

/** Anything carrying an unredacted string alongside its safe fields. */
export interface MaybeDiagnostic {
  diagnostic?: string;
}

/**
 * 🔴 The single place a raw error is allowed past.
 *
 * Lives here rather than in `health.ts` for one reason: `health.ts` imports
 * `@/db`, so a test of it needs a database, and the last thing a security
 * boundary should be is the part that is awkward to test. This module has no
 * dependencies, so the rule can be asserted directly.
 *
 * `superadmin` is the gate, not "runs this account". Since tenancy an agency
 * owner passes every ownership check for their own clients and is nonetheless a
 * customer — the strings being withheld describe OUR app registration, OUR
 * manager account, and credentials shared across tenants.
 */
export function redactDiagnostics<T extends MaybeDiagnostic>(
  items: T[],
  viewer: { superadmin?: boolean },
): T[] {
  if (viewer.superadmin) return items;
  return items.map((item) => {
    if (item.diagnostic === undefined) return item;
    /*
     * The key is DELETED, not blanked. `JSON.stringify` omits `undefined`, so
     * setting the field to an empty string would ship `"diagnostic": ""` — which
     * reads as "we looked and there was nothing" rather than "not for you", and
     * would render an empty line under the hint.
     */
    const safe = { ...item };
    delete safe.diagnostic;
    return safe;
  });
}
