import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 🔴 Leak #11: the shared password used to mint an identity that did not exist.
 *
 * `userId: "shared"` has no row in `users`, and `getSessionUser` returns it
 * without a database read — that is the whole point of the special case. The
 * consequences all follow from it: nothing can demote it, deactivate it or
 * revoke its grants; it is `staff`, meaning every client in the database; it
 * lasts thirty days; and every action it takes is attributed to nobody.
 *
 * ── Why this test reads source rather than calling the handler ───────────
 *
 * The handler is a Next.js route that reaches for cookies, a database and an
 * audit sink. Standing all three up would test the mocks. What actually needs
 * pinning is the SHAPE of the decision — that the phantom is reachable only
 * behind an emptiness check, that a bound user is preferred to it, and that its
 * lifetime is not the ordinary one — and those are structural facts a source
 * read can hold honestly. `session.test.ts` covers the token itself.
 */

const SRC = readFileSync(
  join(process.cwd(), "src", "app", "api", "auth", "route.ts"),
  "utf8",
);

/** Comments explain the old behaviour at length; assertions must not match prose. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("shared-password bootstrap", () => {
  it("parses to something worth asserting against", () => {
    // Guards the comment-stripping: if it ate the file, every check below
    // passes or fails for the wrong reason.
    expect(CODE).toContain("export async function POST");
    expect(CODE.length).toBeGreaterThan(1000);
  });

  it("🔴 mints the identity-less session only when there are no users", () => {
    /*
     * The phantom is defensible in exactly one situation: an empty `users`
     * table, where there is nothing to bind to and no way to create the first
     * account without getting in. Every occurrence must sit behind that check
     * or behind the dev-only branch.
     */
    const phantom = [...CODE.matchAll(/userId: "shared"/g)];
    expect(phantom.length).toBe(2); // the dev branch, and the first-run branch

    // The production one is guarded by an emptiness check.
    expect(CODE).toMatch(/\(await countUsers\(\)\) === 0/);
    const firstRun = CODE.indexOf("(await countUsers()) === 0");
    const nextPhantom = CODE.indexOf('userId: "shared"', firstRun);
    expect(nextPhantom).toBeGreaterThan(firstRun);
    expect(nextPhantom - firstRun).toBeLessThan(200);
  });

  it("🔴 prefers a real, named account over the phantom", () => {
    // `bootstrapUser()` has to be consulted BEFORE the emptiness fallback, or
    // an operator who bound the password to a user would still get an
    // anonymous session on a database that happens to have no users.
    const bound = CODE.indexOf("await bootstrapUser()");
    const firstRun = CODE.indexOf("(await countUsers()) === 0");
    expect(bound).toBeGreaterThan(-1);
    expect(firstRun).toBeGreaterThan(bound);
  });

  it("🔴 refuses a disabled account through the side door", () => {
    // Binding the shared password to a user must not outlive disabling that
    // user — otherwise "revoke their access" silently leaves a way in.
    expect(CODE).toMatch(/status === "active"/);
  });

  it("gives the first-run session a short life of its own", () => {
    /*
     * Nothing can revoke a session with no row behind it, so its expiry is the
     * only control there is over how long it exists. Thirty days is the wrong
     * number for a door that exists to be walked through once.
     */
    expect(CODE).toContain("BOOTSTRAP_SESSION_TTL_MS");
    const ttl = /const BOOTSTRAP_SESSION_TTL_MS = ([^;]+);/.exec(CODE)?.[1] ?? "";
    // Multiplied out rather than evaluated: the declaration is written as a
    // product of plain integers, and `eval` in a test is a habit worth not
    // having even where the input is our own source.
    const ms = ttl
      .split("*")
      .map((n) => Number(n.trim().replace(/_/g, "")))
      .reduce((a, b) => a * b, 1);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(CODE).toMatch(/sessionTtlMs = BOOTSTRAP_SESSION_TTL_MS/);
  });

  it("🔴 does not mint a 30-day token for it by ignoring the override", () => {
    // The TTL only matters if it reaches the token AND the cookie. Setting a
    // variable nobody passes on is the failure this catches.
    expect(CODE).toMatch(/createSessionToken\(payload, Date\.now\(\), sessionTtlMs\)/);
    expect(CODE).toMatch(/maxAge: Math\.floor\(sessionTtlMs \/ 1000\)/);
  });

  it("tells a refused operator what to do instead", () => {
    // A dead end here is a support ticket the operator cannot raise, because
    // the thing they cannot reach is the tool they would raise it from.
    expect(SRC).toMatch(/Sign in with your email/);
    expect(SRC).toMatch(/Forgot your password/);
  });

  it("records the refusal", () => {
    // A shared password being tried after it was retired is worth seeing —
    // it is either an operator who needs telling, or somebody who should not
    // have it.
    expect(CODE).toMatch(/auth\.shared_refused/);
  });
});
