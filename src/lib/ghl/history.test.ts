import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { Client } from "@/db/schema";
import { parseAttribution } from "./attribution";

/**
 * Importing a client's GoHighLevel history, against a real Postgres.
 *
 * 🔴 The boss's report (26 Oct 2026): "past data from GHL cannot be imported".
 * The old import recorded only each opportunity's CURRENT stage, so a past
 * lead that had since moved on never counted as a lead in its month; and it
 * stored contacts as bare ids, so no past lead could count as paid. These
 * pin what the dashboard can now show for a past month, through its own
 * funnel query.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

type Remote = Record<string, unknown>;
const remote: { contacts: Remote[][]; opps: Remote[][]; throws: boolean; failOnce: { page: number; err: Error } | null } = {
  contacts: [],
  opps: [],
  throws: false,
  failOnce: null,
};
const asked: { contactsFrom: unknown[]; oppPages: number[] } = { contactsFrom: [], oppPages: [] };

vi.mock("./process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process")>()),
  getGhlClientAsync: async (client: { ghlLocationId: string | null }) =>
    client.ghlLocationId
      ? {
          async getPipelines() {
            return [];
          },
          /** Contact pages; a page's cursor is its index, as GHL's searchAfter stands for a position. */
          async *iterateContacts(_loc: string, { searchAfter }: { searchAfter?: unknown[] } = {}) {
            asked.contactsFrom.push(searchAfter ?? null);
            const from = Array.isArray(searchAfter) ? Number(searchAfter[0]) : 0;
            for (let i = from; i < remote.contacts.length; i++) {
              yield { contacts: remote.contacts[i], next: i + 1 < remote.contacts.length ? [i + 1] : null, total: null };
            }
          },
          /** Opportunity pages; a page's cursor carries its index, as GHL's startAfter stands for a position. */
          async *iterateOpportunityPages(_loc: string, { after }: { after?: { startAfter: number } } = {}) {
            if (remote.throws) throw new Error("GHL 500");
            for (let p = after ? after.startAfter : 1; p <= remote.opps.length; p++) {
              if (remote.failOnce?.page === p) {
                const { err } = remote.failOnce;
                remote.failOnce = null;
                throw err;
              }
              asked.oppPages.push(p);
              const next = p < remote.opps.length ? { startAfter: p + 1, startAfterId: `opp-page-${p + 1}` } : null;
              yield { opportunities: remote.opps[p - 1], next, total: null };
            }
          },
        }
      : null,
}));

let mod: typeof import("./history");
let queries: typeof import("@/lib/metrics/queries");

const PIPE = "pipe-main";
const OTHER = "pipe-reviews";
const S_NEW = "aaaaaaaa-0000-4000-8000-000000000001";
const S_BOOKED = "aaaaaaaa-0000-4000-8000-000000000002";
const S_WON = "aaaaaaaa-0000-4000-8000-000000000003";
const S_REVIEW = "aaaaaaaa-0000-4000-8000-000000000004";
const TZ = "America/Los_Angeles";
const ALL = { mode: "all" as const, tag: "facebook-lead" };
const EITHER = { mode: "either" as const, tag: "facebook-lead" };

const client = (id = CLIENT_A, over: Partial<Client> = {}): Client =>
  ({ id, slug: id === CLIENT_A ? "acme" : "other", timezone: TZ, ghlLocationId: `loc-${id.slice(0, 4)}`, ghlAuthMethod: "oauth", ...over }) as Client;

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as { rows: Record<string, unknown>[] };
}
const ledger = async () =>
  (await run(`SELECT to_canonical, changed_at, dedupe_key FROM stage_transitions ORDER BY changed_at, dedupe_key`)).rows.map(
    (r) => [r.to_canonical, new Date(r.changed_at as string).toISOString().slice(0, 10), String(r.dedupe_key).includes(":intake:") ? "intake" : "snapshot"],
  );
