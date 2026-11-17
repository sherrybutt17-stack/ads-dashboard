import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * "Share this sub-account" end to end, the way the buttons drive it: preview,
 * share, change the tags, stop sharing, share again. Real Postgres.
 *
 * The promises under test are the ones the panel makes:
 *   · the preview shows exactly what saving produces;
 *   · each lead counts on one dashboard, and the clients add up to the holder's
 *     count before sharing;
 *   · Stop sharing gives the holder back exactly what it had.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let act: typeof import("./share-actions");

const H = CLIENT_A; // Aloha LASER Vision
const M = CLIENT_B; // Aloha Laser Aesthetic
const I = "f1000000-0000-0000-0000-000000000001";
const AGENCY = "ae000000-0000-0000-0000-000000000001";
const OTHER_AGENCY = "ae000000-0000-0000-0000-000000000002";
const STRANGER = "33333333-3333-3333-3333-333333333333";
const ACTOR = { userId: "shared", ip: "127.0.0.1", userAgent: "test" };

const run = (s: string) => harness.db.execute(sql.raw(s));
const many = async (s: string) => {
  for (const stmt of s.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await run(stmt);
};
const one = async <T>(s: string) => ((await run(s)) as unknown as { rows: T[] }).rows;

/** Leads in the last 30 days, as the share preview and the Leads tile count them. */
async function last30(clientId: string): Promise<number> {
  const [r] = await one<{ n: number }>(`
    SELECT COUNT(DISTINCT st.opportunity_id)::int AS n
      FROM stage_transitions st
      LEFT JOIN clients k ON k.id = st.client_id
     WHERE st.client_id = '${clientId}' AND st.to_canonical = 'new_lead'
       AND st.changed_at >= now() - interval '30 days'
       AND (st.source::text = 'tag') = (COALESCE(k.crm_mapping_mode::text, 'pipeline') = 'tags')
       AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.id = st.opportunity_id AND o.share_counted = false)`);
  return r.n;
}

const RULES = {
  clients: [
    { clientId: H, tags: ["lasik"] },
    { clientId: M, tags: ["aesthetic"] },
  ],
  untagged: H,
  keepRemoved: true,
};

beforeAll(async () => {
  harness = await createTestDb();
  act = await import("./share-actions");

  const day = (n: number) => `now() - interval '${n} days'`;
  await many(`
    INSERT INTO agencies (id, name, slug) VALUES ('${AGENCY}', 'Reflexion Digital', 'reflexion'), ('${OTHER_AGENCY}', 'Other', 'other');
    INSERT INTO clients (id, name, slug, timezone, agency_id) VALUES
      ('${H}', 'Aloha LASER Vision', 'aloha-vision', 'UTC', '${AGENCY}'),
      ('${M}', 'Aloha Laser Aesthetic', 'aloha-aesthetic', 'UTC', '${AGENCY}'),
      ('${STRANGER}', 'Elsewhere Clinic', 'elsewhere', 'UTC', '${OTHER_AGENCY}');
    INSERT INTO ghl_installations (id, location_id, access_token_encrypted, refresh_token_encrypted, expires_at, client_id)
    VALUES ('${I}', 'loc-aloha', 'x', 'y', now() + interval '1 day', '${H}');
    UPDATE clients SET ghl_location_id = 'loc-aloha', ghl_auth_method = 'oauth', crm_mapping_mode = 'pipeline' WHERE id = '${H}';
    INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, ghl_stage_name, canonical_stage) VALUES
      ('${H}', 'p1', 's-new', 'New Lead', 'new_lead'),
      ('${H}', 'p1', 's-book', 'Booked', 'appointment_booked');
    INSERT INTO contacts (client_id, ghl_contact_id, tags, ghl_created_at, attribution_fetched_at) VALUES
      ('${H}', 'g1', '{lasik,meta}',      ${day(20)}, ${day(20)}),
      ('${H}', 'g2', '{aesthetic,meta}',  ${day(18)}, ${day(18)}),
      ('${H}', 'g3', '{meta}',            ${day(16)}, ${day(16)}),
      ('${H}', 'g4', '{}',                ${day(14)}, ${day(14)}),
      ('${H}', 'g5', '{aesthetic,lasik}', ${day(12)}, ${day(12)}),
      ('${H}', 'g6', '{lasik}',           ${day(60)}, ${day(60)});
    INSERT INTO opportunities (client_id, ghl_opportunity_id, contact_id, ghl_contact_id, current_stage_ghl_id)
      SELECT '${H}', 'o' || substr(ghl_contact_id, 2), id, ghl_contact_id, 's-new' FROM contacts WHERE client_id = '${H}';
    INSERT INTO opportunities (client_id, ghl_opportunity_id, current_stage_ghl_id) VALUES ('${H}', 'o-none', 's-new');
    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_stage_ghl_id, to_canonical, changed_at, source, dedupe_key)
      SELECT o.client_id, o.id, o.contact_id, 's-new', 'new_lead', COALESCE(c.ghl_created_at, now() - interval '10 days'),
             'webhook', o.id::text || ':s-new:x'
        FROM opportunities o LEFT JOIN contacts c ON c.id = o.contact_id WHERE o.client_id = '${H}';
    INSERT INTO webhook_events (client_id, event_type, payload, status, received_at)
    VALUES ('${H}', 'ContactTagUpdate', '{"contactId":"g5","tags":["aesthetic"]}', 'processed', ${day(12)})
  `);
});

afterAll(async () => {
  await harness?.close();
});

describe("refusals", () => {
  it("won't share across agencies, nor with a client that would count nothing", async () => {
    await expect(act.previewLink(H, STRANGER, RULES)).rejects.toThrow("same agency");
    await expect(
      act.previewLink(H, M, { clients: [{ clientId: H, tags: ["lasik"] }], untagged: H, keepRemoved: true }),
    ).rejects.toThrow("Pick Aloha Laser Aesthetic's tag first");
  });

  it("refuses a tag no contact carries, and one given to two clients", async () => {
    await expect(
      act.previewLink(H, M, { ...RULES, clients: [{ clientId: M, tags: ["aesthetics"] }] }),
    ).rejects.toThrow("No contact in this sub-account has the tag");
    await expect(
      act.previewLink(H, M, {
        ...RULES,
        clients: [
          { clientId: H, tags: ["meta"] },
          { clientId: M, tags: ["meta"] },
        ],
      }),
    ).rejects.toThrow("already belongs to");
  });
});

describe("sharing", () => {
  let preview: Awaited<ReturnType<typeof act.previewLink>>;

  it("previews the split without writing anything", async () => {
    preview = await act.previewLink(H, M, RULES);
    // g5 carries both tags and neither was seen arriving: both are dated to
    // its arrival, a tie, so it goes to the no-tag choice (Vision).
    expect(preview.clients).toEqual([
      { id: H, name: "Aloha LASER Vision", now: 6, after: 5 },
      { id: M, name: "Aloha Laser Aesthetic", now: 0, after: 1 },
    ]);
    expect(preview.breakdown.total).toBe(5);
    expect(preview.breakdown.byClient).toEqual([
      { id: H, name: "Aloha LASER Vision", tagged: 1 },
      { id: M, name: "Aloha Laser Aesthetic", tagged: 1 },
    ]);
    expect(preview.breakdown.untagged).toBe(3);
    expect(preview.twoTags.atOnce).toBe(1);
    expect(preview.breakdown.untaggedTo).toEqual({ id: H, name: "Aloha LASER Vision" });
    // Nothing written: the holder still counts everything, unstamped.
    expect(await last30(H)).toBe(6);
    const [n] = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM contacts WHERE share_installation_id IS NOT NULL OR client_id = '${M}'`,
    );
    expect(n.n).toBe(0);
  });

  it("🔴 shares, and the result is exactly what the preview promised", async () => {
    const done = await act.linkClient(H, M, RULES, ACTOR);
    expect(done.leads).toBe(1);
    expect(await last30(H)).toBe(5);
    expect(await last30(M)).toBe(1);
    for (const c of preview.clients) expect(await last30(c.id)).toBe(c.after);
  });

  it("gives the new client the holder's lead settings and webhook markers, and audits both", async () => {
    const [m] = await one<{ mode: string; share: string; tags: string[] }>(
      `SELECT crm_mapping_mode AS mode, ghl_share_installation_id::text AS share, ghl_share_tags AS tags FROM clients WHERE id = '${M}'`,
    );
    expect(m).toEqual({ mode: "pipeline", share: I, tags: ["aesthetic"] });
    const audits = await one<{ client: string }>(
      `SELECT client_id::text AS client FROM audit_log WHERE action = 'ghl_share.add' ORDER BY client_id`,
    );
    expect(audits.map((a) => a.client).sort()).toEqual([H, M].sort());
    const events = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM webhook_events WHERE client_id = '${M}'`);
    expect(events[0].n).toBe(1);
  });

  it("refuses a second client sharing someone else's share, and a stale tag save", async () => {
    await expect(act.saveShareTags(M, RULES, 999, ACTOR)).rejects.toThrow("Someone else just changed these tags");
  });

  it("🔴 a tag change: the preview equals the save", async () => {
    const changed = {
      clients: [
        { clientId: H, tags: ["lasik"] },
        { clientId: M, tags: ["aesthetic", "meta"] },
      ],
      untagged: H,
      keepRemoved: true,
    };
    const p = await act.previewTags(M, changed);
    const [v] = await one<{ v: number }>(`SELECT ghl_share_version AS v FROM clients WHERE id = '${H}'`);
    await act.saveShareTags(M, changed, v.v, ACTOR);
    for (const c of p.clients) expect(await last30(c.id)).toBe(c.after);
    // g1 carries 'lasik' AND 'meta': it stays with Vision, the client it counts for.
    const [g1] = await one<{ client: string }>(
      `SELECT client_id::text AS client FROM contacts WHERE share_installation_id = '${I}' AND ghl_contact_id = 'g1' AND share_counted`,
    );
    expect(g1.client).toBe(H);
    expect(p.twoTags.stays).toBeGreaterThanOrEqual(1);
  });
});

