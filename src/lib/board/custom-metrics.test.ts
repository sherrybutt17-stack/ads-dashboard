import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";
import type { CustomMetricDraft } from "./registry";

/**
 * Storing an agency's metrics, against a real Postgres: every read and write
 * is scoped by agency, and usage counts the agency's own boards only.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let store: typeof import("./custom-metrics");

const AGENCY = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT = "22222222-2222-4222-8222-222222222222";

const rename: CustomMetricDraft = {
  kind: "rename",
  platform: "meta",
  baseMetric: "fb_onsite_leads",
  expression: null,
  label: "Form leads",
  description: " Leads from Instant Forms. ",
  format: "currency",
  polarity: "lower-better",
};

const formula: CustomMetricDraft = {
  kind: "formula",
  platform: "any",
  baseMetric: null,
  expression: [{ t: "stat", id: "spend" }, { t: "op", v: "/" }, { t: "stat", id: "appointments" }],
  label: "Cost per booked call",
  description: null,
  format: "currency",
  polarity: "lower-better",
};

const run = (q: string) => harness.db.execute(sql.raw(q));

beforeAll(async () => {
  harness = await createTestDb();
  store = await import("./custom-metrics");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(`TRUNCATE custom_metrics, dashboard_boards RESTART IDENTITY CASCADE`);
  await run(`DELETE FROM clients WHERE id IN ('${CLIENT}', '${OTHER_CLIENT}')`);
  await run(`
    INSERT INTO clients (id, name, slug, agency_id, timezone) VALUES
      ('${CLIENT}', 'Acme', 'acme-metrics', '${AGENCY}', 'UTC'),
      ('${OTHER_CLIENT}', 'Bright', 'bright-metrics', '${OTHER}', 'UTC')`);
});

describe("custom metrics store", () => {
  it("stores a rename without a formula, and a formula without a base", async () => {
    const r = await store.createCustomMetric(AGENCY, rename, "u1");
    expect(r).toMatchObject({ kind: "rename", baseMetric: "fb_onsite_leads", expression: null, format: null, polarity: null });
    expect(r.description).toBe("Leads from Instant Forms.");
    const f = await store.createCustomMetric(AGENCY, formula, "u1");
    expect(f).toMatchObject({ kind: "formula", platform: "any", baseMetric: null, format: "currency" });
    expect(f.expression).toEqual(formula.expression);
  });

  it("🔴 never reads, changes or deletes another agency's metric", async () => {
    const mine = await store.createCustomMetric(AGENCY, rename, null);
    expect(await store.listCustomMetrics(OTHER)).toEqual([]);
    expect(await store.getCustomMetric(OTHER, mine.id)).toBeNull();
    expect(await store.updateCustomMetric(OTHER, mine.id, { ...rename, label: "Hijacked" }, null)).toBeNull();
    expect(await store.setCustomMetricArchived(OTHER, mine.id, true, null)).toBeNull();
    expect(await store.deleteCustomMetric(OTHER, mine.id)).toBe(false);
    expect((await store.getCustomMetric(AGENCY, mine.id))?.label).toBe("Form leads");
  });

  it("archives and restores without touching the definition", async () => {
    const m = await store.createCustomMetric(AGENCY, formula, null);
    expect((await store.setCustomMetricArchived(AGENCY, m.id, true, null))?.archived).toBe(true);
    const back = await store.setCustomMetricArchived(AGENCY, m.id, false, null);
    expect(back).toMatchObject({ archived: false, label: "Cost per booked call" });
  });

  it("counts the boards that show each metric — this agency's boards only", async () => {
    const m = await store.createCustomMetric(AGENCY, rename, null);
    const unused = await store.createCustomMetric(AGENCY, formula, null);
    const widgets = (metric: string) =>
      JSON.stringify([{ id: "w-1", kind: "kpi", platform: "meta", metric, x: 0, y: 0, w: 3, h: 3 }]);
    await run(`INSERT INTO dashboard_boards (client_id, widgets) VALUES ('${CLIENT}', '${widgets(`custom:${m.id}`)}'::jsonb)`);
    // Another agency's board naming the id (it could not have saved it, but it is not ours to count).
    await run(`INSERT INTO dashboard_boards (client_id, widgets) VALUES ('${OTHER_CLIENT}', '${widgets(`custom:${m.id}`)}'::jsonb)`);
    const usage = await store.customMetricUsage(AGENCY);
    expect(usage.get(m.id)).toBe(1);
    expect(usage.get(unused.id)).toBe(0);
    const using = await store.widgetsUsingMetric(AGENCY, m.id);
    expect(using.map((w) => w.id)).toEqual(["w-1"]);
  });

  it("reads a missing table as no metrics, never an error", async () => {
    await run(`ALTER TABLE custom_metrics RENAME TO custom_metrics_away`);
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await store.listCustomMetrics(AGENCY)).toEqual([]);
    } finally {
      await run(`ALTER TABLE custom_metrics_away RENAME TO custom_metrics`);
      vi.restoreAllMocks();
    }
  });
});