const leadsIn = async (month: string, filter: import("@/lib/metrics/queries").PaidLeadFilter = ALL, id = CLIENT_A) => {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (await queries.getFunnelCounts(id, windowFromKeys(`${month}-01`, `${month}-${last}`, TZ), undefined, filter, "meta"));
};
/** Run the whole import, the way the setup page does: a request at a time, carrying the cursor. */
async function importAll(c = client(), budgetMs = 60_000) {
  let cursor: import("./history").HistoryCursor | null = null;
  for (let i = 0; i < 20; i++) {
    const res = await mod.importGhlHistory(c, { cursor, budgetMs });
    if (res.done) return res;
    cursor = mod.decodeHistoryCursor(res.cursor!);
  }
  throw new Error("did not finish");
}

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./history");
  queries = await import("@/lib/metrics/queries");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(`TRUNCATE stage_transitions, opportunities, pipeline_stages, contacts, sync_runs, clients RESTART IDENTITY CASCADE`);
  remote.contacts = [];
  remote.opps = [];
  remote.throws = false;
  remote.failOnce = null;
  asked.contactsFrom = [];
  asked.oppPages = [];
  for (const [id, slug] of [
    [CLIENT_A, "acme"],
    [CLIENT_B, "other"],
  ] as const) {
    await run(`INSERT INTO clients (id, name, slug) VALUES ('${id}', '${slug}', '${slug}')`);
    for (const [pipe, name, stage, canonical, order] of [
      [PIPE, "Leads", S_NEW, "new_lead", 0],
      [PIPE, "Leads", S_BOOKED, "appointment_booked", 1],
      [PIPE, "Leads", S_WON, "closed_won", 2],
      [OTHER, "Reviews", S_REVIEW, "contacted", 0],
    ] as const) {
      await run(
        `INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_pipeline_name, ghl_stage_id, canonical_stage, display_order)
         VALUES ('${id}', '${pipe}', '${name}', '${stage}', '${canonical}', ${order})`,
      );
    }
  }
});

const opp = (id: string, over: Remote = {}): Remote => ({
  id,
  contactId: `c-${id}`,
  pipelineId: PIPE,
  pipelineStageId: S_NEW,
  createdAt: "2026-03-10T15:00:00Z",
  lastStageChangeAt: "2026-03-10T15:00:00Z",
  status: "open",
  ...over,
});

