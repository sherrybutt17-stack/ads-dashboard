import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { clients } from "@/db/schema";
import { clientScopeFilter } from "@/lib/client-scope-sql";
import { sessionMaySeeClient } from "@/lib/client-scope";
import type { SessionPayload } from "@/lib/session";

/**
 * 🔴 Two implementations of one rule, held to the same answer.
 *
 * `sessionMaySeeClient` decides in TypeScript; `clientScopeFilter` narrows in
 * SQL. Both exist for good reasons (see `client-scope-sql.ts`), and two copies
 * of an authorization rule is exactly the arrangement that drifts — one gets
 * updated for a new role and the other is remembered a release later.
 *
 * So rather than testing the SQL against hand-written expectations, every case
 * below asserts the SQL result set EQUALS the in-memory filter over the same
 * rows. A rule change that touches one and not the other fails here, whichever
 * one was forgotten.
 *
 * Run against PGlite — real Postgres in WASM — because the interesting failures
 * are Postgres behaviours, not JavaScript ones: an empty `IN ()` list, and a
 * uuid column being compared to an empty string.
 */

/**
 * Only the three columns the predicate touches.
 *
 * Rows go in through raw SQL rather than `db.insert(clients)`, which would emit
 * `clients`' entire column list and make this test fail whenever an unrelated
 * column is added to the schema. The reads below select `slug` alone, so the
 * coupling is exactly the surface being tested: `agency_id` and `slug`.
 */
const DDL = `
CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL,
  name text NOT NULL,
  slug text NOT NULL
);
CREATE UNIQUE INDEX clients_slug_key ON clients (slug);
`;

const AGENCY_A = "11111111-1111-1111-1111-111111111111";
const AGENCY_B = "22222222-2222-2222-2222-222222222222";

/** Two tenants, so "sees its own" and "sees only its own" are distinguishable. */
const ROWS = [
  { agencyId: AGENCY_A, slug: "acme", name: "Acme" },
  { agencyId: AGENCY_A, slug: "acme-dental", name: "Acme Dental" },
  { agencyId: AGENCY_A, slug: "parfaire", name: "Parfaire" },
  { agencyId: AGENCY_B, slug: "borden", name: "Borden" },
  { agencyId: AGENCY_B, slug: "cardinal", name: "Cardinal" },
];

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  db = drizzle(pg);
  for (const r of ROWS) {
    await pg.query("INSERT INTO clients (agency_id, name, slug) VALUES ($1,$2,$3)", [
      r.agencyId,
      r.name,
      r.slug,
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

/** Slugs the SQL predicate returns, sorted. */
async function viaSql(s: SessionPayload): Promise<string[]> {
  const rows = await db
    .select({ slug: clients.slug })
    .from(clients)
    .where(clientScopeFilter(s));
  return rows.map((r) => r.slug).sort();
}

/** Slugs the in-memory rule allows, over every row in the table, sorted. */
function viaRule(s: SessionPayload): string[] {
  return ROWS.filter((r) => sessionMaySeeClient(s, r))
    .map((r) => r.slug)
    .sort();
}

const CASES: Array<{ label: string; session: SessionPayload; expect: string[] }> = [
  {
    label: "an agency owner sees its own clients and no others",
    session: session({ role: "agency", agencyId: AGENCY_A }),
    expect: ["acme", "acme-dental", "parfaire"],
  },
  {
    label: "the other agency sees only its own",
    session: session({ role: "agency", agencyId: AGENCY_B }),
    expect: ["borden", "cardinal"],
  },
  {
    label: "a client login sees only its granted slugs",
    session: session({ role: "client", agencyId: AGENCY_A, slugs: ["acme"] }),
    expect: ["acme"],
  },
  {
    label: "a client login with several grants sees all of them",
    session: session({
      role: "client",
      agencyId: AGENCY_A,
      slugs: ["acme", "parfaire"],
    }),
    expect: ["acme", "parfaire"],
  },
  {
    label: "a client login with no grants sees nothing",
    session: session({ role: "client", agencyId: AGENCY_A, slugs: [] }),
    expect: [],
  },
  {
    /*
     * The gate-3 case from `client-scope.ts`: the grant is inside the tenant, so
     * the tenant check alone would pass and hand this login its agency's other
     * clients.
     */
    label: "a client grant does not widen to the rest of its agency",
    session: session({
      role: "client",
      agencyId: AGENCY_A,
      slugs: ["acme-dental"],
    }),
    expect: ["acme-dental"],
  },
  {
    label: "a client login cannot reach another tenant's slug it was granted",
    session: session({ role: "client", agencyId: AGENCY_A, slugs: ["borden"] }),
    expect: [],
  },
  {
    label: "superadmin crosses tenants",
    session: session({ role: "superadmin", agencyId: AGENCY_A }),
    expect: ROWS.map((r) => r.slug).sort(),
  },
  {
    label: "staff crosses tenants, as it did before tenancy existed",
    session: session({ role: "staff", agencyId: AGENCY_A }),
    expect: ROWS.map((r) => r.slug).sort(),
  },
];

describe("clientScopeFilter", () => {
  for (const c of CASES) {
    it(c.label, async () => {
      expect(await viaSql(c.session)).toEqual(c.expect);
    });

    it(`agrees with sessionMaySeeClient — ${c.label}`, async () => {
      expect(await viaSql(c.session)).toEqual(viaRule(c.session));
    });
  }

  it("denies rather than crashing when a scoped role has no agency", async () => {
    /*
     * `agency_id` is a uuid column, so an empty string is not merely a filter
     * that matches nothing — it is `invalid input syntax for type uuid`, a 500
     * where an empty list belongs. This case is the reason the predicate checks
     * for it explicitly.
     */
    const s = session({ role: "agency", agencyId: "" });
    await expect(viaSql(s)).resolves.toEqual([]);
    expect(viaRule(s)).toEqual([]);
  });

  it("returns undefined for cross-tenant roles so callers compose cleanly", () => {
    // Drizzle's `and()` drops undefined; `sql`true`` would append a clause to
    // every superadmin query for no benefit.
    expect(clientScopeFilter(session({ role: "superadmin" }))).toBeUndefined();
    expect(clientScopeFilter(session({ role: "staff" }))).toBeUndefined();
    expect(clientScopeFilter(session({ role: "agency" }))).toBeDefined();
    expect(clientScopeFilter(session({ role: "client" }))).toBeDefined();
  });
});
