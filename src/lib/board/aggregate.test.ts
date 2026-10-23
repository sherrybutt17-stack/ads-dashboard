import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { previousWindow, windowFromKeys } from "@/lib/dates";
import { pctChange } from "@/lib/metrics/compute";
import type { Client } from "@/db/schema";
import type { BoardWidget, WidgetData, WidgetQuery } from "./types";

/**
 * The aggregator against a real Postgres, seeded like a small client.
 *
 * The parity tests are the point: a board tile and the Overview tile for the
 * same stat over the same range must print the same number. The Overview's
 * headline tiles read `getPeriodMetrics(..., includeRevenue = true)` for the
 * current and previous windows; the board must land on exactly those values,
 * and its own sums (actions, splits, tables) must reconcile to them.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let agg: typeof import("./aggregate");
let q: typeof import("@/lib/metrics/queries");

const TZ = "America/Los_Angeles";
const WINDOW = windowFromKeys("2026-09-01", "2026-09-10", TZ);
const PREV = previousWindow(WINDOW, TZ);

const CLIENT = {
  id: CLIENT_A,
  name: "Acme",
  slug: "acme",
  timezone: TZ,
  paidLeadFilter: "all",
  paidLeadTag: "facebook-lead",
  metaCurrency: "USD",
  agencyId: "00000000-0000-0000-0000-000000000099",
} as unknown as Client;

const CONNECTED = { meta: true, google: false, tiktok: false, crm: true };
const ASSETS = { logoSrc: null, brandName: "Acme" };

const run = (s: string) => harness.db.execute(sql.raw(s));

function input(mode: "page" | "api" | "document" = "page", connections = CONNECTED) {
  return { client: CLIENT, window: WINDOW, mode, connections, assets: ASSETS };
}

async function one(query: WidgetQuery, mode: "page" | "api" | "document" = "page"): Promise<WidgetData> {
  return agg.loadWidgetData(input(mode), query);
}

function value(d: WidgetData): number | null {
  if (d.kind !== "value") throw new Error(`expected a value, got ${d.kind}`);
  return d.value;
}

const actions = (pairs: Record<string, number>) =>
  JSON.stringify({ actions: Object.entries(pairs).map(([action_type, v]) => ({ action_type, value: String(v) })) });

beforeAll(async () => {
  harness = await createTestDb();
  agg = await import("./aggregate");
  q = await import("@/lib/metrics/queries");

  // Ten days of two campaigns, plus a quieter previous period for the deltas.
  for (let d = 1; d <= 10; d++) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    await run(`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name,
        spend, impressions, clicks_all, link_clicks, leads_total, landing_page_views, video_3s_views, raw)
      VALUES
        ('${CLIENT_A}', '${date}', 'campaign', 'c1', 'Spring', 30, 3000, 90, 60, 2, 50, 400,
         '${actions({ post_reaction: 5, comment: 1, purchase: 1 })}'::jsonb),
        ('${CLIENT_A}', '${date}', 'campaign', 'c2', 'Autumn', 10, 2000, 40, 20, 1, 15, 0,
         '${actions({ post_reaction: 2 })}'::jsonb)
    `);
  }
  for (let d = 22; d <= 31; d++) {
    await run(`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name,
        spend, impressions, clicks_all, link_clicks)
      VALUES ('${CLIENT_A}', '2026-08-${d}', 'campaign', 'c1', 'Spring', 20, 2500, 50, 40)
    `);
  }
  // Ad rows only from the 5th — the nightly ad-level sync started late.
  for (let d = 5; d <= 10; d++) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    await run(`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name,
        meta_adset_id, adset_name, meta_ad_id, ad_name, spend, impressions, link_clicks, video_3s_views, video_plays, thru_plays)
      VALUES
        ('${CLIENT_A}', '${date}', 'ad', 'c1', 'Spring', 's1', 'Set one', 'a1', 'Video ad', 20, 2000, 40, 400, 500, 50),
        ('${CLIENT_A}', '${date}', 'ad', 'c1', 'Spring', 's1', 'Set one', 'a2', 'Image ad', 10, 1000, 20, 0, 0, 0)
    `);
  }
  // Gender split covering most, not all, of the link clicks (Meta withholds some).
  for (let d = 1; d <= 10; d++) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    await run(`
      INSERT INTO fb_breakdown_metrics (client_id, date_start, date_end, breakdown_key, segment_value,
        impressions, link_clicks, spend, leads_total)
      VALUES
        ('${CLIENT_A}', '${date}', '${date}', 'gender', 'female', 2500, 45, 22, 2),
        ('${CLIENT_A}', '${date}', '${date}', 'gender', 'male', 2000, 30, 15, 1)
    `);
  }
  await run(`INSERT INTO meta_ad_accounts (client_id, ad_account_id, status) VALUES ('${CLIENT_A}', 'act1', 'active')`);

  // CRM: four leads in range (one unattributed), two booked.
  const contacts: Array<[string, string | null]> = [
    ["c0000000-0000-0000-0000-000000000001", "c1"],
    ["c0000000-0000-0000-0000-000000000002", "c1"],
    ["c0000000-0000-0000-0000-000000000003", "c2"],
    ["c0000000-0000-0000-0000-000000000004", null],
  ];
  let i = 0;
  for (const [id, campaign] of contacts) {
    i++;
    const opp = `0e000000-0000-0000-0000-00000000000${i}`;
    await run(`
      INSERT INTO contacts (id, client_id, ghl_contact_id, meta_campaign_id)
      VALUES ('${id}', '${CLIENT_A}', 'gc${i}', ${campaign ? `'${campaign}'` : "NULL"})
    `);
    await run(`
      INSERT INTO opportunities (id, client_id, ghl_opportunity_id, contact_id)
      VALUES ('${opp}', '${CLIENT_A}', 'go${i}', '${id}')
    `);
    await run(`
      INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at)
      VALUES ('${CLIENT_A}', '${opp}', '${id}', 'new_lead', '2026-09-0${i + 1}T18:00:00Z')
    `);
    if (i <= 2) {
      await run(`
        INSERT INTO stage_transitions (client_id, opportunity_id, contact_id, to_canonical, changed_at)
        VALUES ('${CLIENT_A}', '${opp}', '${id}', 'appointment_booked', '2026-09-0${i + 3}T18:00:00Z')
      `);
    }
  }
});

afterAll(async () => {
  await harness.close();
});

describe("🔴 parity with the Overview tiles", () => {
  it("prints the same headline numbers, and the same changes", async () => {
    const filter = { mode: "all" as const, tag: "facebook-lead" };
    const cur = await q.getPeriodMetrics(CLIENT_A, WINDOW, "c", undefined, filter, "meta", true);
    const prev = await q.getPeriodMetrics(CLIENT_A, PREV, "p", undefined, filter, "meta", true);

    const spend = await one({ kind: "kpi", platform: "meta", metric: "spend" });
    expect(value(spend)).toBe(cur.ads.spend);
    expect(spend.kind === "value" && spend.change).toBe(pctChange(cur.ads.spend, prev.ads.spend));

    expect(value(await one({ kind: "kpi", platform: "meta", metric: "clicks" }))).toBe(cur.ads.linkClicks);
    expect(value(await one({ kind: "kpi", platform: "meta", metric: "ctr" }))).toBeCloseTo(cur.derived.ctr!);
    expect(value(await one({ kind: "kpi", platform: "meta", metric: "cpc" }))).toBeCloseTo(cur.derived.cpc!);
    expect(value(await one({ kind: "kpi", platform: "meta", metric: "leads" }))).toBe(cur.funnel.new_lead);
    expect(value(await one({ kind: "kpi", platform: "meta", metric: "cp_lead" }))).toBeCloseTo(cur.derived.cpLead!);
    expect(cur.funnel.new_lead).toBe(4);
  });

  it("carries the Overview's footnotes", async () => {
    const appts = await one({ kind: "kpi", platform: "meta", metric: "appointments" });
    expect(appts.kind === "value" && appts.footnote).toBe("50.0% of leads");
  });

  it("reads engagement from the stored actions", async () => {
    expect(value(await one({ kind: "kpi", platform: "meta", metric: "post_reactions" }))).toBe(70);
    expect(value(await one({ kind: "kpi", platform: "meta", metric: "purchases" }))).toBe(10);
    expect(value(await one({ kind: "kpi", platform: "meta", metric: "cp_purchase" }))).toBeCloseTo(40);
  });
});

describe("splits and tables reconcile to the total", () => {
  it("🔴 shows Meta's withheld share as its own slice", async () => {
    const d = await one({
      kind: "category",
      platform: "meta",
      metric: "clicks",
      dimension: "gender",
      form: "donut",
      topN: 6,
    });
    expect(d.kind).toBe("categories");
    if (d.kind !== "categories") return;
    const byKey = Object.fromEntries(d.rows.map((r) => [r.key, r.value]));
    expect(byKey).toEqual({ female: 450, male: 300, __not_reported__: 50 });
    expect(d.total).toBe(800);
  });

  it("puts unattributed leads in the campaign table, so the column sums to the total", async () => {
    const d = await one({
      kind: "table",
      platform: "meta",
      dimension: "campaign",
      metrics: ["spend", "leads", "cp_lead"],
      sort: "spend",
      topN: 10,
    });
    if (d.kind !== "table") throw new Error(d.kind);
    const leads = d.rows.map((r) => r.values[1] ?? 0).reduce((a, b) => a + b, 0);
    expect(leads).toBe(4);
    expect(d.rows.map((r) => r.label)).toEqual(["Spring", "Autumn", "Unattributed"]);
    expect(d.totals[0]).toBe(400);
    expect(d.totals[1]).toBe(4);
    expect(d.totals[2]).toBeCloseTo(100);
  });

  it("names the day ad-level data starts when the range begins earlier", async () => {
    const d = await one({
      kind: "table",
      platform: "meta",
      dimension: "ad",
      metrics: ["impressions", "spend", "hook_rate"],
      sort: "spend",
      topN: 10,
    });
    if (d.kind !== "table") throw new Error(d.kind);
    expect(d.rows.map((r) => r.label)).toEqual(["Video ad", "Image ad"]);
    expect(d.rows[0].values[2]).toBeCloseTo(0.2);
    expect(d.rows[1].values[2]).toBeNull();
    expect(d.notes?.join(" ")).toMatch(/Ad-level figures start Sep 5/);
  });

  it("reads each daily column from the rows that hold it", async () => {
    const d = await one({
      kind: "table",
      platform: "meta",
      dimension: "date",
      metrics: ["spend", "thruplays"],
      sort: "spend",
      topN: 31,
    });
    if (d.kind !== "table") throw new Error(d.kind);
    expect(d.rows).toHaveLength(10);
    expect(d.totals[0]).toBe(400);
    expect(d.totals[1]).toBe(300);
  });
});

describe("reach", () => {
  it("is pending on a page, and never fetched while rendering", async () => {
    expect((await one({ kind: "kpi", platform: "meta", metric: "reach" }, "page")).kind).toBe("pending");
  });

  it("is unavailable in a document rather than asking Meta", async () => {
    const d = await one({ kind: "kpi", platform: "meta", metric: "reach" }, "document");
    expect(d.kind).toBe("unavailable");
  });

  it("explains, without throwing, when the data API cannot fetch it", async () => {
    // No Meta credential in tests: the fetch fails before any request is sent.
    const d = await one({ kind: "kpi", platform: "meta", metric: "reach" }, "api");
    expect(d.kind).toBe("unavailable");
  });

  it("shows the cached figure for exactly this range", async () => {
    await run(`
      INSERT INTO fb_period_reach (client_id, meta_ad_account_id, period_start, period_end, reach, frequency)
      VALUES ('${CLIENT_A}', 'act1', '2026-09-01', '2026-09-10', 5100, 1.6)
    `);
    expect(value(await one({ kind: "kpi", platform: "meta", metric: "reach" }))).toBe(5100);
    expect(value(await one({ kind: "kpi", platform: "meta", metric: "frequency" }))).toBeCloseTo(1.6);
    await run(`DELETE FROM fb_period_reach`);
  });
});

describe("honest gaps", () => {
  it("says a platform is not connected instead of printing zeros", async () => {
    const d = await one({ kind: "kpi", platform: "google", metric: "spend" });
    expect(d.kind).toBe("unavailable");
    if (d.kind === "unavailable") expect(d.title).toMatch(/Google ads are not connected/);
  });

  it("says when there is no CRM", async () => {
    const d = await agg.loadWidgetData(input("page", { ...CONNECTED, crm: false }), {
      kind: "kpi",
      platform: "meta",
      metric: "leads",
    });
    expect(d.kind).toBe("unavailable");
  });

  it("🔴 one failing query blanks only the widgets that needed it", async () => {
    const widgets: BoardWidget[] = [
      { id: "spend", kind: "kpi", platform: "meta", metric: "spend", x: 0, y: 0, w: 3, h: 3 },
      {
        id: "gender",
        kind: "category",
        platform: "meta",
        metric: "clicks",
        dimension: "gender",
        form: "donut",
        topN: 6,
        x: 3,
        y: 0,
        w: 6,
        h: 7,
      },
    ];
    await run(`ALTER TABLE fb_breakdown_metrics RENAME TO fb_breakdown_metrics_away`);
    try {
      const data = await agg.loadBoardData(input(), widgets);
      expect(data.spend.kind).toBe("value");
      expect(data.gender.kind).toBe("unavailable");
    } finally {
      await run(`ALTER TABLE fb_breakdown_metrics_away RENAME TO fb_breakdown_metrics`);
    }
  });
});