describe("past leads", () => {
  it("🔴 count in the month they came in, not the month they last moved", async () => {
    // Came in 10 March, won 5 May: the old import counted only a May win.
    remote.opps = [[opp("o1", { pipelineStageId: S_WON, lastStageChangeAt: "2026-05-05T15:00:00Z" })]];
    const res = await importAll();

    expect(res.totals).toMatchObject({ opportunities: 1, leads: 1, transitions: 2 });
    expect(await ledger()).toEqual([
      ["new_lead", "2026-03-10", "intake"],
      ["closed_won", "2026-05-05", "snapshot"],
    ]);
    expect((await leadsIn("2026-03")).new_lead).toBe(1);
    expect((await leadsIn("2026-05")).closed_won).toBe(1);
    expect((await leadsIn("2026-05")).new_lead).toBe(0);
  });

  it("🔴 count once, even when still sitting in New lead", async () => {
    remote.opps = [[opp("o1", { lastStageChangeAt: "2026-04-02T15:00:00Z" })]];
    await importAll();
    // One New lead row — a second, at the last move, would count it in April too.
    expect(await ledger()).toEqual([["new_lead", "2026-03-10", "intake"]]);
    expect((await leadsIn("2026-04")).new_lead).toBe(0);
  });

  it("are not counted again on a second import", async () => {
    remote.opps = [[opp("o1", { pipelineStageId: S_BOOKED, lastStageChangeAt: "2026-04-02T15:00:00Z" })]];
    await importAll();
    const second = await importAll();
    expect(second.totals.transitions).toBe(0);
    expect(await ledger()).toHaveLength(2);
  });

  it("🔴 are not doubled when the webhook saw them arrive", async () => {
    // Created 10 March, and the live path recorded its first stage minutes later.
    await importAll(); // nothing yet: creates nothing
    remote.opps = [[opp("o1", { pipelineStageId: S_BOOKED, lastStageChangeAt: "2026-04-02T15:00:00Z" })]];
    await run(`INSERT INTO opportunities (client_id, ghl_opportunity_id) VALUES ('${CLIENT_A}', 'o1')`);
    await run(
      `INSERT INTO stage_transitions (client_id, opportunity_id, to_stage_ghl_id, to_canonical, changed_at, source, dedupe_key, created_at)
       SELECT '${CLIENT_A}', id, '${S_BOOKED}', 'appointment_booked', '2026-03-10T15:05:00Z', 'webhook', 'w1', '2026-03-10T15:05:01Z' FROM opportunities`,
    );
    await importAll();
    expect((await ledger()).filter(([, , kind]) => kind === "intake")).toEqual([]);
  });

  it("🔴 still count when the webhook first saw them months later", async () => {
    /*
     * The live path dates a row by GHL's last stage change, not by when it saw
     * it: first seen in October, a lead that came in on 10 March and moved on
     * the 11th gets a row dated 11 March. Read as "seen at creation", that row
     * cost the lead its intake. What the webhook saw, and when, is the row's
     * `created_at`.
     */
    await run(`INSERT INTO opportunities (client_id, ghl_opportunity_id) VALUES ('${CLIENT_A}', 'o1')`);
    await run(
      `INSERT INTO stage_transitions (client_id, opportunity_id, to_stage_ghl_id, to_canonical, changed_at, source, dedupe_key, created_at)
       SELECT '${CLIENT_A}', id, '${S_BOOKED}', 'appointment_booked', '2026-03-11T09:00:00Z', 'webhook', 'w1', '2026-10-05T12:00:00Z' FROM opportunities`,
    );
    remote.opps = [[opp("o1", { pipelineStageId: S_BOOKED, lastStageChangeAt: "2026-03-11T09:00:00Z" })]];
    await importAll();
    expect(await ledger()).toEqual([
      ["new_lead", "2026-03-10", "intake"],
      ["appointment_booked", "2026-03-11", "snapshot"],
    ]);
    expect((await leadsIn("2026-03")).new_lead).toBe(1);
  });

  it("🔴 are recorded for an opportunity whose row was saved without them", async () => {
    // The old import, killed by the time limit between the two writes, left rows like this.
    await run(
      `INSERT INTO opportunities (client_id, ghl_opportunity_id, current_stage_ghl_id, last_stage_change_at)
       VALUES ('${CLIENT_A}', 'o1', '${S_BOOKED}', '2026-04-02T15:00:00Z')`,
    );
    remote.opps = [[opp("o1", { pipelineStageId: S_BOOKED, lastStageChangeAt: "2026-04-02T15:00:00Z" })]];
    await importAll();
    expect(await ledger()).toEqual([
      ["new_lead", "2026-03-10", "intake"],
      ["appointment_booked", "2026-04-02", "snapshot"],
    ]);
  });

  it("are not given a second arrival at a move the ledger already holds", async () => {
    await run(
      `INSERT INTO opportunities (client_id, ghl_opportunity_id, current_stage_ghl_id, last_stage_change_at)
       VALUES ('${CLIENT_A}', 'o1', '${S_BOOKED}', '2026-04-02T15:00:00Z')`,
    );
    await run(
      `INSERT INTO stage_transitions (client_id, opportunity_id, to_stage_ghl_id, to_canonical, changed_at, source, dedupe_key)
       SELECT '${CLIENT_A}', id, '${S_BOOKED}', 'appointment_booked', '2026-04-02T15:00:00Z', 'webhook', 'w1' FROM opportunities`,
    );
    remote.opps = [[opp("o1", { pipelineStageId: S_BOOKED, lastStageChangeAt: "2026-04-02T15:00:00Z" })]];
    await importAll();
    expect((await ledger()).filter(([c]) => c === "appointment_booked")).toHaveLength(1);
  });

  it("are not doubled where a New lead row exists already", async () => {
    await run(`INSERT INTO opportunities (client_id, ghl_opportunity_id) VALUES ('${CLIENT_A}', 'o1')`);
    await run(
      `INSERT INTO stage_transitions (client_id, opportunity_id, to_stage_ghl_id, to_canonical, changed_at, source, dedupe_key)
       SELECT '${CLIENT_A}', id, '${S_NEW}', 'new_lead', '2026-03-11T09:00:00Z', 'backfill_snapshot', 'old' FROM opportunities`,
    );
    remote.opps = [[opp("o1", { pipelineStageId: S_BOOKED, lastStageChangeAt: "2026-04-02T15:00:00Z" })]];
    await importAll();
    expect((await ledger()).filter(([c]) => c === "new_lead")).toHaveLength(1);
  });

  it("🔴 count only in a pipeline that has a stage mapped to New lead — as live leads do — and the import says why", async () => {
    remote.opps = [[opp("o1", { pipelineId: OTHER, pipelineStageId: S_REVIEW })]];
    const res = await importAll();
    expect(await ledger()).toEqual([["contacted", "2026-03-10", "snapshot"]]);
    expect(res.notes.join(" ")).toMatch(
      /“Reviews” \(1\) has no stage mapped to New lead, so its opportunities count in their stages but not as leads\. If new leads arrive in it, map the stage they arrive in to New lead, then import again\./,
    );
  });

  it("stay in their own client's ledger", async () => {
    remote.opps = [[opp("o1")]];
    await importAll(client(CLIENT_B));
    expect((await leadsIn("2026-03", ALL, CLIENT_B)).new_lead).toBe(1);
    expect((await leadsIn("2026-03", ALL, CLIENT_A)).new_lead).toBe(0);
  });
});

