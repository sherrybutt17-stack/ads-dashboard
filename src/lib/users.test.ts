import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * User accounts: who exists, what role they hold, and which dashboards they
 * may open.
 *
 * ── Why the grant rules get the most attention here ───────────────────
 *
 * `user_clients` is the only place in the system where one person's access is
 * written down as data rather than derived from a rule. Everything else about
 * authorization is a function of role and tenant; this is a table someone types
 * into. A wrong row here is not a crash, it is a login that quietly sees
 * something it should not — or, just as bad, does not see something it should
 * and gets told the dashboard is empty.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let mod: typeof import("./users");

const AGENCY_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const AGENCY_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CLIENT_A1 = "11111111-1111-1111-1111-111111111111";
const CLIENT_A2 = "22222222-2222-2222-2222-222222222222";
const CLIENT_B1 = "33333333-3333-3333-3333-333333333333";

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const grants = async (userId: string) =>
  (
    await run(
      `SELECT client_id::text AS c FROM user_clients WHERE user_id = '${userId}' ORDER BY c`,
    )
  ).rows.map((r) => r.c);

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./users");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(`TRUNCATE users, user_clients, clients RESTART IDENTITY CASCADE`);
  for (const [id, slug, agency] of [
    [CLIENT_A1, "acme", AGENCY_A],
    [CLIENT_A2, "beta", AGENCY_A],
    [CLIENT_B1, "rival", AGENCY_B],
  ] as const) {
    await run(
      `INSERT INTO clients (id, name, slug, agency_id)
       VALUES ('${id}', '${slug}', '${slug}', '${agency}')`,
    );
  }
});

const make = (over: Partial<Parameters<typeof mod.createUser>[0]> = {}) =>
  mod.createUser({
    agencyId: AGENCY_A,
    email: "Dana@Example.COM ",
    password: "correct horse battery staple",
    role: "client",
    clientIds: [CLIENT_A1],
    ...over,
  });

describe("creating a login", () => {
  it("normalises the email so a login cannot be duplicated by case", async () => {
    /*
     * `verifyCredentials` looks up by exact match on a lowercased input, so a
     * row stored with capitals would be unreachable — the account would exist
     * and simply never accept its own password.
     */
    const user = await make();
    expect(user.email).toBe("dana@example.com");
    expect(await mod.verifyCredentials("  DANA@example.com ", "correct horse battery staple"))
      .not.toBeNull();
  });

  it("never stores or returns the plaintext password", async () => {
    const user = await make({ password: "s3cret-plaintext" });
    expect(JSON.stringify(user)).not.toContain("s3cret-plaintext");
    expect(user.passwordHash).toMatch(/^scrypt\$/);
  });

  it("grants only what a client-role login was given", async () => {
    const user = await make({ clientIds: [CLIENT_A1, CLIENT_A2] });
    expect(await grants(user.id)).toEqual([CLIENT_A1, CLIENT_A2].sort());
  });

  it("🔴 writes no grants for a role that sees its whole agency", async () => {
    /*
     * An `agency` login is authorized by tenant, not by grant. Writing rows
     * anyway would make the two mechanisms disagree the moment a client is
     * added — the new dashboard would be visible by role and absent from the
     * grant list, and whichever surface read the grants would under-report.
     */
    const user = await make({ role: "agency", clientIds: [CLIENT_A1] });
    expect(await grants(user.id)).toEqual([]);
  });
});

describe("cross-tenant grants", () => {
  /*
   * 🔴 The route takes `clientIds` straight from the request body. `agencyId`
   * and `role` are both taken from the session and gated — roles by
   * `assignableRoles`, the tenant by never reading it from input — but the
   * client ids were not checked against the agency at all.
   *
   * This is NOT exploitable today, and the tests below say so precisely:
   * `sessionMaySeeClient` compares tenants BEFORE it consults the slug grant,
   * and every `/c/[slug]` page resolves through `getClientForSession`. The
   * grant is inert.
   *
   * It is still worth refusing at the source. The row is written, invisible on
   * the page that manages it (`listUsersForAgency` scopes its join), and it
   * puts a foreign slug into the session token where it is carried but unusable
   * — so the safety rests entirely on three downstream checks keeping their
   * current order forever. A grant that cannot be created is a smaller thing to
   * protect than a grant that must never be honoured.
   */

  it("🔴 refuses a client belonging to another agency", async () => {
    await expect(make({ clientIds: [CLIENT_B1] })).rejects.toThrow(/agency/i);
    const rows = await run(`SELECT count(*)::int AS n FROM user_clients`);
    expect(rows.rows[0].n).toBe(0);
  });

  it("🔴 refuses the whole request rather than silently dropping the bad id", async () => {
    /*
     * Partial success is the worse failure. The form would report "saved", the
     * operator would believe both dashboards were granted, and the missing one
     * would surface later as a client saying they cannot see their own report.
     */
    await expect(make({ clientIds: [CLIENT_A1, CLIENT_B1] })).rejects.toThrow(/agency/i);
    expect((await run(`SELECT count(*)::int AS n FROM user_clients`)).rows[0].n).toBe(0);
  });

  it("refuses a client id that does not exist at all", async () => {
    await expect(
      make({ clientIds: ["99999999-9999-4999-8999-999999999999"] }),
    ).rejects.toThrow(/agency/i);
  });

  it("🔴 applies the same rule when grants are replaced later", async () => {
    // The update path is the one an attacker would reach for second.
    const user = await make({ clientIds: [CLIENT_A1] });
    await expect(mod.setUserClients(user.id, [CLIENT_B1])).rejects.toThrow(/agency/i);
    // …and the existing grants survive the refusal.
    expect(await grants(user.id)).toEqual([CLIENT_A1]);
  });

  it("still allows a legitimate replacement", async () => {
    const user = await make({ clientIds: [CLIENT_A1] });
    await mod.setUserClients(user.id, [CLIENT_A2]);
    expect(await grants(user.id)).toEqual([CLIENT_A2]);
  });

  it("refuses to grant anything to a user who does not exist", async () => {
    // Reached by a stale id from a page left open while the user was deleted.
    await expect(
      mod.setUserClients("99999999-9999-4999-8999-999999999999", [CLIENT_A1]),
    ).rejects.toThrow(/not found/i);
  });

  it("allows clearing every grant", async () => {
    const user = await make({ clientIds: [CLIENT_A1] });
    await mod.setUserClients(user.id, []);
    expect(await grants(user.id)).toEqual([]);
  });
});

