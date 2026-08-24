/**
 * Password rules shared between the browser and the server.
 *
 * 🔴 Its own module, with NO imports, for the same reason `@/lib/platforms` and
 * `@/lib/stages` are: the reset form is a client component, and importing this
 * from `password-reset.ts` dragged `lib/users` and therefore `@/db` — the whole
 * Drizzle schema — into the browser bundle. `client-bundle.test.ts` caught it.
 *
 * The rule lives in one place because a form that accepts eleven characters
 * while the endpoint demands twelve is a submit button that fails for a reason
 * the user was never told.
 */

/**
 * Twelve, not eight.
 *
 * These accounts hold a client's whole advertising and pipeline history behind
 * one credential, with no second factor. Length is the only lever that reliably
 * costs an attacker anything, and it is the one that costs a legitimate user
 * least — which is why the form suggests a passphrase rather than demanding
 * punctuation nobody remembers.
 */
export const MIN_PASSWORD_LENGTH = 12;
