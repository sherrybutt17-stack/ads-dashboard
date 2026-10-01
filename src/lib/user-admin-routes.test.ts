import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The invite flow's structural promises, pinned against source.
 *
 * Same reasoning as `shared-password.test.ts`: these handlers reach for
 * cookies, a database, an email provider and an audit sink, and standing all of
 * that up would test the mocks. What needs holding is the SHAPE — that no route
 * takes a password from an operator any more, that the rank check sits inside
 * the one helper every per-user route calls, that accepting an invite issues no
 * session, that nobody can disable or remove themselves, and that the link —
 * a credential until used — never reaches the audit log. The behaviour beneath
 * is covered by `invites.test.ts`, `users.test.ts` and `role-tiers.test.ts`.
 */

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
/** Comments explain the old behaviour at length; assertions must not match prose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CREATE = code(read("src", "app", "api", "users", "route.ts"));
const ONE = code(read("src", "app", "api", "users", "[id]", "route.ts"));
const RESEND = code(read("src", "app", "api", "users", "[id]", "invite", "route.ts"));
const ACCEPT = code(read("src", "app", "api", "auth", "invite", "route.ts"));
const RESET = code(read("src", "app", "api", "auth", "reset", "route.ts"));
const ACCESS = code(read("src", "lib", "user-access.ts"));
const MANAGER = code(read("src", "components", "UsersManager.tsx"));

describe("🔴 no operator ever sets or sees a password", () => {
  it("creating a login takes no password, and refuses one sent anyway", () => {
    const schema = CREATE.slice(CREATE.indexOf("const CreateSchema"), CREATE.indexOf("export async function POST"));
    expect(schema).not.toMatch(/password/);
    expect(schema).toMatch(/\.strict\(\)/);
  });

  it("changing a login takes no password, and refuses one sent anyway", () => {
    const schema = ONE.slice(ONE.indexOf("const PatchSchema"), ONE.indexOf("export async function PATCH"));
    expect(schema).not.toMatch(/password/);
    expect(schema).toMatch(/\.strict\(\)/);
  });

  it("the Users page has no password field and prints no credentials", () => {
    expect(MANAGER).not.toMatch(/type="password"/);
    expect(MANAGER).not.toMatch(/Share these credentials/);
    expect(MANAGER).not.toMatch(/label="Password"/);
  });
});

describe("the Users page", () => {
  it("🔴 makes one link at a time — a second click would kill the first link", () => {
    const send = MANAGER.slice(MANAGER.indexOf("async function sendLink"), MANAGER.indexOf("async function toggleStatus"));
    expect(send).toMatch(/if \(linking\) return;/);
    expect(send).toMatch(/finally \{\s*setLinking\(null\)/);
    expect(MANAGER).toMatch(/disabled=\{linking !== null\}/);
  });

  it("🔴 on the shared password, starts the role picker on the widest role", () => {
    // The first invite there is the operator's own; a Client one is the lockout.
    expect(MANAGER).toMatch(/const firstRun = currentUserId === "shared"/);
    expect(MANAGER).toMatch(/firstRun \? roleOptions\[roleOptions\.length - 1\] : roleOptions\[0\]/);
  });
});

describe("creating an invite", () => {
  it("checks it can mint a link BEFORE the login exists", () => {
    // Otherwise a missing secret leaves an account nobody can ever set up.
    const check = CREATE.indexOf("invitesConfigured()");
    const create = CREATE.indexOf("await createUser(");
    expect(check).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(check);
  });

  it("refuses a client login with no dashboards", () => {
    expect(CREATE).toMatch(/role === "client" && !parsed\.data\.clientIds\?\.length/);
  });

  it("is rate-limited per operator", () => {
    expect(CREATE).toMatch(/rateLimit\(`invite:\$\{session!\.userId\}`/);
  });
});

describe("🔴 managing one login needs the rank to have made it", () => {
  it("the shared helper applies mayAdminister after the tenant check", () => {
    const tenant = ACCESS.indexOf("getUserInAgency(");
    const rank = ACCESS.indexOf("mayAdminister(");
    expect(tenant).toBeGreaterThan(-1);
    expect(rank).toBeGreaterThan(tenant);
  });

  it("every per-user route goes through it", () => {
    for (const [name, src] of [["users/[id]", ONE], ["users/[id]/invite", RESEND]] as const) {
      expect(src, name).toMatch(/from "@\/lib\/user-access"/);
      expect(src, name).not.toMatch(/getUserInAgency|getUserById\(id\)/);
    }
  });
});

describe("🔴 nobody locks themselves out from the Users page", () => {
  it("refuses to disable your own login", () => {
    expect(ONE).toMatch(/d\.status === "disabled" && user\.id === got\.session\.userId/);
  });

  it("refuses to remove your own login", () => {
    const del = ONE.slice(ONE.indexOf("export async function DELETE"));
    const guard = del.indexOf("user.id === got.session.userId");
    expect(guard).toBeGreaterThan(-1);
    expect(del.indexOf("await deleteUser(")).toBeGreaterThan(guard);
  });
});

describe("sending a new link", () => {
  it("🔴 rotates the password only for a login that was never set up", () => {
    // Rotating a working account's hash would lock its owner out.
    expect(RESEND).toMatch(/pending \? await rotateInvite\(target\.id\) : target/);
  });

  it("refuses a disabled login rather than minting a dead link", () => {
    expect(RESEND).toMatch(/target\.status !== "active"/);
  });
});

describe("🔴 accepting an invite", () => {
  it("issues no session — sign-in stays the one route that mints them", () => {
    expect(ACCEPT).not.toMatch(/createSessionToken|cookies\.set|SESSION_COOKIE/);
  });

  it("writes through the compare-and-set, so a link cannot win twice", () => {
    expect(ACCEPT).toMatch(/await setPasswordFromLink\(found\.user, password\)/);
    expect(ACCEPT).toMatch(/if \(!won\)/);
  });

  it("enforces the same password length as everywhere else", () => {
    expect(ACCEPT).toMatch(/password\.length < MIN_PASSWORD_LENGTH/);
  });

  it("is rate-limited", () => {
    expect(ACCEPT).toMatch(/rateLimit\(`invite-accept:/);
  });
});

describe("🔴 a reset also confirms the address, through the same single-use write", () => {
  it("uses setPasswordFromLink, not a bare password write", () => {
    expect(RESET).toMatch(/await setPasswordFromLink\(found\.user, password\)/);
    expect(RESET).not.toMatch(/setUserPassword/);
  });
});

describe("🔴 the link never reaches the audit log", () => {
  /*
   * It IS the credential until it is used or expires, and an audit log is read
   * by more people than a password store is.
   */
  for (const [name, src] of [["create", CREATE], ["resend", RESEND], ["accept", ACCEPT]] as const) {
    it(name, () => {
      const blocks = [...src.matchAll(/audit\.record\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
      expect(blocks.length, `${name} records nothing`).toBeGreaterThan(0);
      for (const b of blocks) {
        expect(b).not.toMatch(/\burl\b|token|link\.url|\blink\b(?!\?\.emailed|\.emailed)/);
      }
    });
  }
});
