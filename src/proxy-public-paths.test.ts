import { describe, it, expect } from "vitest";
import { isPublicPath } from "./proxy";

/**
 * Which paths skip authentication entirely.
 *
 * This is the outermost gate in the application: everything it returns true for
 * is served to anyone on the internet, with no session, before any handler
 * runs. So the interesting assertions are not the paths that must be public —
 * those fail loudly the moment someone tries them — but the paths that must
 * NOT be, which fail silently and stay failing.
 *
 * 🔴 This was a bare `startsWith` over the same list, which made every entry a
 * wildcard over its own name. Nothing was reachable through it at the time, and
 * that is the point: the exposure would have been created by whoever later
 * added a route whose name happened to begin with one of these.
 */

describe("paths that must be public", () => {
  it.each([
    ["/api/webhooks/crm/abc123", "GHL cannot present a session"],
    ["/api/cron/meta-sync", "guarded by CRON_SECRET instead"],
    ["/api/auth", "sign-in itself"],
    ["/api/auth/forgot", "someone who cannot sign in"],
    ["/api/logout", "must work with an expired session"],
    ["/login", "the sign-in page"],
    ["/forgot", "the reset request form"],
    ["/reset", "the reset form, token verified on submit"],
    ["/signup", "creates the account"],
    ["/verify", "the account cannot be signed into yet"],
    ["/r/sometoken", "share link — the token IS the credential"],
    ["/render/abc", "the headless renderer arrives with no session"],
    ["/about", "Google's reviewer must reach it"],
    ["/legal/privacy", "same"],
    ["/legal/terms", "same"],
    ["/icon.svg", "or every logged-out page loses its icon"],
    ["/favicon.ico", "same"],
    ["/_next/static/chunk.js", "the bundle itself"],
  ])("%s — %s", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });
});

describe("paths that must NOT be public", () => {
  it.each([
    ["/", "the client list"],
    ["/c/acme", "a client dashboard"],
    ["/users", "user administration"],
    ["/audit", "the audit log"],
    ["/api/clients", "every client on the platform"],
    ["/api/clients/some-uuid/health", "a client's connection detail"],
    ["/api/users", "user administration"],
    ["/api/oauth/callback", "an OAuth exchange bound to a session"],
    ["/api/c/acme/export", "a full data export"],
  ])("%s — %s", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("🔴 an entry never exempts a path that merely starts with its name", () => {
  /*
   * The regression. Each of these shares a prefix with a genuinely public entry
   * and is a plausible future route — `/api/authorize` next to `/api/auth`,
   * `/verify-domain` next to `/verify`. Under a bare `startsWith` every one of
   * them would have been born public, with nothing at the call site to suggest
   * it.
   */
  it.each([
    ["/api/authorize", "/api/auth"],
    ["/api/auth-admin", "/api/auth"],
    ["/api/logout-all-sessions", "/api/logout"],
    ["/login-as", "/login"],
    ["/about-clients", "/about"],
    ["/legalese", "/legal/"],
    ["/verify-domain", "/verify"],
    ["/signups", "/signup"],
    ["/resets", "/reset"],
    ["/forgotten-clients", "/forgot"],
    ["/reports/r/leak", "/r/"],
    ["/icon.svg.map", "/icon.svg"],
  ])("%s is private despite looking like %s", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("a subtree entry still covers its subtree", () => {
  it.each([
    "/api/webhooks/crm/tok/extra",
    "/legal/privacy/updated",
    "/r/token/page",
    "/about/team",
    "/api/auth/reset",
  ])("%s", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });
});
