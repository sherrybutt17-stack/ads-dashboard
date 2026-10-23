import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { Client } from "@/db/schema";
import type { WidgetData, WidgetQuery } from "./types";

/**
 * Board widgets over each platform's own "Results", against a real Postgres.
 *
 * Seeded the way King LASIK and GG ads looked on 24 Oct 2026: a website-lead
 * campaign carrying most of the spend, a cheap landing-page-view campaign, and
 * one day where a campaign optimised for two things at once. The rules under
 * test: one kind of result per tile, the same kind for the previous period, no
 * totals across kinds, and a cost per result that Ads Manager would agree with.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let agg: typeof import("./aggregate");
let bq: typeof import("@/lib/metrics/board-queries");
let r: typeof import("@/lib/metrics/results");

const TZ = "America/Los_Angeles";
const WINDOW = windowFromKeys("2026-09-01", "2026-09-10", TZ);

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

const ALL = { meta: true, google: true, tiktok: true, crm: false };

const run = (s: string) => harness.db.execute(sql.raw(s));
const results = (...entries: Array<[string, number | null]>) =>
  JSON.stringify({
    results: entries.map(([indicator, v]) =>
      v === null ? { indicator } : { indicator, values: [{ value: String(v), attribution_windows: ["default"] }] },
    ),
  });

const LEAD = "actions:offsite_conversion.fb_pixel_lead";
const LPV = "actions:omni_landing_page_view";
const MSG = "actions:onsite_conversion.messaging_conversation_started_7d";

function one(query: WidgetQuery): Promise<WidgetData> {
  return agg.loadWidgetData({ client: CLIENT, window: WINDOW, mode: "page", connections: ALL, assets: { logoSrc: null, brandName: "Acme" } }, query);
}

function valueOf(d: WidgetData) {
  if (d.kind !== "value") throw new Error(`expected a value, got ${d.kind}: ${JSON.stringify(d)}`);
  return d;
}

beforeAll(async () => {
  harness = await createTestDb();
  agg = await import("./aggregate");
  bq = await import("@/lib/metrics/board-queries");
  r = await import("@/lib/metrics/results");

  for (let d = 1; d <= 10; d++) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    await run(`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name, spend, raw)
      VALUES
        ('${CLIENT_A}', '${date}', 'campaign', 'lead', 'Website leads', 50, '${results([LEAD, d % 2 === 0 ? 2 : null])}'::jsonb),
        ('${CLIENT_A}', '${date}', 'campaign', 'lpv', 'Traffic', 5, '${results([LPV, 40])}'::jsonb)
    `);
  }
  // One day where a campaign optimised for leads AND messages: its $30 can't be split.
  await run(`
    INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name, spend, raw)
    VALUES ('${CLIENT_A}', '2026-09-05', 'campaign', 'mixed', 'Both', 30, '${results([LEAD, 3], [MSG, 4])}'::jsonb)
  `);
  // The previous period: the same lead campaign, fewer leads.
  for (let d = 22; d <= 31; d++) {
    await run(`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name, spend, raw)
      VALUES ('${CLIENT_A}', '2026-08-${d}', 'campaign', 'lead', 'Website leads', 40, '${results([LEAD, d % 5 === 0 ? 1 : null])}'::jsonb)
    `);
  }
  await run(`
    INSERT INTO google_daily_metrics (client_id, date, google_campaign_id, campaign_name, spend, conversions)
    VALUES ('${CLIENT_A}', '2026-09-02', 'g1', 'Search', 30, 1.5), ('${CLIENT_A}', '2026-09-03', 'g1', 'Search', 30, 2.25)
  `);
  await run(`
    INSERT INTO tiktok_daily_metrics (client_id, date, tiktok_campaign_id, campaign_name, spend, raw)
    VALUES ('${CLIENT_A}', '2026-09-02', 't1', 'Leads', 100,
            '{"metrics":{"objective_type":"LEAD_GENERATION"},"results":{"value":48,"objective":"LEAD_GENERATION"}}'::jsonb)
  `);
});

afterAll(async () => {
  await harness.close();
});

describe("a results tile", () => {
  it("🔴 counts the kind most spend went to, names it, and names the rest", async () => {
    const d = valueOf(await one({ kind: "kpi", platform: "meta", metric: "results" }));
    // 5 even days × 2 website leads, plus 3 on the mixed day.
    expect(d.value).toBe(13);
    expect(d.unit).toBe("Website leads");
    expect(d.footnote).toBe("Also 400 landing page views and 4 messaging conversations started.");
    // The previous period counts the SAME kind: 2 leads (days 25 and 30).
    expect(d.previous).toBe(2);
  });

  it("🔴 prices results the way Ads Manager does, leaving the mixed day out", async () => {
    const d = valueOf(await one({ kind: "kpi", platform: "meta", metric: "cost_per_result" }));
    // $500 on lead-only days ÷ 10 leads on those days — not $500 ÷ 13.
    expect(d.value).toBe(50);
    expect(d.notes?.join(" ")).toMatch(/\$30\.00 went to campaigns optimising for more than one kind/);
  });

  it("counts a pinned kind instead, even when it is not the main one", async () => {
    const d = valueOf(await one({ kind: "kpi", platform: "meta", metric: "results", resultType: "omni_landing_page_view" }));
    expect(d.value).toBe(400);
    expect(d.unit).toBe("Landing page views");
    expect(d.footnote).toBeUndefined();
  });

  it("matches the one source every results number comes from", async () => {
    const [total] = await bq.getPlatformResults("meta", CLIENT_A, WINDOW, "total");
    const h = r.resultsHeadline(total.byType);
    const tile = valueOf(await one({ kind: "kpi", platform: "meta", metric: "results" }));
    const cost = valueOf(await one({ kind: "kpi", platform: "meta", metric: "cost_per_result" }));
    expect(tile.value).toBe(h.count);
    expect(cost.value).toBe(h.costPer);
  });

  it("keeps Google's fractions and needs no type label", async () => {
    const d = valueOf(await one({ kind: "kpi", platform: "google", metric: "results" }));
    expect(d.value).toBe(3.75);
    expect(d.unit).toBeUndefined();
  });

  it("reads TikTok's results from the ad group report, typed by objective", async () => {
    const d = valueOf(await one({ kind: "kpi", platform: "tiktok", metric: "results" }));
    expect(d.value).toBe(48);
    expect(d.unit).toBe("Leads");
  });
});

describe("results split and tabled", () => {
  it("draws one kind per chart, and says which", async () => {
    const d = await one({ kind: "category", platform: "meta", metric: "results", dimension: "campaign", form: "hbar", topN: 8 });
    if (d.kind !== "categories") throw new Error(d.kind);
    // The traffic campaign has no website leads, so it is not a bar.
    expect(d.rows.map((x) => [x.label, x.value])).toEqual([["Website leads", 10], ["Both", 3]]);
    expect(d.total).toBe(13);
    expect(d.notes?.[0]).toBe("Counting website leads — the kind of result most spend went to.");
  });

  it("says what a pinned chart counts, without claiming most spend went to it", async () => {
    const d = await one({
      kind: "category",
      platform: "meta",
      metric: "results",
      dimension: "campaign",
      form: "hbar",
      topN: 8,
      resultType: "omni_landing_page_view",
    });
    if (d.kind !== "categories") throw new Error(d.kind);
    expect(d.rows.map((x) => [x.label, x.value])).toEqual([["Traffic", 400]]);
    expect(d.notes?.[0]).toBe("Counting landing page views.");
  });

  it("🔴 lists every kind side by side but never adds them into a whole", async () => {
    const d = await one({ kind: "category", platform: "meta", metric: "results", dimension: "result_type", form: "hbar", topN: 8 });
    if (d.kind !== "categories") throw new Error(d.kind);
    expect(d.rows.map((x) => x.label)).toEqual(["Landing page views", "Website leads", "Messaging conversations started"]);
    expect(d.total).toBeNull();
  });

  it("🔴 shows each campaign's own results, like Ads Manager, with no total across kinds", async () => {
    const d = await one({
      kind: "table",
      platform: "meta",
      dimension: "campaign",
      metrics: ["spend", "results", "cost_per_result"],
      sort: "spend",
      topN: 10,
    });
    if (d.kind !== "table") throw new Error(d.kind);
    const byLabel = Object.fromEntries(d.rows.map((x) => [x.label, { sub: x.sub, values: x.values }]));
    expect(byLabel["Website leads"]).toEqual({ sub: "Website leads", values: [500, 10, 50] });
    expect(byLabel["Traffic"]).toEqual({ sub: "Landing page views", values: [50, 400, 0.125] });
    expect(d.totals[0]).toBe(580); // spend still adds up
    expect(d.totals[1]).toBeNull();
    expect(d.totals[2]).toBeNull();
  });

  it("totals a pinned kind, which does add up", async () => {
    const d = await one({
      kind: "table",
      platform: "meta",
      dimension: "campaign",
      metrics: ["spend", "results"],
      sort: "spend",
      topN: 10,
      resultType: "offsite_conversion.fb_pixel_lead",
    });
    if (d.kind !== "table") throw new Error(d.kind);
    expect(d.totals[1]).toBe(13);
  });
});

describe("when there is nothing to count", () => {
  it("says results were not collected yet for days synced before the feature", async () => {
    await run(`DELETE FROM fb_daily_metrics`);
    await run(`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name, spend)
      VALUES ('${CLIENT_A}', '2026-09-03', 'campaign', 'old', 'Old', 25)
    `);
    const d = await one({ kind: "kpi", platform: "meta", metric: "results" });
    expect(d).toMatchObject({ kind: "unavailable", title: "Results not collected for these dates yet" });
  });

  it("asks for the platform to be connected first", async () => {
    const d = await agg.loadWidgetData(
      { client: CLIENT, window: WINDOW, mode: "page", connections: { ...ALL, tiktok: false }, assets: { logoSrc: null, brandName: "Acme" } },
      { kind: "kpi", platform: "tiktok", metric: "results" },
    );
    expect(d).toMatchObject({ kind: "unavailable", title: "TikTok ads are not connected" });
  });
});