describe("past contacts", () => {
  const fbContact = {
    id: "c-o1",
    firstName: "Dana",
    dateAdded: "2026-03-10T14:58:00Z",
    tags: ["Facebook-Lead", " Botox "],
    source: "Facebook Lead Form",
    attributionSource: {
      url: "https://clinic.example/offer?utm_source=facebook&utm_id=120200000000000001&utm_medium=paid",
      utmSource: "facebook",
      sessionSource: "Paid Social",
    },
    lastAttributionSource: { utmSource: "google", sessionSource: "Organic Search" },
  };

  it("🔴 arrive with their date, tags and attribution, parsed as the live path parses them", async () => {
    remote.contacts = [[fbContact]];
    await importAll();
    const [row] = (
      await run(`SELECT ghl_created_at, tags, meta_campaign_id, utm_source, source, first_name, raw_attribution FROM contacts`)
    ).rows;
    expect(new Date(row.ghl_created_at as string).toISOString()).toBe("2026-03-10T14:58:00.000Z");
    expect(row.tags).toEqual(["facebook-lead", "botox"]);
    // The live path's own parser decides; the import adds no rules of its own.
    expect(row.meta_campaign_id).toBe(parseAttribution(fbContact).metaCampaignId);
    expect(row.meta_campaign_id).toBe("120200000000000001");
    expect(row).toMatchObject({ utm_source: "facebook", source: "Facebook Lead Form", first_name: "Dana" });
    expect(row.raw_attribution).toMatchObject({ attributionSource: { utmSource: "facebook" } });
  });

  it("🔴 make a past lead count as paid under the client's lead filter", async () => {
    remote.contacts = [[fbContact]];
    remote.opps = [[opp("o1")]];
    await importAll();
    expect((await leadsIn("2026-03", EITHER)).new_lead).toBe(1);
  });

  it("never blank what the live path captured", async () => {
    await run(
      `INSERT INTO contacts (client_id, ghl_contact_id, first_name, meta_campaign_id, tags)
       VALUES ('${CLIENT_A}', 'c-o1', 'Dana', '120200000000000009', ARRAY['old'])`,
    );
    remote.contacts = [[{ id: "c-o1", dateAdded: "2026-03-10T14:58:00Z", tags: ["New"] }]];
    await importAll();
    const [row] = (await run(`SELECT first_name, meta_campaign_id, tags, ghl_created_at FROM contacts`)).rows;
    expect(row).toMatchObject({ first_name: "Dana", meta_campaign_id: "120200000000000009", tags: ["new"] });
    expect(row.ghl_created_at).not.toBeNull();
  });

  it("names a sub-account that keeps its leads as contacts only", async () => {
    remote.contacts = [[fbContact, { ...fbContact, id: "c2" }]];
    const res = await importAll();
    expect(res.totals.contacts).toBe(2);
    expect(res.notes[0]).toMatch(/holds 2 contacts for this sub-account but no pipeline opportunities/);
  });
});

