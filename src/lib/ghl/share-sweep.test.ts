import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, CLIENT_C, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * The hourly repair for shared sub-accounts, against real Postgres. Each case
 * breaks the share the way the live path can leave it — a copy missing, a tag
 * never dated, a rule change cut short, a stamp left on a client that stopped
 * sharing — and checks one sweep puts it right.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

// GoHighLevel is never called here: a settle re-read "succeeds" by stamping the read.
vi.mock("./process", () => ({
  rereadContact: vi.fn(async () => false),
}));

let sw: typeof import("./share-sweep");
let sh: typeof import("./share");

const H = CLIENT_A;
const M = CLIENT_B;
const LONER = CLIENT_C;
const I = "f1000000-0000-0000-0000-000000000001";
const LONER_I = "f1000000-0000-0000-0000-000000000002";
const AGENCY = "ae000000-0000-0000-0000-000000000001";

const run = (s: string) => harness.db.execute(sql.raw(s));
const many = async (s: string) => {
  for (const stmt of s.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await run(stmt);
};
const one = async <T>(s: string) => ((await run(s)) as unknown as { rows: T[] }).rows;

async function countedFor(gid: string): Promise<string | null> {
  const [r] = await one<{ client: string | null }>(`
    SELECT (SELECT client_id::text FROM contacts WHERE share_installation_id = '${I}'
             AND ghl_contact_id = '${gid}' AND share_counted) AS client`);
  return r.client;
}

beforeAll(async () => {
  harness = await createTestDb();
  sw = await import("./share-sweep");
  sh = await import("./share");
  await many(`
    INSERT INTO agencies (id, name, slug) VALUES ('${AGENCY}', 'Reflexion Digital', 'reflexion');
    INSERT INTO clients (id, name, slug, timezone, agency_id) VALUES
      ('${H}', 'Aloha LASER Vision', 'aloha-vision', 'UTC', '${AGENCY}'),
      ('${M}', 'Aloha Laser Aesthetic', 'aloha-aesthetic', 'UTC', '${AGENCY}'),
      ('${LONER}', 'IQ Laser Vision', 'iq', 'UTC', '${AGENCY}');
    INSERT INTO ghl_installations (id, location_id, access_token_encrypted, refresh_token_encrypted, expires_at, client_id) VALUES
      ('${I}', 'loc-aloha', 'x', 'y', now() + interval '1 day', '${H}'),
      ('${LONER_I}', 'loc-iq', 'x', 'y', now() + interval '1 day', '${LONER}');
    INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, ghl_stage_name, canonical_stage) VALUES
      ('${H}', 'p1', 's-new', 'New Lead', 'new_lead');
    INSERT INTO contacts (client_id, ghl_contact_id, tags, ghl_created_at, attribution_fetched_at, updated_at) VALUES
      ('${H}', 'g1', '{lasik}',     now() - interval '3 days', now() - interval '3 days', now() - interval '3 days'),
      ('${H}', 'g2', '{aesthetic}', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days');
    INSERT INTO contact_tag_history (contact_id, client_id, tag, first_seen_at, exact)
      SELECT id, client_id, tags[1], ghl_created_at, false FROM contacts WHERE client_id = '${H}';
    INSERT INTO opportunities (client_id, ghl_opportunity_id, ghl_contact_id, current_stage_ghl_id)
      SELECT '${H}', 'o' || substr(ghl_contact_id, 2), ghl_contact_id, 's-new' FROM contacts WHERE client_id = '${H}';
    UPDATE opportunities o SET contact_id = c.id FROM contacts c WHERE c.client_id = o.client_id AND c.ghl_contact_id = o.ghl_contact_id;
    UPDATE clients SET ghl_share_installation_id = '${I}', ghl_share_tags = '{lasik}', ghl_share_gets_untagged = true, ghl_share_version = 1 WHERE id = '${H}';
    UPDATE clients SET ghl_share_installation_id = '${I}', ghl_share_tags = '{aesthetic}' WHERE id = '${M}';
    UPDATE contacts SET share_installation_id = '${I}' WHERE client_id = '${H}';
    UPDATE opportunities SET share_installation_id = '${I}' WHERE client_id = '${H}'
  `);
  await sh.fullSplit(I, { mirror: true });
});

afterAll(async () => {
  await harness?.close();
});

describe("the hourly sweep", () => {
  it("starts from a clean, split share", async () => {
    expect(await countedFor("g1")).toBe(H);
    expect(await countedFor("g2")).toBe(M);
  });

  it("re-copies a person a member's copy lost, and splits it", async () => {
    await many(`
      DELETE FROM stage_transitions WHERE client_id = '${M}';
      DELETE FROM opportunities WHERE client_id = '${M}' AND ghl_contact_id = 'g2';
      DELETE FROM contacts WHERE client_id = '${M}' AND ghl_contact_id = 'g2'
    `);
    expect(await countedFor("g2")).toBe(null); // counted nowhere — never twice
    const r = await sw.sweepShares({ budgetMs: 30_000 });
    expect(r.errors).toBe(0);
    expect(r.repaired).toBeGreaterThan(0);
    expect(await countedFor("g2")).toBe(M);
  });

  it("dates a tag the holder's history never recorded, and moves the lead", async () => {
    await many(`
      INSERT INTO contacts (client_id, ghl_contact_id, tags, ghl_created_at, attribution_fetched_at, share_installation_id, share_counted)
      VALUES ('${H}', 'g3', '{aesthetic}', now() - interval '1 day', now() - interval '1 hour', '${I}', false)
    `);
    const r = await sw.sweepShares({ budgetMs: 30_000 });
    expect(r.gapsFilled + r.repaired).toBeGreaterThan(0);
    expect(await countedFor("g3")).toBe(M);
    const [h] = await one<{ exact: boolean }>(`
      SELECT x.exact FROM contact_tag_history x JOIN contacts c ON c.id = x.contact_id
       WHERE c.client_id = '${H}' AND c.ghl_contact_id = 'g3' AND x.tag = 'aesthetic'`);
    expect(h.exact).toBe(false);
  });

  it("finishes a split the rules changed for", async () => {
    await many(`
      UPDATE clients SET ghl_share_tags = '{aesthetic,lasik}' WHERE id = '${M}';
      UPDATE clients SET ghl_share_tags = '{}', ghl_share_version = ghl_share_version + 1 WHERE id = '${H}'
    `);
    const r = await sw.sweepShares({ budgetMs: 30_000 });
    expect(r.resplit).toBe(1);
    expect(await countedFor("g1")).toBe(M);
    const [v] = await one<{ v: number; s: number }>(
      `SELECT ghl_share_version AS v, ghl_share_split_version AS s FROM clients WHERE id = '${H}'`,
    );
    expect(v.s).toBe(v.v);
  });

  it("clears stamps left on a client that doesn't share", async () => {
    await many(`
      INSERT INTO contacts (client_id, ghl_contact_id, share_installation_id, share_counted)
      VALUES ('${LONER}', 'z1', '${LONER_I}', false)
    `);
    const r = await sw.sweepShares({ budgetMs: 30_000 });
    expect(r.reset).toBe(1);
    const [c] = await one<{ sid: string | null; counted: boolean | null }>(
      `SELECT share_installation_id::text AS sid, share_counted AS counted FROM contacts WHERE client_id = '${LONER}'`,
    );
    expect(c).toEqual({ sid: null, counted: null });
  });

  it("does nothing on a second run", async () => {
    const r = await sw.sweepShares({ budgetMs: 30_000 });
    expect(r).toMatchObject({ repaired: 0, gapsFilled: 0, resplit: 0, reset: 0, errors: 0 });
  });
});
