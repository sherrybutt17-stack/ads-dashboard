import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { ChurnWeekWindow } from "./queries";

/**
 * The weekly bucket query, against a real Postgres.
 *
 * One query serves the whole book, so the failure modes are all about rows from
 * one client, one week or one metric table reaching another:
 *
 *   · joining both spend tables on one window row → their day counts multiply
 *   · a window boundary read in UTC              → a lead lands in last week
 *   · ad-level rows summed with campaign rows    → every account's spend doubles
 *   · first-activity taken from ad data only     → a client whose CRM was wired
 *     first reads as newer than it is, and is never judged
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
const FILTER = { mode: "either" as const, tag: "facebook-lead" };

/** Two 7-day buckets, both entirely in the past so no partial period exists. */
const WEEKS: ChurnWeekWindow[] = [
  {
    clientId: CLIENT_A,
    idx: 0,
    window: windowFromKeys("2026-07-06", "2026-07-12", TZ),
    filter: FILTER,
  },
  {
    clientId: CLIENT_A,
    idx: 1,
    window: windowFromKeys("2026-07-13", "2026-07-19", TZ),
    filter: FILTER,
  },
];

beforeAll(async () => {
  harness = await createTestDb();
  q = await import("./queries");
  await seed(harness.db);
});

afterAll(async () => {
  await harness?.close();
});

async function seed(db: TestDb) {
  const run = (s: string) => db.execute(sql.raw(s));

  await run(`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, spend) VALUES
      ('${CLIENT_A}', '2026-07-08', 'campaign', 'camp_1', 100),
      /* Ad-level row for the same day: summed with the above it doubles July. */
      ('${CLIENT_A}', '2026-07-08', 'ad',       'camp_1', 100),
      ('${CLIENT_A}', '2026-07-15', 'campaign', 'camp_1', 300),
      /* Another tenant's spend in the same week. */
      ('${CLIENT_B}', '2026-07-08', 'campaign', 'camp_9', 900)
  `);

  await run(`
    INSERT INTO google_daily_metrics (client_id, date, google_campaign_id, spend) VALUES
      ('${CLIENT_A}', '2026-07-09', 'g1', 50),
      /* Another tenant's Google spend in the same week — the Meta join has its
         own tenancy check and the Google one needs its own test to prove it. */
      ('${CLIENT_B}', '2026-07-09', 'g9', 700)
  `);

  await run(`
    INSERT INTO contacts (id, client_id, ghl_contact_id, meta_campaign_id, tags, ghl_created_at) VALUES
      ('aaaaa100-0000-0000-0000-000000000001', '${CLIENT_A}', 'k1', 'camp_1', ARRAY[]::text[], '2026-07-08T17:00:00Z'),
      /* Tagged, no campaign id — an Instant Form lead. Paid under 'either'. */
      ('aaaaa100-0000-0000-0000-000000000002', '${CLIENT_A}', 'k2', NULL, ARRAY['facebook-lead'], '2026-07-09T17:00:00Z'),
      /* Neither: not a paid lead, must not be counted. */
      ('aaaaa100-0000-0000-0000-000000000003', '${CLIENT_A}', 'k3', NULL, ARRAY[]::text[], '2026-07-10T17:00:00Z'),
      /*
       * 🔴 5:30pm on 12 July in Los Angeles is 00:30 on the 13th in UTC. Read
       * without the timezone this lead moves into the following bucket, and a
       * fortnight-over-fortnight comparison shifts by a whole lead.
       */
      ('aaaaa100-0000-0000-0000-000000000004', '${CLIENT_A}', 'k4', 'camp_1', ARRAY[]::text[], '2026-07-13T00:30:00Z'),
      ('aaaaa100-0000-0000-0000-000000000005', '${CLIENT_A}', 'k5', 'camp_1', ARRAY[]::text[], '2026-07-15T17:00:00Z'),
      /* Another tenant's lead in the same week. */
      ('bbbbb100-0000-0000-0000-000000000001', '${CLIENT_B}', 'k9', 'camp_9', ARRAY[]::text[], '2026-07-08T17:00:00Z')
  `);

  await run(`
    INSERT INTO webhook_events (client_id, event_type, received_at, payload) VALUES
      ('${CLIENT_A}', 'ContactCreate', '2026-03-01T10:00:00Z', '{}'),
      ('${CLIENT_A}', 'ContactCreate', '2026-07-20T10:00:00Z', '{}')
  `);
}

