import {
  describeFailure,
  failureFacts,
  type FailureCause,
  type FailureSource,
} from "@/lib/health-errors";

/**
 * The same boundary as `health-errors.ts`, applied to request/response.
 *
 * ── Why a second module ───────────────────────────────────────────────
 *
 * `health-errors.ts` fixed the checklist — the screen that READS a stored
 * failure. It did not fix the screens that PROVOKE one. Every route behind the
 * setup wizard ends in the same line:
 *
 *     { error: err instanceof Error ? err.message : "Failed" }
 *
 * and those are the routes that touch the platforms directly: verify a GHL
 * token, attach an ad account, import pipeline stages, run a sync. An operator
 * pasting a wrong ad account id gets Meta's own prose back, and Meta's own prose
 * names our app id. Google's names our MCC. A missing environment variable names
 * the variable. Post-tenancy the operator reading that is a customer.
 *
 * ── 🔴 What must NOT be redacted ──────────────────────────────────────
 *
 * The naive fix — run every caught error through `describeFailure` — is a real
 * regression, and a quiet one. These routes also throw our own carefully worded
 * messages:
 *
 *   · "Ad account id is required"
 *   · "That ad account is already attached to another client"
 *   · "Account not found"
 *
 * Those are the answer. Rewriting them as "Meta rejected the request" would take
 * a wizard that told you exactly what to fix and make it useless, which is the
 * failure mode this whole product exists to replace — a screen that reports
 * something is wrong without reporting what.
 *
 * So the question this module answers is not "how do we phrase this" but "whose
 * words are these", and it answers it structurally:
 *
 * | Origin                              | Treatment                    |
 * |-------------------------------------|------------------------------|
 * | One of the four API error classes   | redacted via `describeFailure` |
 * | Our config, missing (`not_configured`) | redacted — names env vars   |
 * | A plain `Error` we threw on purpose | passed through verbatim      |
 * | Anything else (`TypeError`, a bug)  | generic; it is not an answer |
 *
 * Detection is on `err.name` rather than `instanceof`, for the reason
 * `failureFacts` is structural: it keeps this module free of `@/db` (every
 * client module pulls it in), and it survives an error that crossed a
 * serialization boundary. All four clients set `this.name` in their
 * constructors, and there is a test asserting they still do — see
 * `api-failure.test.ts`, which imports the real classes so a rename cannot
 * silently turn redaction off.
 */

/** The four classes that carry a third party's words. */
const UPSTREAM_ERROR_NAMES = new Set([
  "MetaApiError",
  "GoogleAdsError",
  "GhlApiError",
  "TiktokApiError",
]);

export function isUpstreamError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" && UPSTREAM_ERROR_NAMES.has(name);
}

/**
 * A deliberate throw of ours, as opposed to a bug.
 *
 * `new Error("Account not found")` has `name === "Error"` exactly. A
 * `TypeError`, a `RangeError` or anything a dependency subclasses does not — so
 * "cannot read properties of undefined" cannot reach a customer wearing the
 * costume of an explanation.
 */
function isDeliberateMessage(err: unknown): err is Error {
  return (
    err instanceof Error &&
    err.name === "Error" &&
    typeof err.message === "string" &&
    err.message.trim().length > 0
  );
}

/** The JSON body fields a failing route returns. Spread into the response. */
export interface SafeFailure {
  /** Always present. Safe for any viewer. */
  error: string;
  /** What to do about it, when there is something to do. */
  hint?: string;
  /** Set only when the message was redacted — lets a UI branch on the reason. */
  cause?: FailureCause;
  /** The original text. Superadmins only, exactly as on the checklist. */
  diagnostic?: string;
}

/**
 * Turn a caught error into a response body anyone may read.
 *
 * `source` is the platform the call was made against, which the caller knows
 * and the error frequently does not — a network timeout carries no hint of
 * whose socket it was.
 */
export function safeFailure(
  err: unknown,
  source: FailureSource,
  viewer: { superadmin?: boolean },
  /** Used when the throw carried nothing usable. */
  fallback = "Something went wrong on our side",
): SafeFailure {
  const raw = failureFacts(err).message;
  /*
   * `diagnostic` is attached by the two redacting branches below rather than
   * here, so the pass-through branch cannot ship the same string twice — once
   * as the answer and once as a "staff only" line under it.
   */
  const forStaff = viewer.superadmin ? { diagnostic: raw } : {};

  const described = describeFailure(err, source);
  /*
   * Rebuilt field by field rather than spread: `RedactedFailure` calls it
   * `message` and a response body calls it `error`, and shipping both would put
   * the same sentence on the screen twice the moment a caller rendered the
   * whole object.
   */
  const redacted: SafeFailure = {
    error: described.message,
    hint: described.hint,
    cause: described.cause,
    ...forStaff,
  };

  if (isUpstreamError(err)) return redacted;
  // Ours to fix, and the raw text names the variable that would fix it.
  if (described.cause === "not_configured") return redacted;

  if (isDeliberateMessage(err)) {
    // Our words, written for this exact screen. Untouched.
    return { error: err.message };
  }

  return {
    error: fallback,
    hint: "Not a problem with this connection. Try again, and contact support if it keeps happening.",
    cause: "unknown",
    ...forStaff,
  };
}

/**
 * The message alone, for the per-account failure lists.
 *
 * Attaching several ad accounts reports each outcome separately
 * (`failed: [{ adAccountId, error }]`), so those rows get the safe string
 * without the surrounding envelope. The hint is dropped deliberately — repeating
 * "reconnect the account" once per failed row is noise, and the checklist the
 * operator lands on next says it once.
 */
export function safeFailureMessage(
  err: unknown,
  source: FailureSource,
  fallback = "Could not attach.",
): string {
  return safeFailure(err, source, {}, fallback).error;
}
