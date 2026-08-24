import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, desc } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { auditScope } from "@/lib/audit-scope";
import type { SessionPayload } from "@/lib/session";

/**
 * Who reads whose audit trail.
 *
 * Run against PGlite rather than asserted on the predicate object, because the
 * property that matters is a Postgres one: `agency_id = $1` does not match
 * NULL. Every untenanted row in the fixture — the failed logins — exists to
 * prove that, since a predicate that accidentally included them would hand each
 * agency the platform's own security events.
 */

const DDL = `
CREATE TABLE audit_log (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at        timestamptz NOT NULL DEFAULT now(),
  action    text NOT NULL,
  agency_id uuid
);
`;

const AGENCY_A = "11111111-1111-1111-1111-111111111111";
const AGENCY_B = "22222222-2222-2222-2222-222222222222";

const ROWS: Array<[action: string, agency: string | null]> = [
  ["meta_account.add", AGENCY_A],
  ["client.update", AGENCY_A],
  ["auth.login", AGENCY_A],
  ["google_account.add", AGENCY_B],
  ["client.archive", AGENCY_B],
  // Untenanted: nobody's login, and a throttle that fired before any agency
  // existed. Superadmin-only by construction.
  ["auth.login_failed", null],
  ["auth.signup_rate_limited", null],
];

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  db = drizzle(pg);
  for (const [action, agency] of ROWS) {
    await pg.query("INSERT INTO audit_log (action, agency_id) VALUES ($1,$2)", [
      action,
      agency,
    ]);
  }
});

afterAll(async () => {
  await pg.close();
});

function session(over: Partial<SessionPayload>): SessionPayload {
  return {
    userId: "u1",
    agencyId: AGENCY_A,
    role: "agency",
    slugs: [],
    ...over,
  } as SessionPayload;
}

/** What this session would actually read, through the same call shape as `listAuditEntries`. */
async function read(s: SessionPayload | null): Promise<string[]> {
  const scope = auditScope(s);
  if (scope === "none") return [];
  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(undefined, scope))
    .orderBy(desc(auditLog.at));
  return rows.map((r) => r.action).sort();
}

describe("auditScope", () => {
  it("shows an agency its own entries", async () => {
    expect(await read(session({ role: "agency", agencyId: AGENCY_A }))).toEqual([
      "auth.login",
      "client.update",
      "meta_account.add",
    ]);
  });

  it("shows the other agency only its own", async () => {
    expect(await read(session({ role: "agency", agencyId: AGENCY_B }))).toEqual([
      "client.archive",
      "google_account.add",
    ]);
  });

  it("🔴 never shows an agency the untenanted platform events", async () => {
    const seen = await read(session({ role: "agency", agencyId: AGENCY_A }));
    expect(seen).not.toContain("auth.login_failed");
    expect(seen).not.toContain("auth.signup_rate_limited");
  });

  it("shows superadmin everything, untenanted rows included", async () => {
    expect(await read(session({ role: "superadmin" }))).toEqual(
      ROWS.map(([a]) => a).sort(),
    );
  });

  it("shows staff everything, as before tenancy", async () => {
    expect(await read(session({ role: "staff" }))).toEqual(
      ROWS.map(([a]) => a).sort(),
    );
  });

  it("shows a client-role login nothing", async () => {
    // A customer of a customer. Their dashboard is theirs; the record of who
    // rotated its credentials is not.
    expect(await read(session({ role: "client", slugs: ["acme"] }))).toEqual([]);
  });

  it("shows an anonymous caller nothing", async () => {
    expect(await read(null)).toEqual([]);
  });

  it("denies an agency session carrying no tenant", async () => {
    expect(await read(session({ role: "agency", agencyId: "" }))).toEqual([]);
  });

  it("distinguishes deny from no-filter by TYPE, not by value", () => {
    /*
     * 🔴 The failure this guards: `undefined` means "no WHERE" to Drizzle, so
     * returning it for a denied session would return the entire table. Deny is
     * a string the caller cannot pass to `and()` by mistake.
     */
    expect(auditScope(null)).toBe("none");
    expect(auditScope(session({ role: "client" }))).toBe("none");
    expect(auditScope(session({ role: "superadmin" }))).toBeUndefined();
    expect(auditScope(session({ role: "agency" }))).not.toBe("none");
    expect(auditScope(session({ role: "agency" }))).toBeDefined();
  });
});