describe("signing in", () => {
  it("rejects a disabled account even with the right password", async () => {
    const user = await make();
    await mod.setUserStatus(user.id, "disabled");
    expect(
      await mod.verifyCredentials("dana@example.com", "correct horse battery staple"),
    ).toBeNull();
  });

  it("rejects the wrong password", async () => {
    await make();
    expect(await mod.verifyCredentials("dana@example.com", "wrong")).toBeNull();
  });

  it("rejects an unknown address without distinguishing it from a bad password", async () => {
    // Same null either way — the login form must not confirm which addresses
    // have accounts.
    expect(await mod.verifyCredentials("nobody@example.com", "anything")).toBeNull();
  });

  it("accepts the new password after a reset, and not the old one", async () => {
    const user = await make();
    await mod.setUserPassword(user.id, "a brand new passphrase");
    expect(await mod.verifyCredentials("dana@example.com", "a brand new passphrase"))
      .not.toBeNull();
    expect(
      await mod.verifyCredentials("dana@example.com", "correct horse battery staple"),
    ).toBeNull();
  });
});

describe("reading users across a tenant boundary", () => {
  async function twoAgencies() {
    const a = await make({ email: "a@example.com" });
    const b = await mod.createUser({
      agencyId: AGENCY_B,
      email: "b@example.com",
      password: "x".repeat(20),
      role: "client",
      clientIds: [CLIENT_B1],
    });
    return { a, b };
  }

  it("🔴 lists only the asking agency's users", async () => {
    /*
     * There is deliberately no `listUsers()`. It fed the /users page, so the
     * moment a second agency existed one agency's admin saw every other
     * agency's staff — names, emails, roles, last-login times and which clients
     * each holds. A better target list than most of what this app protects.
     */
    await twoAgencies();
    const list = await mod.listUsersForAgency(AGENCY_A);
    expect(list.map((u) => u.email)).toEqual(["a@example.com"]);
  });

  it("🔴 scopes the client column too, not just the user rows", async () => {
    /*
     * A grant pointing at another agency's client would print that client's
     * name and slug on this page, so the join carries its own predicate.
     *
     * 🔴 The bad row is inserted DIRECTLY, because `createUser` now refuses to
     * make one — which is exactly why this test would otherwise stop testing
     * anything. Closing a hole at the source does not retire the defences
     * downstream of it: rows written before the check existed, or by a future
     * path that forgets it, still have to be handled here. A test that can only
     * build its fixture through the fixed path measures the fix, not the
     * defence.
     */
    const { a } = await twoAgencies();
    await run(
      `INSERT INTO user_clients (user_id, client_id) VALUES ('${a.id}', '${CLIENT_B1}')`,
    );

    const [user] = await mod.listUsersForAgency(AGENCY_A);
    expect(user.clients.map((c) => c.slug)).toEqual(["acme"]);
  });

  it("🔴 getUserInAgency answers null for 'not yours', same as for 'no such user'", async () => {
    /*
     * One null for both, so the endpoint cannot be walked to discover which
     * uuids are real — the same rule as `getClientByIdForSession`.
     */
    const { b } = await twoAgencies();
    expect(await mod.getUserInAgency(AGENCY_A, b.id)).toBeNull();
    expect(
      await mod.getUserInAgency(AGENCY_A, "99999999-9999-4999-8999-999999999999"),
    ).toBeNull();
    expect(await mod.getUserInAgency(AGENCY_B, b.id)).not.toBeNull();
  });

  it("resolves the slugs a login may open", async () => {
    const user = await make({ clientIds: [CLIENT_A1, CLIENT_A2] });
    expect((await mod.allowedSlugsForUser(user.id)).sort()).toEqual(["acme", "beta"]);
  });
});

describe("housekeeping", () => {
  it("deleting a user takes their grants with them", async () => {
    // Left behind, they would attach to whatever uuid the database reissued.
    const user = await make();
    await mod.deleteUser(user.id);
    expect(await grants(user.id)).toEqual([]);
  });

  it("stamps an address verified, idempotently", async () => {
    const user = await make();
    await mod.markEmailVerified(user.id);
    const first = await mod.getUserById(user.id);
    await mod.markEmailVerified(user.id);
    expect(first?.emailVerifiedAt).not.toBeNull();
    expect((await mod.getUserById(user.id))?.emailVerifiedAt).not.toBeNull();
  });

  it("records a login without changing anything else", async () => {
    const user = await make();
    expect(user.lastLoginAt).toBeNull();
    await mod.touchLastLogin(user.id);
    const after = await mod.getUserById(user.id);
    expect(after?.lastLoginAt).not.toBeNull();
    expect(after?.status).toBe("active");
    expect(after?.passwordHash).toBe(user.passwordHash);
  });
});