describe("a large location", () => {
  it("🔴 stops between pages before its time limit and carries on from where it stopped", async () => {
    remote.contacts = [[{ id: "c1", dateAdded: "2026-03-01T00:00:00Z" }], [{ id: "c2", dateAdded: "2026-03-02T00:00:00Z" }]];
    remote.opps = [[opp("o1")], [opp("o2", { createdAt: "2026-04-10T15:00:00Z", lastStageChangeAt: "2026-04-10T15:00:00Z" })]];

    // A budget already spent: every request does one page, then hands back a cursor.
    const steps: string[] = [];
    let cursor: import("./history").HistoryCursor | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await mod.importGhlHistory(client(), { cursor, budgetMs: -1 });
      steps.push(res.phase);
      if (res.done) {
        expect(res.totals).toMatchObject({ contacts: 2, opportunities: 2, leads: 2 });
        break;
      }
      cursor = mod.decodeHistoryCursor(res.cursor!);
    }
    // Contacts page 1 → pause; contacts page 2 and opportunities page 1 → pause; page 2, which
    // GHL says is the last, finishes in the same request.
    expect(steps).toEqual(["contacts", "opportunities", "done"]);
    // Each page fetched once: resumed, never restarted.
    expect(asked.contactsFrom).toEqual([null, [1]]);
    expect(asked.oppPages).toEqual([1, 2]);
    expect((await leadsIn("2026-04")).new_lead).toBe(1);
  });

  it("🔴 marks an import the time limit cut off as failed, instead of running for ever", async () => {
    await run(
      `INSERT INTO sync_runs (client_id, kind, status, started_at) VALUES ('${CLIENT_A}', 'ghl_backfill', 'running', now() - interval '1 hour')`,
    );
    await importAll();
    const runs = (await run(`SELECT status, error FROM sync_runs ORDER BY started_at`)).rows;
    expect(runs[0]).toMatchObject({ status: "failed" });
    expect(String(runs[0].error)).toMatch(/ran out of time/);
    expect(runs.at(-1)).toMatchObject({ status: "success" });
  });

  it("records a failure on its run rather than swallowing it", async () => {
    remote.throws = true;
    await expect(importAll()).rejects.toThrow("GHL 500");
    const [r] = (await run(`SELECT status, error FROM sync_runs`)).rows;
    expect(r).toMatchObject({ status: "failed", error: "GHL 500" });
  });

  it("says plainly when the client isn't connected", async () => {
    await expect(mod.importGhlHistory(client(CLIENT_A, { ghlLocationId: null }))).rejects.toThrow(
      /isn't connected for this client yet/,
    );
  });
});

describe("a GoHighLevel hiccup", () => {
  it("🔴 after a page is written, pauses there instead of failing — and the next request carries on", async () => {
    const { GhlApiError } = await import("./client");
    remote.opps = [[opp("o1")], [opp("o2", { createdAt: "2026-04-10T15:00:00Z", lastStageChangeAt: "2026-04-10T15:00:00Z" })]];
    remote.failOnce = { page: 2, err: new GhlApiError("GHL 503 on /opportunities/search: busy", 503) };

    const first = await mod.importGhlHistory(client(), { budgetMs: 60_000 });
    expect(first).toMatchObject({ done: false, phase: "opportunities", totals: { opportunities: 1 } });
    const second = await mod.importGhlHistory(client(), { cursor: mod.decodeHistoryCursor(first.cursor!), budgetMs: 60_000 });
    expect(second).toMatchObject({ done: true, totals: { opportunities: 2, leads: 2 } });
    // Page 1 once, page 2 once it answered: nothing fetched twice, nothing lost.
    expect(asked.oppPages).toEqual([1, 2]);
    expect((await run(`SELECT status FROM sync_runs ORDER BY started_at`)).rows.map((r) => r.status)).toEqual(["success", "success"]);
  });

  it("before anything is written, fails as it says — a pause would only repeat the same request", async () => {
    const { GhlApiError } = await import("./client");
    remote.opps = [[opp("o1")]];
    remote.failOnce = { page: 1, err: new GhlApiError("GHL 503 on /opportunities/search: busy", 503) };
    await expect(mod.importGhlHistory(client(), { budgetMs: 60_000 })).rejects.toThrow(/503/);
  });

  it("is never mistaken for one when it is a 401", async () => {
    const { GhlApiError } = await import("./client");
    remote.contacts = [[{ id: "c1", dateAdded: "2026-03-01T00:00:00Z" }]];
    remote.opps = [[opp("o1")]];
    remote.failOnce = { page: 1, err: new GhlApiError("GHL 401 on /opportunities/search: Invalid JWT", 401) };
    await expect(mod.importGhlHistory(client(), { budgetMs: 60_000 })).rejects.toThrow(/401/);
  });
});

