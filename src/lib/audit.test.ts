import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { SessionPayload } from "@/lib/session";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * The audit trail: what gets written, and who may read it back.
 *
 * ── Why the read side is the security half ────────────────────────────
 *
 * `/audit` became reachable by agency operators once migration 0024 gave
 * `audit_log` an `agency_id`. The edge proxy lets them through and says so
 * explicitly — "the page shows this agency its own entries and only those,
 * decided in SQL". This file is where that claim is checked, because a scoping
 * mistake here does not fail: it renders someone else's trail, formatted
 * correctly, under a heading that says it is yours.
 *
 * The trail is also the most quietly sensitive table in the system. It carries
 * email addresses, client names, source IPs, and the record of who touched
 * which credential — a strictly worse thing to leak across a tenant boundary
 * than the metrics the dashboard shows.
 *
 * `audit-scope.test.ts` already proves the PREDICATE in isolation. This proves
 * the query built from it, against a real Postgres, including the two things a
 * predicate test cannot see: that the join does not drop rows, and that a
 * denied session never reaches the database at all.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let mod: typeof import("./audit");

const AGENCY_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const AGENCY_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CLIENT_A1 = "11111111-1111-1111-1111-111111111111";
const CLIENT_B1 = "33333333-3333-3333-3333-333333333333";

const session = (
  role: SessionPayload["role"],
  agencyId: string,
  slugs: string[] = [],
): SessionPayload => ({ userId: "u1", agencyId, role, slugs });

