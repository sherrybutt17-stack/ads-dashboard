import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { PaidLeadFilter } from "@/lib/metrics/queries";

/**
 * Tags mode end to end, against real Postgres: saving a tag mapping builds a
 * client's funnel from its contacts' tags, every metric reads that funnel
 * instead of the pipeline one, and switching back gives the pipeline numbers
 * back untouched.
 *
 * The client is a Reflexion-style sub-account: six contacts in September,
 * only one of them ever given a pipeline card.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let tf: typeof import("./index");
let pv: typeof import("./preview");
let q: typeof import("@/lib/metrics/queries");

const SEP = windowFromKeys("2026-09-01", "2026-09-30", "UTC");
const EITHER: PaidLeadFilter = { mode: "either", tag: "meta" };
const ALL: PaidLeadFilter = { mode: "all", tag: "" };

const C = {
  c1: "c0000000-0000-0000-0000-000000000001",
  c2: "c0000000-0000-0000-0000-000000000002",
  c3: "c0000000-0000-0000-0000-000000000003",
  c4: "c0000000-0000-0000-0000-000000000004",
  c5: "c0000000-0000-0000-0000-000000000005",
  c6: "c0000000-0000-0000-0000-000000000006",
};
const O1 = "0a000000-0000-0000-0000-000000000001";
const O2 = "0a000000-0000-0000-0000-000000000002";
const AGENCY_ON = "ae000000-0000-0000-0000-000000000001";
const AGENCY_OFF = "ae000000-0000-0000-0000-000000000002";

const MAPPINGS = [
  { tag: "meta", canonicalStage: "new_lead" as const },
  { tag: "booked", canonicalStage: "appointment_booked" as const },
  { tag: "location denied", canonicalStage: "disqualified" as const },
];

const run = (s: string) => harness.db.execute(sql.raw(s));
const one = async <T>(s: string) => ((await run(s)) as unknown as { rows: T[] }).rows;

beforeAll(async () => {
  harness = await createTestDb();
  tf = await import("./index");
  pv = await import("./preview");
  q = await import("@/lib/metrics/queries");

  // One statement per call: a prepared statement takes only one.
  const setup = `
    INSERT INTO agencies (id, name, slug, tag_mapping_enabled) VALUES
      ('${AGENCY_ON}', 'Reflexion Digital', 'reflexion', true),
      ('${AGENCY_OFF}', 'Another agency', 'another', false);
    INSERT INTO clients (id, name, slug, timezone, agency_id, paid_lead_filter, paid_lead_tag)
    VALUES ('${CLIENT_A}', 'IQ test', 'iq-test', 'UTC', '${AGENCY_ON}', 'either', 'meta');

    INSERT INTO contacts (id, client_id, ghl_contact_id, first_name, last_name, tags, meta_campaign_id, ghl_created_at) VALUES
      ('${C.c1}', '${CLIENT_A}', 'g1', 'Ana', 'One',  '{meta}',                    NULL,    '2026-09-05T12:00:00Z'),
      ('${C.c2}', '${CLIENT_A}', 'g2', 'Ben', 'Two',  '{meta,booked}',             NULL,    '2026-09-06T12:00:00Z'),
      ('${C.c3}', '${CLIENT_A}', 'g3', 'Cy',  'Three','{lasik}',                   NULL,    '2026-09-07T12:00:00Z'),
      ('${C.c4}', '${CLIENT_A}', 'g4', 'Di',  'Four', NULL,                        'camp1', '2026-09-08T12:00:00Z'),
      ('${C.c5}', '${CLIENT_A}', 'g5', 'Ed',  'Five', '{meta,"location denied"}',  NULL,    '2026-09-09T12:00:00Z'),
      ('${C.c6}', '${CLIENT_A}', 'g6', 'Flo', 'Six',  '{meta,booked}',             NULL,    '2026-09-10T08:00:00Z');

    -- The one pipeline card: c1 entered New lead; c2 got a card in Appointment Booked.
    INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id, status, monetary_value) VALUES
      ('${O1}', '${CLIENT_A}', 'o1', '${C.c1}', 'won', 3500),
      ('${O2}', '${CLIENT_A}', 'o2', '${C.c2}', 'open', NULL);
    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at, source) VALUES
      ('${CLIENT_A}', '${O1}', '${C.c1}', 'new_lead',           '2026-09-05T12:05:00Z', 'webhook'),
      ('${CLIENT_A}', '${O1}', '${C.c1}', 'closed_won',         '2026-09-25T12:00:00Z', 'webhook'),
      ('${CLIENT_A}', '${O2}', '${C.c2}', 'appointment_booked', '2026-09-15T12:00:00Z', 'webhook');

    -- The webhook log: c6 arrived untagged, got "meta" seconds later and
    -- "booked" two days after; c2's first tag update already had both.
    INSERT INTO webhook_events (client_id, event_type, received_at, payload, status) VALUES
      ('${CLIENT_A}', 'ContactCreate',    '2026-09-10T08:00:01Z', '{"type":"ContactCreate","id":"g6","tags":[]}', 'processed'),
      ('${CLIENT_A}', 'ContactTagUpdate', '2026-09-10T08:00:09Z', '{"type":"ContactTagUpdate","id":"g6","tags":["meta"]}', 'processed'),
      ('${CLIENT_A}', 'ContactTagUpdate', '2026-09-12T14:00:00Z', '{"type":"ContactTagUpdate","id":"g6","tags":["Meta","booked"]}', 'processed'),
      ('${CLIENT_A}', 'ContactTagUpdate', '2026-09-08T00:00:00Z', '{"type":"ContactTagUpdate","id":"g2","tags":["meta","booked"]}', 'processed');
  `;
  for (const statement of setup.split(/;\s*\n/)) {
    if (statement.trim()) await run(statement);
  }
});

afterAll(async () => {
  await harness.close();
});

describe("who is offered the switch", () => {
  it("is every client of an agency that has it, a client given it alone, and nobody else", async () => {
    expect(await tf.tagMappingAllowed({ agencyId: AGENCY_ON, tagMappingAllowed: false, crmMappingMode: "pipeline" })).toBe(true);
    expect(await tf.tagMappingAllowed({ agencyId: AGENCY_OFF, tagMappingAllowed: false, crmMappingMode: "pipeline" })).toBe(false);
    expect(await tf.tagMappingAllowed({ agencyId: AGENCY_OFF, tagMappingAllowed: true, crmMappingMode: "pipeline" })).toBe(true);
  });
});

describe("tags mode", () => {
  it("starts out counting the pipeline, exactly as before", async () => {
    const f = await q.getFunnelCounts(CLIENT_A, SEP, undefined, EITHER);
    expect(f.new_lead).toBe(1);
    expect(f.appointment_booked).toBe(1);
    expect(f.closed_won).toBe(1);
    expect((await q.getRevenue(CLIENT_A, SEP, undefined, EITHER))?.revenue).toBe(3500);
  });

  it("previews the switch before anything is saved", async () => {
    const counts = await pv.previewLeadCounts(
      { id: CLIENT_A, paidLeadFilter: "either", paidLeadTag: "meta", crmMappingMode: "pipeline" },
      { everyContact: false, tags: MAPPINGS.map((m) => m.tag) },
      SEP,
    );
    // c3 carries only "lasik", which is unmapped: not a lead.
    expect(counts).toEqual({ pipeline: 1, tags: 5, current: null });
    // Read-only: the preview's own seeding was rolled back.
    const [h] = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM contact_tag_history`);
    expect(h.n).toBe(0);
  });

  it("counts every tagged contact once switched, and ignores the pipeline", async () => {
    const result = await tf.saveTagMapping(CLIENT_A, { mode: "tags", everyContact: false, mappings: MAPPINGS });
    expect(result?.leads).toBe(5);

    const f = await q.getFunnelCounts(CLIENT_A, SEP, undefined, EITHER);
    expect(f.new_lead).toBe(5); // c1, c2, c5, c6 by tag; c4 from its ad
    expect(f.appointment_booked).toBe(2); // c2 and c6 — not c2's pipeline card again
    expect(f.disqualified).toBe(1); // c5
    expect(f.closed_won).toBe(0); // the pipeline win is not read in tags mode
  });

  it("dates a step from the webhook that first showed its tag", async () => {
    const rows = await one<{ ghl: string; stage: string; at: string }>(`
      SELECT c.ghl_contact_id AS ghl, st.to_canonical::text AS stage, st.changed_at::text AS at
      FROM stage_transitions st JOIN contacts c ON c.id = st.contact_id
      WHERE st.source = 'tag' AND c.ghl_contact_id IN ('g2', 'g6')
      ORDER BY 1, 3
    `);
    expect(rows.map((r) => [r.ghl, r.stage, new Date(r.at).toISOString()])).toEqual([
      // Already there in c2's first update: no telling when — the lead's own day.
      ["g2", "new_lead", "2026-09-06T12:00:00.000Z"],
      ["g2", "appointment_booked", "2026-09-06T12:00:00.000Z"],
      // Seen arriving: dated exactly.
      ["g6", "new_lead", "2026-09-10T08:00:00.000Z"],
      ["g6", "appointment_booked", "2026-09-12T14:00:00.000Z"],
    ]);
  });

  it("lists tag leads in the Leads list, at the step they reached", async () => {
    const leads = await q.getLeads(CLIENT_A, ALL);
    expect(leads).toHaveLength(5);
    const flo = leads.find((l) => l.name === "Flo Six");
    expect(flo).toMatchObject({
      ghlStageName: "Appointment Booked",
      ghlPipelineName: "Tags",
      canonicalStage: "appointment_booked",
    });
    expect(leads.find((l) => l.name === "Ed Five")?.canonicalStage).toBe("disqualified");
  });

  it("reports revenue as unknown, not zero, and tracks only the mapped steps", async () => {
    expect(await q.getRevenue(CLIENT_A, SEP, undefined, EITHER)).toBeNull();
    expect([...(await q.getMappedStages(CLIENT_A))].sort()).toEqual(
      ["appointment_booked", "disqualified", "new_lead"],
    );
  });

  it("adds a step the moment a live tag update brings a mapped tag", async () => {
    await run(`UPDATE contacts SET tags = '{lasik,booked}' WHERE id = '${C.c3}'`);
    await tf.recordContactTags(
      { id: CLIENT_A, agencyId: AGENCY_ON, crmMappingMode: "tags", tagMappingAllowed: false },
      { tags: ["lasik"], attributionFetchedAt: new Date("2026-09-07T12:00:00Z") },
      {
        id: C.c3,
        tags: ["lasik", "booked"],
        ghlCreatedAt: new Date("2026-09-07T12:00:00Z"),
        createdAt: new Date("2026-09-07T12:00:00Z"),
      },
      new Date("2026-09-20T10:00:00Z"),
    );
    const all = await q.getFunnelCounts(CLIENT_A, SEP, undefined, ALL);
    expect(all.new_lead).toBe(6);
    expect(all.appointment_booked).toBe(3);
    // c3 has no "meta" tag and no campaign: a lead, but not a paid one.
    expect((await q.getFunnelCounts(CLIENT_A, SEP, undefined, EITHER)).new_lead).toBe(5);

    const [booked] = await one<{ at: string }>(`
      SELECT changed_at::text AS at FROM stage_transitions
      WHERE source = 'tag' AND contact_id = '${C.c3}' AND to_canonical = 'appointment_booked'
    `);
    expect(new Date(booked.at).toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });

  it("counts every new contact when asked to, keeping the mapping", async () => {
    await run(`INSERT INTO contacts (id, client_id, ghl_contact_id, ghl_created_at)
               VALUES ('c0000000-0000-0000-0000-000000000007', '${CLIENT_A}', 'g7', '2026-09-21T12:00:00Z')`);
    const result = await tf.saveTagMapping(CLIENT_A, { mode: "tags", everyContact: true });
    expect(result?.leads).toBe(7);
    expect(await tf.loadTagMappings(CLIENT_A)).toHaveLength(3);
  });

  it("gives the pipeline numbers back, untouched, when switched back", async () => {
    await tf.saveTagMapping(CLIENT_A, { mode: "pipeline" });
    const f = await q.getFunnelCounts(CLIENT_A, SEP, undefined, EITHER);
    expect(f.new_lead).toBe(1);
    expect(f.appointment_booked).toBe(1);
    expect(f.closed_won).toBe(1);
    expect((await q.getRevenue(CLIENT_A, SEP, undefined, EITHER))?.revenue).toBe(3500);

    const [left] = await one<{ steps: number; opps: number }>(`
      SELECT (SELECT COUNT(*)::int FROM stage_transitions WHERE source = 'tag') AS steps,
             (SELECT COUNT(*)::int FROM opportunities WHERE from_tags) AS opps
    `);
    expect(left).toEqual({ steps: 0, opps: 0 });
    // Kept for next time.
    expect(await tf.loadTagMappings(CLIENT_A)).toHaveLength(3);
    expect((await q.getLeads(CLIENT_A, ALL)).map((l) => l.id).sort()).toEqual([O1, O2]);
  });
});

describe("cleanMappings", () => {
  it("normalises tags, drops blanks and unknown steps, one step per tag", () => {
    expect(
      tf.cleanMappings([
        { tag: " Booked ", canonicalStage: "appointment_booked" },
        { tag: "", canonicalStage: "new_lead" },
        { tag: "x", canonicalStage: "nonsense" },
        { tag: "booked", canonicalStage: "showed" },
      ]),
    ).toEqual([{ tag: "booked", canonicalStage: "showed" }]);
  });
});

describe("dates and the preview, from the webhook log", () => {
  /*
   * A second sub-account whose tag updates started streaming on 10 Sep.
   * h1 arrived on 1 Sep, before that; its ContactCreate was logged with no
   * tags, and its first streamed update already carried "booked" — so when
   * "booked" was added is unknown, and it must land on h1's own day, not be
   * dated to the update. h2 was watched gaining "booked" on 14 Sep. h3's
   * "meta" showed in one update and was removed since: still a lead, in the
   * preview exactly as after saving.
   */
  const B = CLIENT_B;
  const H = {
    h1: "d0000000-0000-0000-0000-000000000001",
    h2: "d0000000-0000-0000-0000-000000000002",
    h3: "d0000000-0000-0000-0000-000000000003",
  };
  const MAP = [
    { tag: "meta", canonicalStage: "new_lead" as const },
    { tag: "booked", canonicalStage: "appointment_booked" as const },
  ];

  beforeAll(async () => {
    const setup = `
      INSERT INTO clients (id, name, slug, timezone, agency_id, paid_lead_filter, paid_lead_tag)
      VALUES ('${B}', 'Second test', 'second-test', 'UTC', '${AGENCY_ON}', 'all', 'meta');
      INSERT INTO contacts (id, client_id, ghl_contact_id, first_name, tags, ghl_created_at) VALUES
        ('${H.h1}', '${B}', 'h1', 'Hal', '{meta,booked}', '2026-09-01T12:00:00Z'),
        ('${H.h2}', '${B}', 'h2', 'Ida', '{meta,booked}', '2026-09-11T12:00:00Z'),
        ('${H.h3}', '${B}', 'h3', 'Jon', '{}',            '2026-09-12T12:00:00Z');
      INSERT INTO webhook_events (client_id, event_type, received_at, payload, status) VALUES
        ('${B}', 'ContactCreate',    '2026-09-01T12:00:05Z', '{"type":"ContactCreate","id":"h1","tags":[]}', 'processed'),
        ('${B}', 'ContactTagUpdate', '2026-09-10T09:00:00Z', '{"type":"ContactTagUpdate","id":"h1","tags":["meta","booked"]}', 'processed'),
        ('${B}', 'ContactCreate',    '2026-09-11T12:00:05Z', '{"type":"ContactCreate","id":"h2","tags":["meta"]}', 'processed'),
        ('${B}', 'ContactTagUpdate', '2026-09-14T16:00:00Z', '{"type":"ContactTagUpdate","id":"h2","tags":["meta","booked"]}', 'processed'),
        ('${B}', 'ContactTagUpdate', '2026-09-12T12:01:00Z', '{"type":"ContactTagUpdate","id":"h3","tags":["meta"]}', 'processed');
    `;
    for (const statement of setup.split(/;\s*\n/)) {
      if (statement.trim()) await run(statement);
    }
  });

  it("previews the same leads the save produces, including a tag since removed", async () => {
    const preview = await pv.previewLeadCounts(
      { id: B, paidLeadFilter: "all", paidLeadTag: "meta", crmMappingMode: "pipeline" },
      { everyContact: false, tags: ["meta", "booked"] },
      SEP,
    );
    expect(preview).toEqual({ pipeline: 0, tags: 3, current: null });
    const saved = await tf.saveTagMapping(B, { mode: "tags", everyContact: false, mappings: MAP });
    expect(saved?.leads).toBe(3);
  });

  it("dates only what it saw arrive, and never from before the updates streamed", async () => {
    const rows = await one<{ ghl: string; at: string }>(`
      SELECT c.ghl_contact_id AS ghl, st.changed_at::text AS at
      FROM stage_transitions st JOIN contacts c ON c.id = st.contact_id
      WHERE st.client_id = '${B}' AND st.source = 'tag' AND st.to_canonical = 'appointment_booked'
      ORDER BY 1
    `);
    expect(rows.map((r) => [r.ghl, new Date(r.at).toISOString()])).toEqual([
      ["h1", "2026-09-01T12:00:00.000Z"], // unknown: the lead's own day
      ["h2", "2026-09-14T16:00:00.000Z"], // seen arriving
    ]);
  });

  it("shows the client's current tag count when an existing mapping is edited", async () => {
    const preview = await pv.previewLeadCounts(
      { id: B, paidLeadFilter: "all", paidLeadTag: "meta", crmMappingMode: "tags" },
      { everyContact: false, tags: ["booked"] },
      SEP,
    );
    // Dropping "meta" loses h3 — and the confirmation can say 3 → 2.
    expect(preview).toEqual({ pipeline: 0, tags: 2, current: 3 });
  });

  it("does nothing for a client that cannot be on tags", async () => {
    await tf.recordContactTags(
      { id: B, agencyId: AGENCY_OFF, crmMappingMode: "pipeline", tagMappingAllowed: false },
      null,
      { id: H.h3, tags: ["meta"], ghlCreatedAt: new Date("2026-09-12T12:00:00Z"), createdAt: new Date() },
    );
    const [n] = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM stage_transitions WHERE client_id = '${B}' AND source = 'tag'`);
    expect(n.n).toBe(5); // unchanged: 3 leads + 2 bookings
  });
});
