import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { PaidLeadFilter } from "@/lib/metrics/queries";

/**
 * The shared sub-account engine against real Postgres: the mirror copies the
 * holder's rows to a member with every id remapped, the split gives each person
 * to exactly one client by the users' tags, and the dashboard's own funnel
 * query then counts each lead once — the members' numbers add up to what the
 * holder counted alone.
 *
 * Aloha-shaped: Aloha LASER Vision holds the sub-account and takes untagged
 * leads ('lasik' is its tag); Aloha Laser Aesthetic's tag is 'aesthetic'.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let sh: typeof import("./share");
let q: typeof import("@/lib/metrics/queries");

const H = CLIENT_A; // Aloha LASER Vision — holds the connection
const M = CLIENT_B; // Aloha Laser Aesthetic
const I = "f1000000-0000-0000-0000-000000000001";
const AGENCY = "ae000000-0000-0000-0000-000000000001";
const SEP = windowFromKeys("2026-09-01", "2026-09-30", "UTC");
const ALL: PaidLeadFilter = { mode: "all", tag: "" };

const HC = (n: number) => `c0000000-0000-0000-0000-00000000000${n}`;
const HO = (n: number) => `0a000000-0000-0000-0000-00000000000${n}`;
const ST = {
  new: "5e000000-0000-0000-0000-000000000001",
  book: "5e000000-0000-0000-0000-000000000002",
  won: "5e000000-0000-0000-0000-000000000003",
};

const run = (s: string) => harness.db.execute(sql.raw(s));
const many = async (s: string) => {
  for (const stmt of s.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await run(stmt);
};
const one = async <T>(s: string) => ((await run(s)) as unknown as { rows: T[] }).rows;

async function leads(clientId: string): Promise<number> {
  return (await q.getFunnelCounts(clientId, SEP, undefined, ALL)).new_lead;
}

async function counted(): Promise<Record<string, string | null>> {
  const r = await one<{ gid: string; client: string | null }>(`
    SELECT h.ghl_contact_id AS gid,
           (SELECT c.client_id::text FROM contacts c
             WHERE c.share_installation_id = '${I}' AND c.ghl_contact_id = h.ghl_contact_id AND c.share_counted) AS client
      FROM contacts h WHERE h.client_id = '${H}' ORDER BY 1`);
  return Object.fromEntries(r.map((x) => [x.gid, x.client]));
}

beforeAll(async () => {
  harness = await createTestDb();
  sh = await import("./share");
  q = await import("@/lib/metrics/queries");

  await many(`
    INSERT INTO agencies (id, name, slug) VALUES ('${AGENCY}', 'Reflexion Digital', 'reflexion');
    INSERT INTO clients (id, name, slug, timezone, agency_id) VALUES
      ('${H}', 'Aloha LASER Vision', 'aloha-vision', 'UTC', '${AGENCY}'),
      ('${M}', 'Aloha Laser Aesthetic', 'aloha-aesthetic', 'UTC', '${AGENCY}');
    INSERT INTO ghl_installations (id, location_id, access_token_encrypted, refresh_token_encrypted, expires_at, client_id)
    VALUES ('${I}', 'loc-aloha', 'x', 'y', now() + interval '1 day', '${H}');
    UPDATE clients SET ghl_location_id = 'loc-aloha', ghl_auth_method = 'oauth' WHERE id = '${H}';

    INSERT INTO pipeline_stages (id, client_id, ghl_pipeline_id, ghl_stage_id, ghl_stage_name, ghl_pipeline_name, canonical_stage, display_order) VALUES
      ('${ST.new}',  '${H}', 'p1', 's-new',  'New Lead', 'Patients', 'new_lead', 0),
      ('${ST.book}', '${H}', 'p1', 's-book', 'Booked',   'Patients', 'appointment_booked', 1),
      ('${ST.won}',  '${H}', 'p1', 's-won',  'Won',      'Patients', 'closed_won', 2);

    INSERT INTO contacts (id, client_id, ghl_contact_id, first_name, tags, ghl_created_at, attribution_fetched_at) VALUES
      ('${HC(1)}', '${H}', 'g1', 'Ana', '{lasik,meta}',     '2026-09-05T12:00:00Z', '2026-09-05T12:00:00Z'),
      ('${HC(2)}', '${H}', 'g2', 'Ben', '{aesthetic,meta}', '2026-09-06T12:00:00Z', '2026-09-06T12:00:00Z'),
      ('${HC(3)}', '${H}', 'g3', 'Cy',  '{meta}',           '2026-09-07T12:00:00Z', '2026-09-07T12:00:00Z'),
      ('${HC(4)}', '${H}', 'g4', 'Di',  '{}',               '2026-09-08T12:00:00Z', '2026-09-08T12:00:00Z'),
      ('${HC(5)}', '${H}', 'g5', 'Ed',  '{aesthetic,lasik}','2026-09-09T09:00:00Z', '2026-09-09T12:00:00Z');

    INSERT INTO contact_tag_history (contact_id, client_id, tag, first_seen_at, exact) VALUES
      ('${HC(1)}', '${H}', 'lasik',     '2026-09-05T12:00:05Z', true),
      ('${HC(2)}', '${H}', 'aesthetic', '2026-09-06T12:00:05Z', true),
      ('${HC(5)}', '${H}', 'aesthetic', '2026-09-09T10:00:00Z', true),
      ('${HC(5)}', '${H}', 'lasik',     '2026-09-09T11:00:00Z', true);

    INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id, ghl_contact_id, ghl_pipeline_id, current_stage_id, current_stage_ghl_id, status, monetary_value) VALUES
      ('${HO(1)}', '${H}', 'o1', '${HC(1)}', 'g1', 'p1', '${ST.new}',  's-new',  'open', NULL),
      ('${HO(2)}', '${H}', 'o2', '${HC(2)}', 'g2', 'p1', '${ST.book}', 's-book', 'open', NULL),
      ('${HO(3)}', '${H}', 'o3', '${HC(3)}', 'g3', 'p1', '${ST.new}',  's-new',  'open', NULL),
      ('${HO(4)}', '${H}', 'o4', '${HC(4)}', 'g4', 'p1', '${ST.won}',  's-won',  'won',  1000),
      ('${HO(5)}', '${H}', 'o5', '${HC(5)}', 'g5', 'p1', '${ST.new}',  's-new',  'open', NULL),
      ('${HO(6)}', '${H}', 'o6', NULL,       NULL, 'p1', '${ST.new}',  's-new',  'open', NULL);

    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_stage_id, to_stage_ghl_id, to_canonical, changed_at, source, dedupe_key) VALUES
      ('${H}', '${HO(1)}', '${HC(1)}', '${ST.new}',  's-new',  'new_lead',           '2026-09-05T12:00:00Z', 'webhook',           '${HO(1)}:s-new:2026-09-05T12:00:00.000Z'),
      ('${H}', '${HO(2)}', '${HC(2)}', '${ST.new}',  's-new',  'new_lead',           '2026-09-06T12:00:00Z', 'backfill_snapshot', '${HO(2)}:intake:2026-09-06T12:00:00.000Z'),
      ('${H}', '${HO(2)}', '${HC(2)}', '${ST.book}', 's-book', 'appointment_booked', '2026-09-07T12:00:00Z', 'webhook',           '${HO(2)}:s-book:2026-09-07T12:00:00.000Z'),
      ('${H}', '${HO(3)}', '${HC(3)}', '${ST.new}',  's-new',  'new_lead',           '2026-09-07T12:00:00Z', 'webhook',           '${HO(3)}:s-new:2026-09-07T12:00:00.000Z'),
      ('${H}', '${HO(4)}', '${HC(4)}', '${ST.new}',  's-new',  'new_lead',           '2026-09-08T12:00:00Z', 'webhook',           '${HO(4)}:s-new:2026-09-08T12:00:00.000Z'),
      ('${H}', '${HO(4)}', '${HC(4)}', '${ST.won}',  's-won',  'closed_won',         '2026-09-10T12:00:00Z', 'webhook',           '${HO(4)}:s-won:2026-09-10T12:00:00.000Z'),
      ('${H}', '${HO(5)}', '${HC(5)}', '${ST.new}',  's-new',  'new_lead',           '2026-09-09T12:00:00Z', 'webhook',           '${HO(5)}:s-new:2026-09-09T12:00:00.000Z'),
      ('${H}', '${HO(6)}', NULL,       '${ST.new}',  's-new',  'new_lead',           '2026-09-10T12:00:00Z', 'webhook',           '${HO(6)}:s-new:2026-09-10T12:00:00.000Z')
  `);
});

afterAll(async () => {
  await harness?.close();
});

describe("before sharing", () => {
  it("counts every lead on the holder, and NULL flags change nothing", async () => {
    expect(await leads(H)).toBe(6);
    expect(await leads(M)).toBe(0);
  });
});

describe("sharing: mirror and split", () => {
  beforeAll(async () => {
    // What linkClient's binding step leaves behind: both clients in the share,
    // the rules saved, the holder's rows stamped (still counting).
    await many(`
      UPDATE clients SET ghl_share_installation_id = '${I}', ghl_share_since = now(), ghl_share_tags = '{lasik}',
             ghl_share_gets_untagged = true, ghl_share_version = 1 WHERE id = '${H}';
      UPDATE clients SET ghl_share_installation_id = '${I}', ghl_share_since = now(), ghl_share_tags = '{aesthetic}' WHERE id = '${M}';
      UPDATE contacts SET share_installation_id = '${I}' WHERE client_id = '${H}';
      UPDATE opportunities SET share_installation_id = '${I}' WHERE client_id = '${H}'
    `);
    const result = await sh.fullSplit(I, { mirror: true });
    expect(result.complete).toBe(true);
  });

  it("copies every person, card, stage move and tag sighting to the member", async () => {
    const [n] = await one<{ contacts: number; opps: number; moves: number; tags: number; stages: number }>(`
      SELECT (SELECT COUNT(*)::int FROM contacts WHERE client_id = '${M}') AS contacts,
             (SELECT COUNT(*)::int FROM opportunities WHERE client_id = '${M}') AS opps,
             (SELECT COUNT(*)::int FROM stage_transitions WHERE client_id = '${M}') AS moves,
             (SELECT COUNT(*)::int FROM contact_tag_history WHERE client_id = '${M}') AS tags,
             (SELECT COUNT(*)::int FROM pipeline_stages WHERE client_id = '${M}') AS stages`);
    expect(n).toEqual({ contacts: 5, opps: 6, moves: 8, tags: 4, stages: 3 });
  });

  it("remaps every id of a copied stage move to the member's own rows, and re-keys it", async () => {
    const bad = await one<{ id: string }>(`
      SELECT st.id::text AS id FROM stage_transitions st
        JOIN opportunities o ON o.id = st.opportunity_id
        LEFT JOIN contacts c ON c.id = st.contact_id
        LEFT JOIN pipeline_stages s ON s.id = st.to_stage_id
       WHERE st.client_id = '${M}'
         AND (o.client_id <> '${M}' OR (c.id IS NOT NULL AND c.client_id <> '${M}')
              OR s.client_id <> '${M}' OR left(st.dedupe_key, 36) <> o.id::text)`);
    expect(bad).toEqual([]);
    const intake = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM stage_transitions WHERE client_id = '${M}' AND dedupe_key LIKE '%:intake:%'`,
    );
    expect(intake[0].n).toBe(1);
  });

  it("gives each person to exactly one client, by the users' tags", async () => {
    expect(await counted()).toEqual({
      g1: H, // 'lasik'
      g2: M, // 'aesthetic'
      g3: H, // no client's tag → the holder takes untagged leads
      g4: H,
      g5: M, // both tags: 'aesthetic' was seen first
    });
    const reasons = await one<{ gid: string; reason: string }>(
      `SELECT ghl_contact_id AS gid, share_reason AS reason FROM contacts WHERE client_id = '${M}' ORDER BY 1`,
    );
    expect(reasons.map((r) => r.reason)).toEqual(["tag", "tag", "no_tag", "no_tag", "first_tag"]);
  });

  it("🔴 counts each lead once: the clients add up to what the holder counted alone", async () => {
    expect(await leads(H)).toBe(4); // o1, o3, o4 and the card with no contact
    expect(await leads(M)).toBe(2); // o2, o5
    expect((await q.getFunnelCounts(M, SEP, undefined, ALL)).appointment_booked).toBe(1);
    expect((await q.getFunnelCounts(H, SEP, undefined, ALL)).closed_won).toBe(1);
  });

  it("🔴 the database refuses a second counted copy of a person", async () => {
    await expect(
      run(`UPDATE contacts SET share_counted = true WHERE client_id = '${M}' AND ghl_contact_id = 'g1'`),
    ).rejects.toThrow();
  });

  it("running again writes nothing new and changes no number", async () => {
    await sh.fullSplit(I, { mirror: true });
    const [n] = await one<{ moves: number }>(`SELECT COUNT(*)::int AS moves FROM stage_transitions WHERE client_id = '${M}'`);
    expect(n.moves).toBe(8);
    expect(await leads(H)).toBe(4);
    expect(await leads(M)).toBe(2);
  });
});

describe("the live path", () => {
  it("a tag that arrives after the lead moves the lead, history and all, and is an alert", async () => {
    await many(`
      UPDATE contacts SET tags = '{meta,aesthetic}', attribution_fetched_at = '2026-09-07T12:05:00Z'
       WHERE client_id = '${H}' AND ghl_contact_id = 'g3';
      INSERT INTO contact_tag_history (contact_id, client_id, tag, first_seen_at, exact)
      VALUES ('${HC(3)}', '${H}', 'aesthetic', '2026-09-07T12:01:00Z', true)
    `);
    const out = await sh.syncShare(I, { ghlContactIds: ["g3"] });
    expect(out.placed).toEqual([{ clientId: M, ghlContactId: "g3" }]);
    expect((await counted()).g3).toBe(M);
    expect(await leads(H)).toBe(3);
    expect(await leads(M)).toBe(3);
  });

  it("a removed tag keeps the lead with its client while the keep switch is on", async () => {
    await run(`UPDATE contacts SET tags = '{meta}' WHERE client_id = '${H}' AND ghl_contact_id = 'g2'`);
    const out = await sh.syncShare(I, { ghlContactIds: ["g2"] });
    expect(out.placed).toEqual([]);
    expect((await counted()).g2).toBe(M);
    const [r] = await one<{ reason: string }>(
      `SELECT share_reason AS reason FROM contacts WHERE client_id = '${M}' AND ghl_contact_id = 'g2'`,
    );
    expect(r.reason).toBe("kept");
  });

  it("with the keep switch off, a removed tag sends the lead to the no-tag client", async () => {
    await run(`UPDATE clients SET ghl_share_keep_removed = false WHERE id = '${H}'`);
    await sh.syncShare(I, { ghlContactIds: ["g2"] });
    expect((await counted()).g2).toBe(H);
    await run(`UPDATE clients SET ghl_share_keep_removed = true WHERE id = '${H}'`);
  });

  it("copies a delivery's event to the member under a derived id, and its markers", async () => {
    const [ev] = await one<{ id: string }>(`
      INSERT INTO webhook_events (client_id, event_type, payload, status, received_at)
      VALUES ('${H}', 'OpportunityStageUpdate', '{"contactId":"g1"}', 'processed', '2026-09-11T10:00:00Z')
      RETURNING id::text AS id`);
    await run(`UPDATE clients SET first_webhook_at = '2026-09-01T00:00:00Z', last_webhook_at = '2026-09-11T10:00:00Z' WHERE id = '${H}'`);
    await sh.syncShare(I, { ghlContactIds: ["g1"], eventId: ev.id });
    await sh.syncShare(I, { ghlContactIds: ["g1"], eventId: ev.id });
    const copies = await one<{ shared: string; copy_of: string }>(`
      SELECT headers->>'__sharedFrom' AS shared, headers->>'__copyOf' AS copy_of
        FROM webhook_events WHERE client_id = '${M}'`);
    expect(copies).toEqual([{ shared: I, copy_of: ev.id }]);
    const [m] = await one<{ last: string }>(`SELECT last_webhook_at::text AS last FROM clients WHERE id = '${M}'`);
    expect(m.last).toContain("2026-09-11");
  });
});

describe("a member counted by tags", () => {
  it("counts only the people the split gives it, even with every contact counting", async () => {
    await run(`UPDATE clients SET crm_mapping_mode = 'tags', tag_lead_every_contact = true WHERE id = '${M}'`);
    await sh.fullSplit(I);
    const mine = Object.values(await counted()).filter((c) => c === M).length;
    expect(await leads(M)).toBe(mine);
    const doubled = await one<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT ghl_opportunity_id FROM opportunities
         WHERE share_installation_id = '${I}' AND share_counted GROUP BY ghl_opportunity_id HAVING COUNT(*) > 1) x`);
    expect(doubled[0].n).toBe(0);
    await run(`UPDATE clients SET crm_mapping_mode = 'pipeline', tag_lead_every_contact = false WHERE id = '${M}'`);
    await sh.fullSplit(I);
  });
});
