import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, type TestDb } from "./__testdb__/harness";
import { eachDateKey, windowFromKeys } from "@/lib/dates";
import { REPORT_TABLE_DEFINITIONS } from "./definitions";
import { STAGE_LABELS } from "@/lib/stages";
import type { PaidLeadFilter } from "./queries";

/**
 * `reached` stage counting — the Reports tab's "this stage or further".
 *
 * The request it answers: a lead moved in GHL straight from New Lead to
 * Appointment Booked never ENTERS Contacted, so the report showed 5 contacted
 * against 33 appointments. Under `reached`, anyone who got at least as far as a
 * stage counts there, once, in the period they FIRST got there.
 *
 * Run against real Postgres (PGlite), because the whole behaviour is SQL:
 * MIN … FILTER over every transition a lead ever had, then bucketing.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let q: typeof import("./queries");

const TZ = "America/Los_Angeles";
/** Every lead counts: the paid-lead filter is not what is under test here. */
const ALL: PaidLeadFilter = { mode: "all", tag: "" };

const CONTACT = "aaaaaaa1-0000-0000-0000-0000000000c1";

/** One opportunity per story; each comment is what it must count as. */
const OPP = {
  contactedOnly: "aaaaaaa2-0000-0000-0000-000000000001",
  skippedContacted: "aaaaaaa2-0000-0000-0000-000000000002",
  wholePath: "aaaaaaa2-0000-0000-0000-000000000003",
  noShow: "aaaaaaa2-0000-0000-0000-000000000004",
  contactedInAugust: "aaaaaaa2-0000-0000-0000-000000000005",
  newOnly: "aaaaaaa2-0000-0000-0000-000000000006",
  lost: "aaaaaaa2-0000-0000-0000-000000000007",
  bounced: "aaaaaaa2-0000-0000-0000-000000000008",
  wonDirect: "aaaaaaa2-0000-0000-0000-000000000009",
} as const;

beforeAll(async () => {
  harness = await createTestDb();
  q = await import("./queries");
  const run = (s: string) => harness.db.execute(sql.raw(s));

  await run(`
    INSERT INTO contacts (id, client_id, ghl_contact_id, meta_campaign_id)
    VALUES ('${CONTACT}', '${CLIENT_A}', 'c1', 'camp_1')
  `);
  await run(`
    INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id) VALUES
    ${Object.values(OPP)
      .map((id, i) => `('${id}', '${CLIENT_A}', 'o${i}', '${CONTACT}')`)
      .join(",\n")}
  `);

  // 18:00Z is 11:00 in Los Angeles — well clear of any day boundary.
  const t = (opp: string, stage: string, day: string) =>
    `('${CLIENT_A}', '${opp}', '${CONTACT}', '${stage}', '${day}T18:00:00Z', 'webhook')`;

  await run(`
    INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at, source) VALUES
    ${[
      t(OPP.contactedOnly, "new_lead", "2026-09-02"),
      t(OPP.contactedOnly, "contacted", "2026-09-03"),

      // Dragged straight to booked: contacted AND booked under `reached`.
      t(OPP.skippedContacted, "new_lead", "2026-09-02"),
      t(OPP.skippedContacted, "appointment_booked", "2026-09-04"),

      t(OPP.wholePath, "new_lead", "2026-09-02"),
      t(OPP.wholePath, "contacted", "2026-09-03"),
      t(OPP.wholePath, "appointment_booked", "2026-09-05"),
      t(OPP.wholePath, "showed", "2026-09-10"),
      t(OPP.wholePath, "closed_won", "2026-09-12"),

      // A no-show was booked (and so contacted) but did not show.
      t(OPP.noShow, "new_lead", "2026-09-02"),
      t(OPP.noShow, "no_show", "2026-09-08"),

      // First contacted in AUGUST: September's appointment, not its contact.
      t(OPP.contactedInAugust, "new_lead", "2026-08-20"),
      t(OPP.contactedInAugust, "contacted", "2026-08-25"),
      t(OPP.contactedInAugust, "appointment_booked", "2026-09-03"),

      t(OPP.newOnly, "new_lead", "2026-09-02"),

      // An exit, not a step: `lost` implies nothing further.
      t(OPP.lost, "new_lead", "2026-09-02"),
      t(OPP.lost, "lost", "2026-09-06"),

      // Contacted → booked → moved BACK to contacted: counted once each.
      t(OPP.bounced, "new_lead", "2026-09-02"),
      t(OPP.bounced, "contacted", "2026-09-03"),
      t(OPP.bounced, "appointment_booked", "2026-09-04"),
      t(OPP.bounced, "contacted", "2026-09-06"),

      // Won on the phone, no stage in between: every step up to won.
      t(OPP.wonDirect, "new_lead", "2026-09-02"),
      t(OPP.wonDirect, "closed_won", "2026-09-09"),
    ].join(",\n")}
  `);
});

afterAll(async () => {
  await harness?.close();
});

const september = () => windowFromKeys("2026-09-01", "2026-09-30", TZ);
const august = () => windowFromKeys("2026-08-01", "2026-08-31", TZ);

describe("getFunnelCounts — entered (the default, used everywhere but Reports)", () => {
  it("is unchanged: only leads entering that exact stage", async () => {
    const f = await q.getFunnelCounts(CLIENT_A, september(), undefined, ALL);
    expect(f.new_lead).toBe(8);
    // contactedOnly, wholePath, bounced — the skipped and August leads are not.
    expect(f.contacted).toBe(3);
    // skippedContacted, wholePath, contactedInAugust, bounced.
    expect(f.appointment_booked).toBe(4);
    expect(f.showed).toBe(1);
    expect(f.no_show).toBe(1);
    expect(f.closed_won).toBe(2);
    expect(f.lost).toBe(1);
  });
});

