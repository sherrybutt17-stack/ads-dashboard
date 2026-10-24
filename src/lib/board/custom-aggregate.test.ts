import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import type { Client } from "@/db/schema";
import { buildRegistry, customId, type CustomMetric } from "./registry";
import type { WidgetData, WidgetQuery } from "./types";

/**
 * Board widgets over an agency's own metrics, against a real Postgres: a
 * formula is a ratio of each row's sums (and of the whole table's), a rename
 * is its base stat to the last detail (reach stays one fetched figure), and a
 * metric the registry cannot resolve — deleted, or another agency's — makes
 * its widget say so instead of drawing anything.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let agg: typeof import("./aggregate");

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

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const perClick: CustomMetric = {
  id: uuid(1),
  kind: "formula",
  platform: "meta",
  baseMetric: null,
  expression: [{ t: "stat", id: "spend" }, { t: "op", v: "/" }, { t: "stat", id: "clicks" }],
  label: "Spend per link click",
  description: null,
  format: "currency",
  polarity: "lower-better",
  archived: false,
};

const peopleReached: CustomMetric = {
  id: uuid(2),
  kind: "rename",
  platform: "meta",
  baseMetric: "reach",
  expression: null,
  label: "People reached",
  description: null,
  format: null,
  polarity: null,
  archived: false,
};

const bookings: CustomMetric = {
  ...perClick,
  id: uuid(3),
  platform: "any",
  expression: [{ t: "stat", id: "spend" }, { t: "op", v: "/" }, { t: "stat", id: "appointments" }],
  label: "Cost per booking",
};

const registry = buildRegistry([perClick, peopleReached, bookings]);

function one(query: WidgetQuery, crm = false): Promise<WidgetData> {
  return agg.loadWidgetData(
    {
      client: CLIENT,
      window: WINDOW,
      mode: "page",
      connections: { meta: true, google: true, tiktok: true, crm },
      assets: { logoSrc: null, brandName: "Acme" },
      registry,
    },
    query,
  );
}

beforeAll(async () => {
  harness = await createTestDb();
  agg = await import("./aggregate");
  for (let d = 1; d <= 10; d++) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    // Two campaigns at very different prices per click.
    await harness.db.execute(sql.raw(`
      INSERT INTO fb_daily_metrics (client_id, date, level, meta_campaign_id, campaign_name, spend, impressions, link_clicks)
      VALUES ('${CLIENT_A}', '${date}', 'campaign', 'cheap', 'Cheap clicks', 10, 1000, 100),
             ('${CLIENT_A}', '${date}', 'campaign', 'dear', 'Dear clicks', 90, 1000, 10)
    `));
  }
});

afterAll(async () => {
  await harness.close();
});

describe("a formula on the board", () => {
  it("🔴 is the ratio of the range's sums — the same as the built-in it mirrors", async () => {
    const custom = await one({ kind: "kpi", platform: "meta", metric: customId(perClick) });
    const builtIn = await one({ kind: "kpi", platform: "meta", metric: "cpc" });
    if (custom.kind !== "value" || builtIn.kind !== "value") throw new Error("expected values");
    // $1,000 over 1,100 clicks, not the $4.55 average of $0.10 and $9.00.
    expect(custom.value).toBeCloseTo(1000 / 1100, 8);
    expect(custom.value).toBe(builtIn.value);
  });

  it("🔴 gives each table row its own ratio, and the total the whole table's", async () => {
    const t = await one({
      kind: "table",
      platform: "meta",
      dimension: "campaign",
      metrics: ["spend", customId(perClick)],
      sort: "spend",
      topN: 10,
    });
    if (t.kind !== "table") throw new Error(t.kind);
    expect(t.rows.map((r) => [r.key, r.values[1]])).toEqual([
      ["dear", 9],
      ["cheap", 0.1],
    ]);
    expect(t.totals[1]).toBeCloseTo(1000 / 1100, 8);
  });

  it("asks for the CRM when one of its stats lives there", async () => {
    const d = await one({ kind: "kpi", platform: "google", metric: customId(bookings) });
    expect(d).toMatchObject({ kind: "unavailable", title: "No CRM connected" });
  });
});

describe("a rename on the board", () => {
  it("🔴 keeps reach the one figure fetched for the range — never a sum of days", async () => {
    const d = await one({ kind: "kpi", platform: "meta", metric: customId(peopleReached) });
    // Page mode leaves reach to the data API, exactly as the built-in tile does.
    expect(d).toEqual({ kind: "pending", reason: "reach" });
  });
});

describe("a metric the board cannot resolve", () => {
  it("🔴 says it was deleted, rather than drawing anything", async () => {
    const d = await one({ kind: "kpi", platform: "meta", metric: `custom:${uuid(99)}` });
    expect(d).toMatchObject({
      kind: "unavailable",
      title: "This widget cannot be shown",
      detail: expect.stringMatching(/deleted from Settings → Metrics/),
    });
  });
});