describe("a page the database refuses", () => {
  it("🔴 is written whole or not at all, and the run never stores the database's own words", async () => {
    remote.contacts = [[{ id: "c-o1", firstName: "Dana", email: "dana@example.com", dateAdded: "2026-03-10T14:58:00Z" }]];
    remote.opps = [[opp("o1", { pipelineStageId: S_BOOKED, lastStageChangeAt: "2026-04-02T15:00:00Z", name: "Dana — LASIK" })]];
    await run(`CREATE FUNCTION refuse_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger offline'; END $$`);
    await run(`CREATE TRIGGER refuse_ledger BEFORE INSERT ON stage_transitions FOR EACH ROW EXECUTE FUNCTION refuse_ledger()`);
    try {
      const err = (await mod.importGhlHistory(client(), { budgetMs: 60_000 }).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/^Couldn't save a page of the import \(database code P0001\)\. Import again/);
      // A plain message of ours — nothing the route would pass through with SQL or customer data in it.
      expect(Object.keys(err)).not.toContain("query");
      const [r] = (await run(`SELECT status, error FROM sync_runs`)).rows;
      expect(r.status).toBe("failed");
      for (const leak of ["insert", "params", "Dana", "dana@example.com", "LASIK"]) expect(String(r.error)).not.toContain(leak);
      // The opportunity's new state went back with the ledger rows that failed.
      expect((await run(`SELECT count(*)::int AS n FROM opportunities`)).rows[0].n).toBe(0);
    } finally {
      await run(`DROP TRIGGER refuse_ledger ON stage_transitions`);
      await run(`DROP FUNCTION refuse_ledger()`);
    }
    await importAll();
    expect(await ledger()).toEqual([
      ["new_lead", "2026-03-10", "intake"],
      ["appointment_booked", "2026-04-02", "snapshot"],
    ]);
  });

  it("🔴 takes text Postgres can't store once it is cleaned — NUL characters, half an emoji, a trillion-dollar deal", async () => {
    remote.contacts = [
      [
        {
          id: "c-o1",
          firstName: "Da\u0000na",
          dateAdded: "2026-03-10T14:58:00Z",
          tags: ["vip\u0000"],
          attributionSource: { utmSource: "face\uD83Dbook", "ke\u0000y": "v" },
        },
      ],
    ];
    remote.opps = [[opp("o1", { name: "Big\u0000 deal", monetaryValue: 1e13 })]];
    const res = await importAll();
    expect(res.totals).toMatchObject({ contacts: 1, opportunities: 1, leads: 1, skipped: 0 });
    const [c] = (await run(`SELECT first_name, tags, raw_attribution FROM contacts`)).rows;
    expect(c.first_name).toBe("Dana");
    expect(c.tags).toEqual(["vip"]);
    expect(c.raw_attribution).toEqual({ attributionSource: { utmSource: "face�book", key: "v" }, lastAttributionSource: null });
    const [o] = (await run(`SELECT name, monetary_value FROM opportunities`)).rows;
    expect(o).toEqual({ name: "Big deal", monetary_value: null });
  });

  it("🔴 leaves out only the contact it still refuses, and says so", async () => {
    await run(`ALTER TABLE contacts ADD CONSTRAINT refuse_one CHECK (email IS DISTINCT FROM 'refuse@example.com')`);
    try {
      remote.contacts = [
        [
          { id: "c1", email: "a@example.com", dateAdded: "2026-03-01T00:00:00Z" },
          { id: "c2", email: "refuse@example.com", dateAdded: "2026-03-02T00:00:00Z" },
          { id: "c3", email: "c@example.com", dateAdded: "2026-03-03T00:00:00Z" },
        ],
      ];
      const res = await importAll();
      expect(res.totals).toMatchObject({ contacts: 2, skipped: 1 });
      expect((await run(`SELECT ghl_contact_id FROM contacts ORDER BY 1`)).rows.map((r) => r.ghl_contact_id)).toEqual(["c1", "c3"]);
      expect(res.notes[0]).toMatch(/^1 record couldn't be saved .* and was left out\.$/);
    } finally {
      await run(`ALTER TABLE contacts DROP CONSTRAINT refuse_one`);
    }
  });

  it("🔴 leaves out only the opportunity it still refuses — the rest of its page lands, ledger and all", async () => {
    await run(`ALTER TABLE opportunities ADD CONSTRAINT refuse_one CHECK (name IS DISTINCT FROM 'refuse me')`);
    try {
      remote.opps = [[opp("o1", { name: "refuse me" }), opp("o2", { pipelineStageId: S_WON, lastStageChangeAt: "2026-05-05T15:00:00Z" })]];
      const res = await importAll();
      expect(res.totals).toMatchObject({ opportunities: 1, leads: 1, transitions: 2, skipped: 1 });
      expect((await run(`SELECT ghl_opportunity_id FROM opportunities`)).rows.map((r) => r.ghl_opportunity_id)).toEqual(["o2"]);
      expect(await ledger()).toEqual([
        ["new_lead", "2026-03-10", "intake"],
        ["closed_won", "2026-05-05", "snapshot"],
      ]);
    } finally {
      await run(`ALTER TABLE opportunities DROP CONSTRAINT refuse_one`);
    }
  });
});

describe("what the import says when it is done", () => {
  const S_HOLD = "aaaaaaaa-0000-4000-8000-000000000005";
  const S_NURTURE = "aaaaaaaa-0000-4000-8000-000000000006";

  it("🔴 names each reason past opportunities still won't show — and never says to remap a mapped stage", async () => {
    await run(
      `INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_pipeline_name, ghl_stage_id, canonical_stage, display_order) VALUES
         ('${CLIENT_A}', '${PIPE}', 'Leads', '${S_HOLD}', NULL, 3),
         ('${CLIENT_A}', 'pipe-nurture', 'Nurture', '${S_NURTURE}', NULL, 0)`,
    );
    remote.opps = [
      [
        opp("o1"),
        opp("o2", { pipelineStageId: S_HOLD }),
        opp("o3", { pipelineId: OTHER, pipelineStageId: S_REVIEW }),
        opp("o4", { pipelineId: "pipe-nurture", pipelineStageId: S_NURTURE }),
        opp("o5", { pipelineId: "pipe-nurture", pipelineStageId: S_NURTURE }),
      ],
    ];
    const res = await importAll();
    expect(res.notes).toEqual([
      "“Reviews” (1) has no stage mapped to New lead, so its opportunities count in their stages but not as leads. If new leads arrive in it, map the stage they arrive in to New lead, then import again.",
      "“Nurture” (2) has no stages mapped, so its opportunities aren't on the dashboard. Map its stages under Map pipeline stages if it should be, then import again.",
      "1 opportunity sits in a stage that isn't mapped yet, so the stage it is in now doesn't count. Map it under Map pipeline stages — no need to import again.",
    ]);
    // Leads came in for both opportunities in the pipeline with a New lead stage.
    expect(res.totals.leads).toBe(2);
  });

  it("says so when no stage anywhere is mapped to New lead", async () => {
    await run(`UPDATE pipeline_stages SET canonical_stage = 'contacted' WHERE ghl_stage_id = '${S_NEW}'`);
    remote.opps = [[opp("o1"), opp("o2", { pipelineStageId: S_BOOKED })]];
    const res = await importAll();
    expect(res.totals.leads).toBe(0);
    expect(res.notes).toEqual([
      "No stage is mapped to New lead, so none of the 2 imported opportunities count as leads. Under Map pipeline stages, map the stage new leads arrive in to New lead, then import again.",
    ]);
  });

  it("says so when nothing is mapped at all", async () => {
    await run(`UPDATE pipeline_stages SET canonical_stage = NULL`);
    remote.opps = [[opp("o1")]];
    const res = await importAll();
    expect(res.notes).toEqual([
      "No pipeline stages are mapped yet, so the imported opportunity isn't on the dashboard. Map them under Map pipeline stages — the stage new leads arrive in as New lead — then import again.",
    ]);
  });
});

describe("past leads, after a stage is remapped", () => {
  const S_FRESH = "aaaaaaaa-0000-4000-8000-000000000007";
  const remap = async (stage: string, canonical: string | null) => {
    await run(
      `UPDATE pipeline_stages SET canonical_stage = ${canonical ? `'${canonical}'` : "NULL"} WHERE client_id = '${CLIENT_A}' AND ghl_stage_id = '${stage}'`,
    );
    const { reclassifyTransitions } = await import("./backfill");
    await reclassifyTransitions(CLIENT_A);
  };

  it("🔴 move with the pipeline's New lead stage — never relabelled as whatever their old stage became", async () => {
    await run(
      `INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_pipeline_name, ghl_stage_id, canonical_stage, display_order)
       VALUES ('${CLIENT_A}', '${PIPE}', 'Leads', '${S_FRESH}', NULL, 3)`,
    );
    remote.opps = [[opp("o1", { pipelineStageId: S_BOOKED, lastStageChangeAt: "2026-04-02T15:00:00Z" }), opp("o2")]];
    await importAll();
    expect((await leadsIn("2026-03")).new_lead).toBe(2);

    // The operator decides "New lead" is really where they're contacted, and leads arrive in a stage they hadn't mapped.
    await run(`UPDATE pipeline_stages SET canonical_stage = 'new_lead' WHERE ghl_stage_id = '${S_FRESH}'`);
    await remap(S_NEW, "contacted");
    expect((await leadsIn("2026-03")).new_lead).toBe(2);
    expect((await leadsIn("2026-03")).contacted).toBe(0);
    const filed = (await run(`SELECT DISTINCT to_stage_ghl_id FROM stage_transitions WHERE dedupe_key LIKE '%:intake:%'`)).rows;
    expect(filed).toEqual([{ to_stage_ghl_id: S_FRESH }]);
  });

  it("🔴 stop counting while their pipeline has no New lead stage, and count again once it has one", async () => {
    remote.opps = [[opp("o1"), opp("o2", { pipelineStageId: S_BOOKED, lastStageChangeAt: "2026-04-02T15:00:00Z" })]];
    await importAll();
    await remap(S_NEW, "contacted");
    expect((await leadsIn("2026-03")).new_lead).toBe(0);
    expect((await leadsIn("2026-03")).contacted).toBe(0);
    // The booked arrival is not an intake, and keeps its own label.
    expect((await leadsIn("2026-04")).appointment_booked).toBe(1);
    await remap(S_NEW, "new_lead");
    expect((await leadsIn("2026-03")).new_lead).toBe(2);
    // A re-import adds nothing beside them.
    expect((await importAll()).totals.transitions).toBe(0);
  });
});

describe("the cursor the browser carries", () => {
  const good = {
    v: 1 as const,
    phase: "opportunities" as const,
    oppAfter: { startAfter: 1761000000000, startAfterId: "aBc123_-" },
    totals: { contacts: 1, opportunities: 2, leads: 1, transitions: 2, skipped: 0 },
  };

  it("round-trips", () => {
    expect(mod.decodeHistoryCursor(mod.encodeHistoryCursor(good))).toEqual(good);
  });

  it("🔴 refuses anything else — it only ever moves where this client's own import resumes", () => {
    for (const bad of [
      "not base64 json",
      Buffer.from(JSON.stringify({ ...good, v: 2 })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...good, client: "other" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...good, page: 3 })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...good, oppAfter: { startAfter: 1, startAfterId: "x\"; DROP" } })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...good, after: [{ $gt: "" }] })).toString("base64url"),
      // Totals stay ordinary numbers: the done message prints them.
      Buffer.from(JSON.stringify({ ...good, totals: { ...good.totals, leads: 2 ** 40 } })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...good, totals: { ...good.totals, contacts: 1.5 } })).toString("base64url"),
      "x".repeat(5000),
    ]) {
      expect(mod.decodeHistoryCursor(bad), bad.slice(0, 40)).toBeNull();
    }
  });
});
