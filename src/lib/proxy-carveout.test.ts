import { describe, it, expect } from "vitest";
import { clientApiCarveOut } from "./proxy-rules";

/**
 * The client-role carve-out in `src/proxy.ts`, checked as a decision table.
 *
 * §0a's finding was that nine API handlers had no authorization of their own
 * and survived entirely on the proxy's blanket `/api/*` deny for client-role
 * users. W3 is the change that puts the first hole in that blanket, which makes
 * this the moment the hole's exact shape matters.
 *
 * The REAL rule is imported and exercised, not a copy of it. An earlier draft
 * reimplemented the logic here because `proxy.ts` pulls in `next/server`, and a
 * mutation test showed exactly what that costs: loosening the real rule to allow
 * PUT on any subpath left every behavioural case below still passing, because
 * they were all testing the copy. The rule now lives in `proxy-rules.ts` as a
 * pure function so there is nothing to drift.
 */

type Case = {
  path: string;
  method: string;
  slugs: string[];
  allowed: boolean;
  why: string;
};

const MINE = ["acme"];

const CASES: Case[] = [
  {
    path: "/api/c/acme/branding/logo",
    method: "GET",
    slugs: MINE,
    allowed: true,
    why: "their own logo — without this the client sees a broken image on their own dashboard",
  },
  {
    path: "/api/c/acme/branding",
    method: "GET",
    slugs: MINE,
    allowed: true,
    why: "reading their own branding to populate the editor",
  },
  {
    path: "/api/c/acme/branding",
    method: "PUT",
    slugs: MINE,
    allowed: true,
    why: "W3 — editing their own brand",
  },
  {
    path: "/api/c/rival/branding/logo",
    method: "GET",
    slugs: MINE,
    allowed: false,
    why: "🔴 another tenant's asset",
  },
  {
    path: "/api/c/rival/branding",
    method: "PUT",
    slugs: MINE,
    allowed: false,
    why: "🔴 writing another tenant's brand",
  },
  {
    path: "/api/c/acme/branding/logo",
    method: "PUT",
    slugs: MINE,
    allowed: false,
    why: "🔴 a write to a SUBPATH — no such route exists, and a carve-out must not pre-authorise one that might",
  },
  {
    path: "/api/c/acme/branding",
    method: "DELETE",
    slugs: MINE,
    allowed: false,
    why: "🔴 only GET and PUT were reasoned about",
  },
  {
    path: "/api/c/acme/branding",
    method: "POST",
    slugs: MINE,
    allowed: false,
    why: "🔴 same",
  },
  {
    path: "/api/c/acme/leads",
    method: "GET",
    slugs: MINE,
    allowed: false,
    why: "🔴 a sibling route under the same prefix must not ride along",
  },
  {
    path: "/api/clients/abc/branding",
    method: "PUT",
    slugs: MINE,
    allowed: false,
    why: "🔴 the STAFF endpoint, addressed by client id — the whole agency surface",
  },
  {
    path: "/api/clients",
    method: "GET",
    slugs: MINE,
    allowed: false,
    why: "🔴 every tenant's row",
  },
  {
    path: "/api/users",
    method: "GET",
    slugs: MINE,
    allowed: false,
    why: "🔴 the user admin",
  },
  {
    path: "/api/c//branding",
    method: "PUT",
    slugs: MINE,
    allowed: false,
    why: "🔴 an empty slug segment must not match anything",
  },
  {
    path: "/api/c/acme/branding",
    method: "PUT",
    slugs: [],
    allowed: false,
    why: "🔴 a client with no granted slugs",
  },
  /*
   * §6.2 — the written summary is agency-only, and the carve-out is an
   * ALLOW-LIST, so it is denied by virtue of not being named. These cases pin
   * that: a future resource added to `CLIENT_RESOURCES` without thought would
   * otherwise open a client's own path to writing their own report copy.
   */
  {
    path: "/api/c/acme/summary",
    method: "GET",
    slugs: MINE,
    allowed: false,
    why: "🔴 a client reading agency drafts about their own account",
  },
  {
    path: "/api/c/acme/summary",
    method: "POST",
    slugs: MINE,
    allowed: false,
    why: "🔴 a client spending the agency's model budget",
  },
  {
    path: "/api/c/acme/summary/publish",
    method: "POST",
    slugs: MINE,
    allowed: false,
    why: "🔴 a client publishing prose onto their own report",
  },
];

describe("proxy carve-out for client-role users", () => {
  for (const c of CASES) {
    it(`${c.allowed ? "allows" : "denies"} ${c.method} ${c.path} — ${c.why}`, () => {
      expect(clientApiCarveOut(c.path, c.method, c.slugs)).toBe(c.allowed);
    });
  }

  it("allows nothing outside /api/c/<own-slug>/branding", () => {
    // The blunt sweep: anything a client-role user might try.
    const paths = [
      "/api/clients/x/share",
      "/api/clients/x/sync",
      "/api/clients/x/verify",
      "/api/clients/x/meta-accounts",
      "/api/users/1",
      "/api/c/acme",
      "/api/c/acme/",
      "/api/c/acme/branding-x",
      "/api/c/acme/x/branding",
    ];
    for (const p of paths) {
      for (const m of ["GET", "PUT", "POST", "DELETE", "PATCH"]) {
        expect(clientApiCarveOut(p, m, MINE), `${m} ${p}`).toBe(false);
      }
    }
  });

  it("proxy.ts uses this rule rather than its own copy", async () => {
    // Guards the guard from the other direction: the decision table above is
    // only meaningful if the proxy actually calls into it.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/proxy.ts", "utf8"),
    );
    expect(src).toContain("clientApiCarveOut");
    // …and does not carry a second, hand-inlined version alongside it.
    expect(src).not.toMatch(/seg\[4\]\s*===\s*"branding"/);
  });
});