describe("getFunnelCounts — reached (the Reports tables)", () => {
  it("🔴 counts everyone who got at least as far as each stage", async () => {
    const f = await q.getFunnelCounts(CLIENT_A, september(), undefined, ALL, "meta", "reached");
    // contactedOnly, skippedContacted, wholePath, noShow, bounced, wonDirect.
    // NOT contactedInAugust — first contacted in August.
    expect(f.contacted).toBe(6);
    // skippedContacted, wholePath, noShow, contactedInAugust, bounced, wonDirect.
    expect(f.appointment_booked).toBe(6);
    // wholePath and wonDirect (won implies showed); the no-show does not.
    expect(f.showed).toBe(2);
    expect(f.closed_won).toBe(2);
  });

  it("leaves the lead count and the exits on entered counting", async () => {
    // New leads must stay "leads that arrived" — it is the cost-per-lead
    // divisor — and no-show / lost are exits nothing flows through.
    const f = await q.getFunnelCounts(CLIENT_A, september(), undefined, ALL, "meta", "reached");
    expect(f.new_lead).toBe(8);
    expect(f.no_show).toBe(1);
    expect(f.lost).toBe(1);
  });

  it("🔴 narrows down the funnel, never widens", async () => {
    // The whole point: the broken report read 5 contacted, 33 booked.
    const f = await q.getFunnelCounts(CLIENT_A, september(), undefined, ALL, "meta", "reached");
    expect(f.contacted).toBeGreaterThanOrEqual(f.appointment_booked);
    expect(f.appointment_booked).toBeGreaterThanOrEqual(f.showed);
    expect(f.showed).toBeGreaterThanOrEqual(f.closed_won);
  });

  it("🔴 counts a lead in the period it FIRST got there, and only that one", async () => {
    // contactedInAugust: August's contact, September's appointment.
    const aug = await q.getFunnelCounts(CLIENT_A, august(), undefined, ALL, "meta", "reached");
    expect(aug.contacted).toBe(1);
    expect(aug.appointment_booked).toBe(0);
  });
});

describe("getDailySeries — reached", () => {
  const days = async (counting: "entered" | "reached") => {
    const w = september();
    const rows = await q.getDailySeries(
      CLIENT_A, w, TZ, eachDateKey(w, TZ), undefined, ALL, "meta", counting,
    );
    return new Map(rows.map((r) => [r.dateKey, r.funnel]));
  };

  it("buckets each lead on the day it first reached the stage", async () => {
    const d = await days("reached");
    // Sep 4: skippedContacted is first contacted (via its booking) and booked;
    // bounced is booked. bounced's contact was Sep 3.
    expect(d.get("2026-09-04")?.contacted).toBe(1);
    expect(d.get("2026-09-04")?.appointment_booked).toBe(2);
    expect(d.get("2026-09-03")?.contacted).toBe(3);
  });

  it("🔴 replaces entered counts rather than adding to them", async () => {
    // Sep 6: bounced moved BACK to contacted. It is an entry, but not a first
    // arrival, so the reached table must read 0 — not keep the entered 1.
    expect((await days("entered")).get("2026-09-06")?.contacted).toBe(1);
    expect((await days("reached")).get("2026-09-06")?.contacted).toBe(0);
  });

  it("adds up to the period figure", async () => {
    const d = await days("reached");
    const sum = (k: "contacted" | "appointment_booked" | "showed" | "closed_won") =>
      [...d.values()].reduce((n, f) => n + f[k], 0);
    const period = await q.getFunnelCounts(CLIENT_A, september(), undefined, ALL, "meta", "reached");
    expect(sum("contacted")).toBe(period.contacted);
    expect(sum("appointment_booked")).toBe(period.appointment_booked);
    expect(sum("showed")).toBe(period.showed);
    expect(sum("closed_won")).toBe(period.closed_won);
  });

  it("leaves entered counting untouched by default (the Overview trend)", async () => {
    const d = await days("entered");
    expect(d.get("2026-09-04")?.contacted).toBe(0);
  });
});

describe("wiring", () => {
  const src = (p: string) =>
    readFileSync(join(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("🔴 the Reports tables use reached counting, and loadDashboard does not", () => {
    const s = src("src/lib/metrics/dashboard.ts");
    const deferred = s.slice(s.indexOf("export async function loadDeferredTables"));
    const main = s.slice(
      s.indexOf("export async function loadDashboard"),
      s.indexOf("export async function loadDeferredTables"),
    );
    // Moving averages, both 7-day rows, the 14-day series, month on month.
    expect(deferred.match(/"reached"/g)).toHaveLength(5);
    expect(main).not.toMatch(/"reached"/);
  });

  it("the report column definitions name every stage reached counting includes", () => {
    for (const [stage, via] of Object.entries(q.REACHED_VIA)) {
      const def = REPORT_TABLE_DEFINITIONS[stage];
      expect(def, stage).toBeDefined();
      for (const s of via) {
        if (s === stage) continue;
        expect(def.formula, `${stage} → ${s}`).toContain(
          STAGE_LABELS[s as keyof typeof STAGE_LABELS],
        );
      }
    }
  });
});
