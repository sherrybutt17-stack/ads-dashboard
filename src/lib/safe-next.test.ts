import { describe, it, expect } from "vitest";
import { safeNextPath } from "./safe-next";

/*
 * The post-sign-in redirect. A miss here is an open redirect that fires right
 * after the victim has typed their real password into the real page — the most
 * convincing phishing hop there is — so the refusals are the interesting half.
 */

const ORIGIN = "https://dash.example.com";

describe("safeNextPath — keeps our own paths", () => {
  it.each([
    ["/", "/"],
    ["/users", "/users"],
    ["/c/acme?range=30d#funnel", "/c/acme?range=30d#funnel"],
  ])("%s", (next, want) => {
    expect(safeNextPath(next, ORIGIN)).toBe(want);
  });
});

describe("🔴 safeNextPath — refuses anything that leaves", () => {
  it.each([
    ["/\t/evil.example/login", "tab — stripped by the URL parser, then //evil"],
    ["/\n/evil.example", "newline, same trick"],
    ["/\r/evil.example", "carriage return, same trick"],
    ["//evil.example", "protocol-relative"],
    ["/\\evil.example", "backslash — browsers read it as a slash"],
    ["\\\\evil.example", "double backslash"],
    ["https://evil.example", "absolute URL"],
    ["javascript:alert(1)", "script URL"],
    ["evil.example", "no leading slash"],
    ["", "empty"],
  ])("%j — %s", (next) => {
    expect(safeNextPath(next, ORIGIN)).toBeNull();
  });

  it("refuses null and undefined", () => {
    expect(safeNextPath(null, ORIGIN)).toBeNull();
    expect(safeNextPath(undefined, ORIGIN)).toBeNull();
  });

  it("proves the old check would have let the tab through", () => {
    // The regression, kept visible: the regex the login page used to rely on.
    const old = /^\/(?![/\\])/;
    const lure = new URLSearchParams("next=/%09/evil.example/login").get("next")!;
    expect(old.test(lure)).toBe(true);
    expect(new URL(lure, ORIGIN).origin).toBe("https://evil.example");
    expect(safeNextPath(lure, ORIGIN)).toBeNull();
  });
});
