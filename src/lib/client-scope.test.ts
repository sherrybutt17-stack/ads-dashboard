import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { sessionMaySeeClient } from "./client-scope";
import type { SessionPayload } from "./session";

/*
 * Tenant isolation, in the two halves it can fail in.
 *
 * The rule itself is below, tested exhaustively because it is pure and there is
 * no excuse not to. The second half is harder and matters more: a perfect rule
 * is worth nothing if a handler simply does not call it, and the codebase spent
 * its whole life with `getClientById(id)` available and no reason not to reach
 * for it. So the unscoped accessors are named, and the list of files allowed to
 * use them is asserted here — a short list somebody can actually read.
 */

const SRC = resolve(__dirname, "..");
const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";

const session = (over: Partial<SessionPayload>): SessionPayload => ({
  userId: "u1",
  agencyId: A,
  role: "agency",
  slugs: [],
  ...over,
});

const ours = { agencyId: A, slug: "acme" };
const theirs = { agencyId: B, slug: "rival" };

describe("sessionMaySeeClient", () => {
  it("denies anonymous", () => {
    expect(sessionMaySeeClient(null, ours)).toBe(false);
    expect(sessionMaySeeClient(undefined, ours)).toBe(false);
  });

  it("🔴 denies an agency login another agency's client", () => {
    // The entire point of the tenancy work. If this ever returns true, every
    // agency's spend, leads and pipeline is readable by every other agency.
    expect(sessionMaySeeClient(session({ role: "agency" }), theirs)).toBe(false);
  });

  it("allows an agency login every client its own agency owns", () => {
    expect(sessionMaySeeClient(session({ role: "agency" }), ours)).toBe(true);
    // Including ones it holds no explicit slug grant for — an agency owner does
    // not get a per-client grant list, they own the book.
    expect(
      sessionMaySeeClient(session({ role: "agency", slugs: [] }), {
        agencyId: A,
        slug: "another",
      }),
    ).toBe(true);
  });

  it("🔴 holds a client login to its granted slugs INSIDE its own agency", () => {
    /*
     * Not redundant with the tenant check, and this is the case that is easy to
     * get wrong. An agency's own client-role logins pass the tenant gate by
     * construction — they belong to that agency. Without the grant check,
     * giving one client a login to their dashboard would hand them every other
     * client of the same agency.
     */
    const c = session({ role: "client", slugs: ["acme"] });
    expect(sessionMaySeeClient(c, ours)).toBe(true);
    expect(sessionMaySeeClient(c, { agencyId: A, slug: "sibling" })).toBe(false);
  });

  it("does not let a slug grant cross an agency boundary", () => {
    // Slugs are globally unique today, so a grant naming "rival" must still
    // fail on the tenant gate rather than being honoured on name alone.
    const c = session({ role: "client", slugs: ["rival"] });
    expect(sessionMaySeeClient(c, theirs)).toBe(false);
  });

  it("lets staff and superadmin cross agencies, and nobody else", () => {
    for (const role of ["staff", "superadmin"] as const) {
      expect(sessionMaySeeClient(session({ role }), theirs)).toBe(true);
    }
    for (const role of ["agency", "client"] as const) {
      expect(sessionMaySeeClient(session({ role }), theirs)).toBe(false);
    }
  });

  it("🔴 denies rather than defaults on a role it does not know", () => {
    // A fifth role added to the enum without a rule here must not inherit
    // agency-wide sight by falling off the end of the function.
    const odd = session({ role: "auditor" as never });
    expect(sessionMaySeeClient(odd, ours)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The escape hatch, and who is allowed through it
 * ------------------------------------------------------------------ */

/**
 * Files permitted to read a client without a session, and why.
 *
 * 🔴 Adding a line here is the decision. Every entry is a path whose
 * authorization genuinely comes from somewhere other than a login; anything
 * else belongs on `getClientForSession` / `requireClient`. The list is short on
 * purpose — if it grows past a handful, the pattern has stopped being an
 * exception.
 */
const UNSCOPED_ALLOWLIST: Record<string, string> = {
  "lib/clients.ts": "Defines them.",
  "app/api/oauth/callback/route.ts":
    "GoHighLevel marketplace callback — authorized by the signed OAuth state.",
  "app/api/oauth/meta/callback/route.ts":
    "Meta callback — authorized by the signed OAuth state.",
  "app/api/oauth/google/callback/route.ts":
    "Google callback — authorized by the signed OAuth state.",
  "app/api/oauth/tiktok/callback/route.ts":
    "TikTok callback — authorized by the signed OAuth state.",
  "app/r/[token]/page.tsx":
    "Share link. The unguessable token IS the grant; the recipient has no login.",
  "app/render/[token]/page.tsx":
    "Headless PDF renderer, reached only via a verified render token.",
};

const UNSCOPED = [
  "getClientUnscoped",
  "getClientBySlugUnscoped",
  "listClientsUnscoped",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__testdb__") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("unscoped client reads", () => {
  const users = walk(SRC)
    .filter((f) => UNSCOPED.some((fn) => readFileSync(f, "utf8").includes(fn)))
    .map((f) => relative(SRC, f).split(sep).join("/"));

  it("finds the files it is checking", () => {
    // Without this the assertion below passes vacuously if the walk breaks.
    expect(users.length).toBeGreaterThan(3);
  });

  it("🔴 every unscoped client read is on the allowlist", () => {
    const rogue = users.filter((f) => !(f in UNSCOPED_ALLOWLIST));
    expect(
      rogue,
      `These read a client with the tenant check deliberately skipped, and are ` +
        `not on the list of paths allowed to. Use \`requireClient(id)\` in a route ` +
        `or \`getClientForSession(session, slug)\` in a page — or, if the ` +
        `authorization genuinely comes from a token or a signed OAuth state, add ` +
        `the file to UNSCOPED_ALLOWLIST with the reason:\n  ${rogue.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has no stale entries for files that no longer bypass scoping", () => {
    // A leftover exemption is an invitation: the next person to touch that file
    // finds it pre-approved for something it stopped doing.
    const stale = Object.keys(UNSCOPED_ALLOWLIST).filter((f) => !users.includes(f));
    expect(stale, `Allowlisted but no longer unscoped: ${stale.join(", ")}`).toEqual(
      [],
    );
  });

  it("🔴 the unscoped accessors are the only unscoped path", () => {
    /*
     * The functions this test polices only help while they are the only way to
     * read a client without a tenant. A reinstated `getClientById` would sail
     * past every assertion above.
     */
    const clientsSrc = readFileSync(join(SRC, "lib", "clients.ts"), "utf8");
    for (const gone of ["export async function getClientById(", "export async function listClients("]) {
      expect(clientsSrc.includes(gone), `${gone} is back`).toBe(false);
    }
  });
});
