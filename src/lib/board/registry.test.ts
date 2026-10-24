import { describe, it, expect } from "vitest";
import { bag } from "./bag";
import { checkWidget, defaultTitle } from "./catalog";
import { BUILTIN, buildRegistry, customId, validateCustomMetric, type CustomMetric, type CustomMetricDraft } from "./registry";
import type { FormulaToken } from "@/lib/metrics/formula";

/**
 * An agency's own metrics as Board stats: what a rename and a formula derive
 * from their built-ins, how they compute, and what saving one refuses.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const s = (id: string): FormulaToken => ({ t: "stat", id });
const op = (v: "+" | "-" | "*" | "/"): FormulaToken => ({ t: "op", v });

const formLeads: CustomMetric = {
  id: uuid(1),
  kind: "rename",
  platform: "meta",
  baseMetric: "fb_onsite_leads",
  expression: null,
  label: "Form leads",
  description: "Leads from our Instant Forms.",
  format: null,
  polarity: null,
  archived: false,
};

const costPerBooking: CustomMetric = {
  id: uuid(2),
  kind: "formula",
  platform: "any",
  baseMetric: null,
  expression: [s("spend"), op("/"), s("appointments")],
  label: "Cost per booked call",
  description: null,
  format: "currency",
  polarity: "lower-better",
  archived: false,
};

const holdPerSpend: CustomMetric = {
  id: uuid(3),
  kind: "formula",
  platform: "meta",
  baseMetric: null,
  expression: [s("thruplays"), op("/"), s("spend")],
  label: "ThruPlays per dollar",
  description: null,
  format: "decimal",
  polarity: "higher-better",
  archived: true,
};

const renamedReach: CustomMetric = { ...formLeads, id: uuid(4), baseMetric: "reach", label: "People reached" };

const reg = buildRegistry([formLeads, costPerBooking, holdPerSpend, renamedReach]);

describe("a rename", () => {
  it("is its base stat under the agency's name, on its one platform", () => {
    const d = reg.get(customId(formLeads))!;
    expect(d.label).toBe("Form leads");
    expect(d.group).toBe("Custom metrics");
    expect(d.platforms).toEqual(["meta"]);
    expect(d.dims.meta).toEqual(["campaign", "adset", "ad", "creative"]);
    expect(d.custom).toMatchObject({ kind: "rename", base: "fb_onsite_leads" });
    expect(reg.base(customId(formLeads))).toBe("fb_onsite_leads");
  });

  it("computes, points and explains itself as its base does, under its own words", () => {
    const b = bag({ leadsOnsite: 7 });
    expect(reg.value(customId(formLeads), b)).toBe(7);
    expect(reg.polarity(customId(formLeads), "meta")).toBe("higher-better");
    const def = reg.definition(customId(formLeads), "meta")!;
    expect(def.what).toBe("Leads from our Instant Forms.");
    expect(def.caveat).toMatch(/Your agency's name for Meta's “On-Facebook leads”/);
  });

  it("keeps reach a single figure", () => {
    const d = reg.get(customId(renamedReach))!;
    expect(d.series).toEqual([]);
    expect(reg.base(customId(renamedReach))).toBe("reach");
    expect(checkWidget({ kind: "series", platform: "meta", metric: customId(renamedReach), form: "line", compare: false }, reg))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/distinct people/) });
  });
});

describe("a formula", () => {
  it("🔴 is a ratio of the row's sums, never an average of rows", () => {
    const day1 = bag({ spend: 100, funnel: { new_lead: 0, contacted: 0, appointment_booked: 1, showed: 0, no_show: 0, closed_won: 0, lost: 0, disqualified: 0, new_lead_qualified: 0 } });
    const day2 = bag({ spend: 500, funnel: { new_lead: 0, contacted: 0, appointment_booked: 3, showed: 0, no_show: 0, closed_won: 0, lost: 0, disqualified: 0, new_lead_qualified: 0 } });
    const id = customId(costPerBooking);
    expect(reg.value(id, day1)).toBe(100);
    // $600 over 4 bookings = $150 — not the $116.67 average of $100 and $133.33.
    const total = bag({ spend: 600, funnel: { new_lead: 0, contacted: 0, appointment_booked: 4, showed: 0, no_show: 0, closed_won: 0, lost: 0, disqualified: 0, new_lead_qualified: 0 } });
    expect(reg.value(id, total)).toBe(150);
    expect(reg.value(id, day2)).toBeCloseTo(166.67, 2);
  });

  it("gives no value where a stat has none or the divisor is zero", () => {
    expect(reg.value(customId(costPerBooking), bag({ spend: 50 }))).toBeNull(); // no CRM funnel on the row
  });

  it("reaches every platform its stats do, splits only the ways all of them split", () => {
    const d = reg.get(customId(costPerBooking))!;
    expect(d.platforms).toEqual(["meta", "google", "tiktok"]);
    expect(d.dims.meta).toEqual(["campaign"]);
    expect(d.additive).toBe(false);
    expect(d.needs).toEqual(expect.arrayContaining(["ads", "crm"]));
    expect(reg.polarity(customId(costPerBooking), "google")).toBe("lower-better");
    expect(reg.format(customId(costPerBooking))).toBe("currency");
  });

  it("reads Meta's ad rows when any of its stats only lives there", () => {
    expect(reg.fromAdRows(customId(holdPerSpend), "meta")).toBe(true);
    expect(reg.get(customId(holdPerSpend))!.dims.meta).toEqual(["adset", "ad", "creative"]);
  });

  it("describes itself with its own formula", () => {
    expect(reg.definition(customId(costPerBooking), "meta")!.formula).toBe("Ad spend ÷ Appointments");
  });
});

describe("the registry", () => {
  it("🔴 resolves nothing for a metric it does not have — deleted, or another agency's", () => {
    const stranger = `custom:${uuid(99)}` as const;
    expect(reg.get(stranger)).toBeNull();
    expect(BUILTIN.get(customId(formLeads))).toBeNull();
    expect(reg.label(stranger, "meta")).toBe("Deleted metric");
    expect(reg.value(stranger, bag({ spend: 1 }))).toBeNull();
    expect(checkWidget({ kind: "kpi", platform: "meta", metric: stranger }, reg))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/deleted from Settings → Metrics/) });
    expect(defaultTitle({ kind: "kpi", platform: "meta", metric: customId(formLeads) }, reg)).toBe("Form leads");
  });

  it("offers live metrics on their platforms, by name, and an archived one only where it is in use", () => {
    expect(reg.customIds("meta")).toEqual([customId(costPerBooking), customId(formLeads), customId(renamedReach)]);
    expect(reg.customIds("google")).toEqual([customId(costPerBooking)]);
    expect(reg.customIds("meta", [customId(holdPerSpend)])).toContain(customId(holdPerSpend));
  });

  it("drops a formula that no longer reads, rather than guessing", () => {
    const broken = buildRegistry([{ ...costPerBooking, expression: [s("spend"), op("/")] }]);
    expect(broken.get(customId(costPerBooking))).toBeNull();
    const nested = buildRegistry([{ ...costPerBooking, expression: [s(customId(formLeads)), op("+"), s("spend")] }]);
    expect(nested.get(customId(costPerBooking))).toBeNull();
  });
});

describe("validateCustomMetric", () => {
  const draft = (over: Partial<CustomMetricDraft>): CustomMetricDraft => ({
    kind: "formula",
    platform: "meta",
    baseMetric: null,
    expression: [s("spend"), op("/"), s("clicks")],
    label: "Spend per click",
    description: null,
    format: "currency",
    polarity: "lower-better",
    ...over,
  });

  it("accepts a sound rename and a sound formula", () => {
    expect(validateCustomMetric(draft({}), [])).toEqual({ ok: true });
    expect(
      validateCustomMetric(draft({ kind: "rename", baseMetric: "fb_onsite_leads", expression: null, label: "Form leads" }), []),
    ).toEqual({ ok: true });
  });

  it.each([
    [draft({ label: "  " }), "label", /name of 1 to 40/],
    [draft({ label: "x".repeat(41) }), "label", /1 to 40/],
    [draft({ label: "CTR" }), "label", /already a stat on Meta/],
    [draft({ label: "form LEADS" }), "label", /already called “Form leads”/],
    [draft({ description: "x".repeat(281) }), "description", /280/],
    [draft({ kind: "rename", platform: "any", baseMetric: "spend" }), "platform", /Choose the platform/],
    [draft({ kind: "rename", platform: "google", baseMetric: "fb_onsite_leads" }), "baseMetric", /Google does not report/],
    [draft({ expression: [s("spend"), op("/")] }), "expression", /ends where/],
    [draft({ expression: [{ t: "num", v: 2 }] }), "expression", /at least one stat/],
    [draft({ expression: [s(customId(formLeads))] }), "expression", /built-in stats only/],
    [draft({ expression: [s("spend"), op("/"), s("reach")] }), "expression", /distinct people/],
    [draft({ platform: "google", expression: [s("spend"), op("/"), s("fb_onsite_leads")] }), "expression", /Google does not report/],
    [draft({ expression: [s("thruplays"), op("/"), s("leads")] }), "expression", /only reported per ad/],
    [draft({ format: null }), "format", /how the result is shown/],
    [draft({ polarity: null }), "polarity", /higher or lower/],
  ] as Array<[CustomMetricDraft, string, RegExp]>)("refuses %#: %s", (d, field, error) => {
    const v = validateCustomMetric(d, [formLeads]);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.field).toBe(field);
      expect(v.error).toMatch(error);
    }
  });

  it("lets two platforms share a name, but not one platform", () => {
    expect(validateCustomMetric(draft({ platform: "google", label: "Form leads", expression: [s("spend")] }), [formLeads])).toEqual({ ok: true });
  });
});
