import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * Whose name goes on the report.
 *
 * 🔴 The bug this locks down: `agency_settings.agency_name` is null by default
 * and means "use `agencies.name`", but nothing implemented that fallback. With
 * `agency_mark_mode` defaulting to `prepared_by`, every agency's report footer
 * rendered the words "Prepared by " followed by nothing — on PDFs, share links
 * and print views, for the bootstrap tenant and for every self-serve sign-up
 * alike. It was invisible in code review because both halves read correctly on
 * their own.
 *
 * The resolution is a LEFT JOIN, so it is a property of SQL rather than of
 * TypeScript and belongs in a real Postgres. The `getAgencySettings` wrapper
 * cannot be imported here — `branding-store.ts` pulls in `@/db`, which connects
 * at import — so the query is expressed directly and the wrapper's mapping is
 * asserted by inspection of the same three cases.
 */

const DDL = `
CREATE TYPE agency_mark_mode AS ENUM ('full', 'prepared_by', 'none');

CREATE TABLE agencies (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL
);

CREATE TABLE agency_settings (
  agency_id        uuid PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
  agency_name      text,
  agency_mark_mode agency_mark_mode NOT NULL DEFAULT 'prepared_by',
  support_email    text,
  logo_version     integer NOT NULL DEFAULT 0
);
`;

/** Tenant with a settings row and NO override — the default for everyone. */
const PLAIN = "11111111-1111-1111-1111-111111111111";
/** Tenant that has set a trading name. */
const WHITELABEL = "22222222-2222-2222-2222-222222222222";
/** Tenant with no settings row at all — a sign-up whose first read is pending. */
const FRESH = "33333333-3333-3333-3333-333333333333";

const SEED = `
INSERT INTO agencies (id, name, slug) VALUES
  ('${PLAIN}', 'Bright Lane Marketing', 'bright-lane'),
  ('${WHITELABEL}', 'Holdco Ltd', 'holdco'),
  ('${FRESH}', 'Just Signed Up', 'just-signed-up');

INSERT INTO agency_settings (agency_id, agency_name) VALUES
  ('${PLAIN}', NULL),
  ('${WHITELABEL}', 'Peak Digital');
`;

/** The query `getAgencySettings` runs, in the same shape. */
const RESOLVE = `
SELECT s.agency_name AS override, a.name AS tenant_name
  FROM agencies a
  LEFT JOIN agency_settings s ON s.agency_id = a.id
 WHERE a.id = $1
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  await pg.exec(SEED);
});

afterAll(async () => {
  await pg.close();
});

/** Mirrors the mapping in `getAgencySettings`: override, else tenant name. */
async function resolvedName(agencyId: string): Promise<string | null> {
  const res = await pg.query<{ override: string | null; tenant_name: string | null }>(
    RESOLVE,
    [agencyId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return row.override ?? row.tenant_name ?? null;
}

describe("the name on the report", () => {
  it("falls back to the tenant's own name when no override is set", async () => {
    // The case that was broken, and it is the DEFAULT case — no agency has ever
    // had a way to set an override, so this is every agency.
    expect(await resolvedName(PLAIN)).toBe("Bright Lane Marketing");
  });

  it("prefers the override when the agency white-labels", async () => {
    expect(await resolvedName(WHITELABEL)).toBe("Peak Digital");
  });

  it("resolves for a tenant whose settings row does not exist yet", async () => {
    /*
     * The left join is what makes this work. An inner join — or a query against
     * `agency_settings` alone, which is what the code did — returns nothing
     * here, and a brand-new agency's first report is very often the first thing
     * it sends a client.
     */
    expect(await resolvedName(FRESH)).toBe("Just Signed Up");
  });

  it("returns null for an agency that does not exist", async () => {
    expect(await resolvedName("44444444-4444-4444-4444-444444444444")).toBeNull();
  });

  it("follows a rename instead of freezing a copy", async () => {
    /*
     * Why this resolves at read time rather than backfilling the column. An
     * agency that rebrands gets a correct footer on its next report; a backfill
     * would have written the old name into every tenant's settings row, where
     * it would sit looking deliberate.
     */
    await pg.exec(`UPDATE agencies SET name = 'Bright Lane Group' WHERE id = '${PLAIN}'`);
    expect(await resolvedName(PLAIN)).toBe("Bright Lane Group");

    // ...but an explicit override is a choice, and a rename must not overwrite it.
    await pg.exec(`UPDATE agencies SET name = 'Holdco Group' WHERE id = '${WHITELABEL}'`);
    expect(await resolvedName(WHITELABEL)).toBe("Peak Digital");
  });
});