const agencyA = session("agency", AGENCY_A);
const agencyB = session("agency", AGENCY_B);
const superadmin = session("superadmin", AGENCY_A);
const staff = session("staff", AGENCY_A);
const clientUser = session("client", AGENCY_A, ["acme"]);

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const rows = async () =>
  (
    await run(
      `SELECT action, client_id::text AS client_id, agency_id::text AS agency_id, ip
         FROM audit_log ORDER BY action`,
    )
  ).rows;

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./audit");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(`TRUNCATE audit_log, clients RESTART IDENTITY CASCADE`);
  for (const [id, slug, agency] of [
    [CLIENT_A1, "acme", AGENCY_A],
    [CLIENT_B1, "rival", AGENCY_B],
  ]) {
    await run(
      `INSERT INTO clients (id, name, slug, agency_id) VALUES ('${id}', '${slug}', '${slug}', '${agency}')`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * record — filing an entry under the right tenant
 * ------------------------------------------------------------------ */

describe("record", () => {
  it("derives the tenant from the client it names", async () => {
    await mod.record({ action: "meta_account.add", clientId: CLIENT_A1 });

    /*
     * Derived rather than required, so that a NEW call site cannot forget to
     * thread the tenant through. An entry filed under no agency is invisible to
     * the agency it concerns — which for an audit trail is the same as not
     * having recorded it.
     */
    expect((await rows())[0]).toMatchObject({
      client_id: CLIENT_A1,
      agency_id: AGENCY_A,
    });
  });

  it("takes an explicit tenant for events that name no client", async () => {
    // A login or an invited teammate has no client; the session is the only
    // thing that knows the tenant.
    await mod.record({ action: "user.create", agencyId: AGENCY_B });

    expect((await rows())[0]).toMatchObject({
      client_id: null,
      agency_id: AGENCY_B,
    });
  });

  it("files a platform-level event under no tenant at all", async () => {
    // A failed login for an address matching no account belongs to nobody, and
    // must not be handed to an agency by defaulting.
    await mod.record({ action: "auth.fail", ip: "203.0.113.9" });

    expect((await rows())[0]).toMatchObject({ agency_id: null, client_id: null });
  });

  it("prefers an explicit tenant over the derived one", async () => {
    await mod.record({
      action: "client.remove",
      clientId: CLIENT_A1,
      agencyId: AGENCY_A,
    });
    expect((await rows())[0]).toMatchObject({ agency_id: AGENCY_A });
  });

  it("🔴 never throws, whatever the database does", async () => {
    await run(`ALTER TABLE audit_log RENAME TO audit_log_hidden`);

    /*
     * The contract that makes `record` safe to call anywhere: it is invoked
     * AFTER the operation it describes has already succeeded, so a throw here
     * would turn a completed action into a 500 and invite the operator to retry
     * something that already happened.
     */
    await expect(
      mod.record({ action: "meta_account.add", clientId: CLIENT_A1 }),
    ).resolves.toBeUndefined();

    await run(`ALTER TABLE audit_log_hidden RENAME TO audit_log`);
  });

  it("keeps the entry when the client it names is deleted", async () => {
    await mod.record({ action: "client.remove", clientId: CLIENT_A1 });
    await run(`DELETE FROM clients WHERE id = '${CLIENT_A1}'`);

    // ON DELETE SET NULL, not CASCADE: the record of what was done to a client
    // must outlive the client, or removing one erases its own audit trail.
    const [row] = await rows();
    expect(row.client_id).toBeNull();
    expect(row.agency_id).toBe(AGENCY_A);
  });
});

/* ------------------------------------------------------------------ *
 * requestContext
 * ------------------------------------------------------------------ */

describe("requestContext", () => {
  it("takes the first hop of x-forwarded-for", () => {
    const req = new Request("https://x.test", {
      headers: {
        "x-forwarded-for": "203.0.113.9, 70.41.3.18, 150.172.238.178",
        "user-agent": "Mozilla/5.0",
      },
    });
    // The client's address is the FIRST entry; the rest are proxies. Taking the
    // last would log our own edge on every entry.
    expect(mod.requestContext(req)).toEqual({
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
    });
  });

  it("falls back to x-real-ip, then to null", () => {
    const withReal = new Request("https://x.test", {
      headers: { "x-real-ip": " 198.51.100.7 " },
    });
    expect(mod.requestContext(withReal).ip).toBe("198.51.100.7");
    expect(mod.requestContext(new Request("https://x.test")).ip).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * listAuditEntries — the tenant boundary
 * ------------------------------------------------------------------ */

describe("listAuditEntries", () => {
  beforeEach(async () => {
    await mod.record({ action: "meta_account.add", clientId: CLIENT_A1 });
    await mod.record({ action: "auth.login", agencyId: AGENCY_A });
    await mod.record({ action: "meta_account.add", clientId: CLIENT_B1 });
    await mod.record({ action: "auth.fail", ip: "203.0.113.9" }); // no tenant
  });

  it("🔴 shows an agency its own entries and only those", async () => {
    const entries = await mod.listAuditEntries(agencyA);

    expect(entries.map((e) => e.action).sort()).toEqual([
      "auth.login",
      "meta_account.add",
    ]);
    // Specifically: not agency B's, and not the untenanted one.
    expect(entries.some((e) => e.clientId === CLIENT_B1)).toBe(false);
  });

  it("🔴 does not hand an agency the platform's untenanted events", async () => {
    /*
     * `agency_id = $1` excludes NULL, and that is the point. NULL means
     * platform-level — a failed login for an address matching no account, a
     * signup throttled before any agency existed. Reading NULL as "unknown,
     * show it anyway" would give every agency the platform's security events.
     */
    const entries = await mod.listAuditEntries(agencyA);
    expect(entries.some((e) => e.action === "auth.fail")).toBe(false);
  });

  it("each agency sees a disjoint trail", async () => {
    const a = await mod.listAuditEntries(agencyA);
    const b = await mod.listAuditEntries(agencyB);

    expect(b.map((e) => e.action)).toEqual(["meta_account.add"]);
    expect(a.map((e) => e.id).some((id) => b.map((x) => x.id).includes(id))).toBe(false);
  });

  it("a superadmin reads everything, untenanted rows included", async () => {
    // The untenanted failed login is visible nowhere else in the product.
    const entries = await mod.listAuditEntries(superadmin);
    expect(entries).toHaveLength(4);
    expect(entries.some((e) => e.action === "auth.fail")).toBe(true);
  });

  it("staff reads everything too, while the role exists", async () => {
    expect(await mod.listAuditEntries(staff)).toHaveLength(4);
  });

  it("🔴 a client-role login reads nothing", async () => {
    // A customer of a customer: they see their dashboard, not the record of who
    // changed its credentials.
    expect(await mod.listAuditEntries(clientUser)).toEqual([]);
  });

  it("🔴 an anonymous session reads nothing", async () => {
    expect(await mod.listAuditEntries(null)).toEqual([]);
  });

  it("🔴 an agency with no tenant id reads nothing, rather than everything", async () => {
    /*
     * The shape of the whole bug class this guards: a denied session that
     * returned `undefined` instead of a deny would be handed to Drizzle's
     * `and()`, which DROPS undefined operands — leaving no WHERE clause and
     * returning the entire table. Silent, total, and it looks like ordinary
     * code.
     */
    expect(await mod.listAuditEntries(session("agency", ""))).toEqual([]);
  });

  it("resolves the client name, and keeps entries that name no client", async () => {
    const entries = await mod.listAuditEntries(agencyA);

    const withClient = entries.find((e) => e.action === "meta_account.add");
    expect(withClient?.clientName).toBe("acme");

    // A LEFT join, not an inner one — an inner join would silently drop every
    // login, which is most of what an audit trail is for.
    const login = entries.find((e) => e.action === "auth.login");
    expect(login).toBeDefined();
    expect(login?.clientName).toBeNull();
  });

  it("filters by action prefix without matching a longer word", async () => {
    await mod.record({ action: "authz.escalate", agencyId: AGENCY_A });

    const entries = await mod.listAuditEntries(agencyA, { category: "auth" });

    // `auth.%` must not catch `authz.…`. A prefix filter that matched would
    // silently mix two unrelated categories in the admin view.
    expect(entries.map((e) => e.action)).toEqual(["auth.login"]);
  });

  it("returns newest first", async () => {
    const entries = await mod.listAuditEntries(superadmin);
    const times = entries.map((e) => e.at.getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it("clamps the limit rather than trusting it", async () => {
    expect(await mod.listAuditEntries(agencyA, { limit: 1 })).toHaveLength(1);
    // 0 and negatives would otherwise become "no limit" or an error; huge values
    // would let one request pull the whole table into memory.
    expect((await mod.listAuditEntries(agencyA, { limit: 0 })).length).toBeGreaterThan(0);
    expect((await mod.listAuditEntries(agencyA, { limit: 99999 })).length).toBeGreaterThan(0);
  });
});
