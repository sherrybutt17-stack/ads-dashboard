import { describe, it, expect } from "vitest";
import type { DashboardData } from "@/lib/metrics/dashboard";
import { metaResultType } from "@/lib/metrics/results";
import { normalizeView } from "@/lib/report/view";
import { buildDashboardSheets } from "./dashboard-tables";
import { buildCsvSections } from "./csv";

/*
 * Only the fields the chosen sections read. The builders take the same
 * `DashboardData` the dashboard renders, so a fixture this small is enough to
 * pin the shape of each table without a database.
 */
function period(spend: number, leads: number, won: number, revenue: number | null) {
  return {
    label: "p",
    window: { startKey: "2026-09-01", endKey: "2026-09-30" },
    ads: { spend, impressions: 1000, linkClicks: 50 },
    funnel: { new_lead: leads, appointment_booked: 4, showed: 2, closed_won: won },
    derived: { cpLead: leads ? spend / leads : null, roas: revenue ? revenue / spend : null },
    revenue:
      revenue === null
        ? { wonOpps: won, wonWithValue: 0, revenue: 0 }
        : { wonOpps: won, wonWithValue: won, revenue },
  };
}

const data = {
  client: { name: "GG ads", timezone: "America/Los_Angeles", currency: "USD" },
  range: { startKey: "2026-09-01", endKey: "2026-09-30", label: "Sep 1 – Sep 30" },
  current: period(100, 10, 1, null),
  previous: period(50, 5, 1, 400),
  deltas: { spend: 1, new_lead: 1, cpLead: 0, revenue: -1, roas: null, results: 0.5, cpResult: -0.25 },
  results: {
    type: metaResultType("actions:offsite_conversion.fb_pixel_lead"),
    count: 12,
    costPer: 8.25,
    previousCount: 8,
    previousCostPer: 11,
    spark: [],
    othersNote: null,
    notCollected: false,
    mixedSpend: 0,
  },
  platform: "meta",
  funnel: [
    { stage: "new_lead", count: 10, conversionFromPrevious: null, droppedFromPrevious: null },
    { stage: "appointment_booked", count: 4, conversionFromPrevious: 0.4, droppedFromPrevious: 6 },
  ],
  daily: [],
  leadFilter: { mode: "either", tag: "facebook-lead", total: 20, attributed: 8, tagged: 4, paid: 10 },
} as unknown as DashboardData;

const sheetsFor = (raw: unknown) =>
  buildDashboardSheets({ data, deferred: null, view: normalizeView(raw)!, platform: "meta" });

describe("buildDashboardSheets", () => {
  it("gives one table per chosen section, in dashboard order, starting with About", () => {
    const sheets = sheetsFor({ sections: ["funnel", "kpis"] });
    expect(sheets.map((s) => s.name)).toEqual(["About", "Headline numbers", "Funnel"]);
  });

  it("writes only the chosen headline numbers, with the previous period and the change", () => {
    const [, kpis] = sheetsFor({ sections: ["kpis"], kpis: ["spend", "revenue"] });
    expect(kpis.table.headers).toEqual(["Metric", "This period", "Previous period", "Change %"]);
    expect(kpis.table.rows.map((r) => r[0])).toEqual([
      { kind: "text", value: "Ad spend" },
      { kind: "text", value: "Revenue" },
    ]);
    // Spend 100 against 50 is +100%.
    expect(kpis.table.rows[0][1]).toMatchObject({ value: 100 });
    expect(kpis.table.rows[0][3]).toMatchObject({ value: 100 });
    // Deals closed with no value recorded: blank, never $0 and never -100%.
    expect(kpis.table.rows[1][1]).toMatchObject({ value: null });
    expect(kpis.table.rows[1][3]).toMatchObject({ value: null });
    expect(kpis.table.rows[1][2]).toMatchObject({ value: 400 });
  });

  it("names the kind of result beside the platform's own count", () => {
    const [, kpis] = sheetsFor({ sections: ["kpis"], kpis: ["results", "cpResult"] });
    expect(kpis.table.rows.map((r) => r[0].value)).toEqual([
      "Results (Website leads)",
      "Cost per result (Website leads)",
    ]);
    expect(kpis.table.rows[0].slice(1, 4).map((c) => c.value)).toEqual([12, 8, 50]);
  });

  it("says which leads were counted, and which chosen sections are PDF-only", () => {
    const [about] = sheetsFor({ sections: ["kpis", "heatmap"] });
    const asText = about.table.rows.map((r) => r.map((c) => c.value).join(": "));
    expect(asText).toContain('Leads counted: Leads with a Facebook campaign ID or tagged "facebook-lead"');
    expect(asText.some((t) => t.startsWith("In the PDF and share link only") && t.includes("When leads arrive"))).toBe(true);
  });

  it("puts every table in one CSV, each under its own title", () => {
    const csv = buildCsvSections(sheetsFor({ sections: ["kpis", "funnel"] }));
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.split("﻿").length).toBe(2); // one byte-order mark, at the start
    expect(csv).toContain('"Headline numbers"\r\n"Metric","This period"');
    expect(csv).toContain('"Funnel"\r\n"Stage"');
    expect(csv).toContain('"Appointment Booked"');
  });
});
