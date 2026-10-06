import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 `CategoryChart` is the ONE chart on the dashboard, rendered a dozen times.
 *
 * Breakdowns, campaigns, creatives, fatigue, lead sources, budget delivery,
 * keep/stop and the quality splits all mount it. That is the point — a reader
 * who learns to read one panel's chart can read every panel's chart, and a
 * swatch means the same thing wherever it appears. It also means a mistake in
 * this file is a mistake on every tab at once, which is why the invariants are
 * tested here rather than trusted to review.
 *
 * Six things hold the line, and every one of them is invisible in a screenshot
 * of any single chart in any single form:
 *
 *   The switcher changes the MARK and nothing else. All three forms plot the
 *   same `points`: same order, same folding, same colours. A form that re-sorted
 *   or re-folded would turn a view preference into two different readings of one
 *   dataset, which is worse than not shipping the control.
 *
 *   Colour follows the datum, never the form. The ramp is named once; a mark
 *   that reached into the series ramp itself could drift from the legend
 *   sitting underneath it.
 *
 *   `--series-8` is never in the ramp. It is the status red, and a category that
 *   happens to land eighth must not read as the alarming one.
 *
 *   The circle is gated, and a stale preference falls back rather than blanking.
 *   A pie of values that include a refund is not a pie; a reader who chose the
 *   circle last month should get a bar this month, not an empty frame.
 *
 *   A legend is always rendered, with the value beside the name. Identity is
 *   never colour alone, and the circle form is otherwise unreadable without
 *   hovering every slice.
 *
 *   Print takes no switch. `fixedWidth` is how the report and the deck mount
 *   this, and a PDF whose charts depend on what the exporter last clicked is not
 *   reproducible.
 *
 * Like `trend-chart-form.test.ts`, this reads the source rather than rendering
 * it: the suite runs in `node` with no DOM, and these are structural facts about
 * the file, which is where the mistakes would be made.
 */

const SRC = readFileSync(join(__dirname, "CategoryChart.tsx"), "utf8");

/** The form ids, read from the component rather than restated here. */
const FORMS = [...SRC.matchAll(/\{\s*id:\s*"(\w+)",\s*label:\s*"[^"]+"\s*\}/g)].map(
  (m) => m[1],
);

/** One recharts element, from its opening tag to its matching close. */
function markBlock(tag: string): string {
  const start = SRC.indexOf(`<${tag}`);
  expect(start, `no <${tag}> in the component`).toBeGreaterThan(-1);
  const end = SRC.indexOf(`</${tag}>`, start);
  expect(end, `unclosed <${tag}>`).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("category chart forms", () => {
  it("offers exactly bar, line and circle", () => {
    expect(FORMS).toEqual(["bar", "line", "pie"]);
  });

  it("validates a remembered preference against the declared forms", () => {
    /*
     * localStorage is writable by anything on the origin and survives a rename
     * of the form ids. Every render branch below is an equality test, so an
     * unvalidated read puts an unknown string into `form` and NOTHING draws —
     * an empty frame with a working switcher, which is the quietest possible
     * failure.
     */
    const guard = SRC.match(/function isCategoryForm[\s\S]*?\n}/)?.[0];
    expect(guard, "no isCategoryForm type guard").toBeTruthy();
    for (const f of FORMS) {
      expect(guard, `isCategoryForm does not accept "${f}"`).toContain(`"${f}"`);
    }

    const snapshot = SRC.match(/const getSnapshot = useCallback\([\s\S]*?\n {2}\}/)?.[0];
    expect(snapshot, "no getSnapshot").toBeTruthy();
    expect(snapshot).toContain("localStorage.getItem");
    expect(
      snapshot,
      "the stored value reaches state without passing the type guard",
    ).toContain("isCategoryForm");
  });

  it("draws every form from the one prepared array", () => {
    // Folding, ordering and colouring happen once, above the ternary.
    expect(SRC).toContain("<BarChart data={points}");
    expect(SRC).toContain("<LineChart data={points}");
    expect(SRC).toContain("data={points}"); // the <Pie>

    for (const tag of ["BarChart", "LineChart", "PieChart"]) {
      const block = markBlock(tag);
      for (const op of [".sort(", ".slice(", ".filter(", ".reduce("]) {
        expect(
          block.includes(op),
          `the ${tag} branch re-derives its data with ${op} — the switcher must change the mark only`,
        ).toBe(false);
      }
    }
  });

  it("takes colour from the datum, never from the mark", () => {
    for (const tag of ["BarChart", "LineChart", "PieChart"]) {
      expect(
        markBlock(tag).includes("var(--series-"),
        `the ${tag} branch names a ramp colour itself; the ramp is assigned once, above`,
      ).toBe(false);
    }
  });

  it("keeps the status red out of the categorical ramp", () => {
    const ramp = SRC.match(/const RAMP = \[[\s\S]*?\] as const;/)?.[0];
    expect(ramp, "no RAMP").toBeTruthy();
    expect(
      ramp,
      "--series-8 is the status red and must never index a category",
    ).not.toContain("--series-8");
  });

  it("gates the circle and falls back rather than blanking", () => {
    // A circle needs a whole: no negatives, and something to divide.
    const guard = SRC.match(/function canBeCircle[\s\S]*?\n}/)?.[0];
    expect(guard, "no canBeCircle guard").toBeTruthy();
    expect(guard).toContain("< 0");

    // The switcher only offers what the data can be…
    expect(SRC).toMatch(/const allowed: CategoryForm\[\] = circleOk \?/);
    // …and a preference remembered from a period where it was legal degrades.
    expect(
      SRC,
      "a stale pie preference must fall back to a form, not render nothing",
    ).toContain('stored === "pie" && !circleOk ? "bar"');
  });

  it("always renders a legend carrying name and value", () => {
    /*
     * Taken from after the mark ternary: the legend must not sit inside a form
     * branch, or the circle — the one form with no axis labels — could lose it.
     */
    const afterChart = SRC.slice(SRC.lastIndexOf("</BarChart>"));
    expect(afterChart).toContain("points.map");
    expect(afterChart).toContain("{p.label}");
    expect(afterChart).toContain("{format(p.value)}");
    expect(afterChart).toContain("background: p.color");
  });

  it("gives print one deterministic form", () => {
    // `fixedWidth` is the report/deck mount. The switcher is suppressed there.
    const switchAt = SRC.indexOf("<FormSwitch");
    expect(switchAt).toBeGreaterThan(-1);
    const guardAt = SRC.lastIndexOf("{!fixedWidth && (", switchAt);
    expect(
      guardAt,
      "the form switcher is rendered without a !fixedWidth guard — an exported PDF would depend on what was last clicked",
    ).toBeGreaterThan(-1);
    expect(SRC.slice(guardAt, switchAt)).not.toContain("</div>");
  });
});