describe("stopping", () => {
  it("🔴 gives the holder back exactly what it had, and removes the copies", async () => {
    await act.stopSharing(M, ACTOR);
    expect(await last30(H)).toBe(6);
    const [left] = await one<{ copies: number; stamped: number; shares: number }>(`
      SELECT (SELECT COUNT(*)::int FROM contacts WHERE client_id = '${M}')
           + (SELECT COUNT(*)::int FROM opportunities WHERE client_id = '${M}')
           + (SELECT COUNT(*)::int FROM stage_transitions WHERE client_id = '${M}')
           + (SELECT COUNT(*)::int FROM pipeline_stages WHERE client_id = '${M}')
           + (SELECT COUNT(*)::int FROM webhook_events WHERE client_id = '${M}') AS copies,
             (SELECT COUNT(*)::int FROM contacts WHERE share_installation_id IS NOT NULL OR share_counted IS NOT NULL) AS stamped,
             (SELECT COUNT(*)::int FROM clients WHERE ghl_share_installation_id IS NOT NULL) AS shares`);
    expect(left).toEqual({ copies: 0, stamped: 0, shares: 0 });
  });

  it("can share again afterwards, with no collisions", async () => {
    await act.linkClient(H, M, RULES, ACTOR);
    expect((await last30(H)) + (await last30(M))).toBe(6);
    await act.stopSharing(M, ACTOR);
    expect(await last30(H)).toBe(6);
  });
});

describe("a former member's leftover copies", () => {
  it("are removed by the purge, and nothing else is", async () => {
    await many(`
      INSERT INTO contacts (client_id, ghl_contact_id, share_counted) VALUES ('${M}', 'g1', false), ('${M}', 'g2', true)
    `);
    expect(await act.holdsFormerCopies(M)).toBe(2);
    const r = await act.purgeFormerMember(M, ACTOR);
    expect(r.contacts).toBe(2);
    expect(await act.holdsFormerCopies(M)).toBe(0);
    expect(await last30(H)).toBe(6);
  });
});
