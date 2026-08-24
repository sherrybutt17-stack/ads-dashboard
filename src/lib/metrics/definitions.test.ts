import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { METRIC_DEFINITIONS, definitionFor } from "./definitions";
import { COLUMNS } from "./table-columns";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Negative-space tests: they fail for metrics nobody thought to document.
 *
 * Reading the source rather than importing it — these live in client components
 * whose imports (React, next/link, an icon set) have no business being pulled
 * into a unit test to check a lookup table. The regexes are anchored on the
 * exact literal shapes used in those files, so a rename breaks the test loudly
 * rather than silently matching nothing (guarded by the count assertions).
 */
describe("metric definitions cover what the UI renders", () => {
  it("defines every column in the report tables", () => {
    // Imported, not regexed: the column set moved to a pure module when the
    // client/server boundary bug was fixed, which makes it directly testable.
    const undocumented = COLUMNS.map((c) => c.key).filter((k) => !definitionFor(k));
    expect(undocumented).toEqual([]);
    expect(COLUMNS.length).toBeGreaterThan(15);
  });

  it("defines every headline KPI tile", () => {
    // Lives in the section registry's renderer since the page was decomposed.
    // The `length > 5` guard below is what caught that move rather than letting
    // the test quietly pass on zero matches.
    const src = read("src/lib/dashboard/sections.tsx");
    const keys = [...src.matchAll(/metricKey="(\w+)"/g)].map((m) => m[1]);

    expect(keys.length).toBeGreaterThan(5);
    const undocumented = keys.filter((k) => !definitionFor(k));
    expect(undocumented).toEqual([]);
  });
});

describe("the definitions themselves", () => {
  /*
   * The reason this whole module exists: three rates sit in one row, render
   * identically, and divide by three different things. If a formula ever stops
   * naming its denominator, the trap comes straight back.
   */
  it("names the denominator on each of the three conversion rates", () => {
    expect(METRIC_DEFINITIONS.bookPct.formula).toMatch(/NEW LEADS/);
    expect(METRIC_DEFINITIONS.showPct.formula).toMatch(/APPOINTMENTS/);
    expect(METRIC_DEFINITIONS.closePct.formula).toMatch(/SHOWS/);
  });

  it("warns explicitly that show rate is not a share of leads", () => {
    // The specific misreading: "62% of my leads showed up".
    expect(METRIC_DEFINITIONS.showPct.caveat).toMatch(/NOT leads/);
  });

  it("keeps the non-additive reach warning attached to reach", () => {
    expect(METRIC_DEFINITIONS.reach.caveat).toMatch(/NOT additive/);
  });

  it("says every stage count is distinct-people-entering, not raw movements", () => {
    for (const key of [
      "new_lead",
      "contacted",
      "appointment_booked",
      "showed",
      "closed_won",
    ]) {
      expect(METRIC_DEFINITIONS[key].caveat).toMatch(/distinct people ENTERING/i);
    }
  });

  it("gives every definition a formula and a plain-language statement", () => {
    for (const [key, def] of Object.entries(METRIC_DEFINITIONS)) {
      expect(def.what, `${key}.what`).toBeTruthy();
      expect(def.formula, `${key}.formula`).toBeTruthy();
      // A formula that is just the metric's own name explains nothing.
      expect(def.formula.length, `${key}.formula too short`).toBeGreaterThan(12);
    }
  });
});