const load = () => q.getChurnWeeks(WEEKS);
const week = async (idx: number) => (await load()).rows.find((r) => r.idx === idx)!;

describe("weekly spend", () => {
  it("sums campaign-level rows only", async () => {
    // The ad-level row repeats its campaign's money one level down. Counted,
    // every account on the portfolio screen reads at double its real spend.
    expect((await week(0)).spend).toBeCloseTo(150, 6);
  });

  it("🔴 adds Google without multiplying it against Meta", async () => {
    /*
     * Joining both metric tables to the same window row produces their cross
     * product: a week with 7 Meta days and 7 Google days reports 49 of each.
     * $100 Meta + $50 Google is $150, and any other answer is that bug.
     */
    const r = await week(0);
    expect(r.spend).toBeCloseTo(150, 6);
  });

  it("keeps weeks apart", async () => {
    expect((await week(1)).spend).toBeCloseTo(300, 6);
  });

  it("does not leak another tenant's spend", async () => {
    expect((await week(0)).spend).toBeCloseTo(150, 6);
  });
});

describe("weekly leads", () => {
  it("counts paid leads by arrival time", async () => {
    /*
     * Four contacts arrived in week 0; three of them count. Campaign id and tag
     * both qualify, and the one carrying neither does not — the same definition
     * the client's own dashboard divides its cost per lead by, so the two
     * screens cannot disagree about how many leads a week produced.
     */
    expect((await week(0)).leads).toBe(3);
  });

  it("🔴 puts a lead that arrived at 5:30pm on the 12th in that week", async () => {
    /*
     * In UTC it is the 13th and belongs to the next bucket. A fortnight-over-
     * fortnight comparison built on that boundary moves leads between the two
     * halves it is comparing.
     */
    expect((await week(0)).leads).toBe(3); // includes the 5:30pm arrival
    expect((await week(1)).leads).toBe(1); // only the 15th
  });

  it("does not leak another tenant's leads", async () => {
    const total = (await load()).rows.reduce((n, r) => n + r.leads, 0);
    expect(total).toBe(4);
  });

  it("returns a row for a week with nothing in it", async () => {
    /*
     * A silent gap and a zero are different things everywhere else in this
     * codebase; here a missing bucket would shift the block boundary and
     * compare three weeks against four.
     */
    const empty = await q.getChurnWeeks([
      {
        clientId: CLIENT_A,
        idx: 0,
        window: windowFromKeys("2026-01-05", "2026-01-11", TZ),
        filter: FILTER,
      },
    ]);
    expect(empty.rows).toHaveLength(1);
    expect(empty.rows[0].spend).toBe(0);
    expect(empty.rows[0].leads).toBe(0);
  });
});

describe("first and last signs of life", () => {
  it("🔴 takes first activity from the CRM as well as the ad data", async () => {
    /*
     * This client's first webhook is 1 March and its first ad day is 8 July.
     * Reading ad data alone would make it four months younger than it is and
     * withhold every judgement about it for two more months — the panel going
     * quiet about exactly the accounts that have been running longest.
     */
    const r = await load();
    expect(r.firstActivity.get(CLIENT_A)!.slice(0, 10)).toBe("2026-03-01");
  });

  it("takes the most recent webhook, not the first", async () => {
    const r = await load();
    expect(r.lastWebhook.get(CLIENT_A)!.slice(0, 10)).toBe("2026-07-20");
  });

  it("reports a client with no webhooks at all as having none", async () => {
    // Null, not "today" — a client whose CRM has never spoken must read as a
    // dead pipe rather than a healthy one that happens to be quiet.
    const r = await q.getChurnWeeks([
      {
        clientId: CLIENT_B,
        idx: 0,
        window: windowFromKeys("2026-07-06", "2026-07-12", TZ),
        filter: FILTER,
      },
    ]);
    expect(r.lastWebhook.get(CLIENT_B)).toBeUndefined();
    // But it does have ad data, so it is not a brand new account.
    expect(r.firstActivity.get(CLIENT_B)).toBeDefined();
  });

  it("returns nothing at all for an empty request", async () => {
    const r = await q.getChurnWeeks([]);
    expect(r.rows).toEqual([]);
    expect(r.firstActivity.size).toBe(0);
  });
});
