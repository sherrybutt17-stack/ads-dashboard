import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 The chart-form switcher changes the MARK. It must not change anything else.
 *
 * Area, line and bar are three ways of drawing one series, and the reason a
 * reader is allowed to switch between them is that switching costs them nothing:
 * the same numbers, the same axes, the same scale, the same previous-period
 * comparison. The moment a form quietly re-scales an axis or re-shapes the
 * ghost, the control stops being a view preference and becomes a way to reach
 * two different readings of the same data — which is worse than not shipping it.
 *
 * Four things hold that line, and all four are invisible in a screenshot of any
 * single form:
 *
 *   The ghost stays a dashed Line in every form. Paired bars would read as two
 *   live series rather than one and its shadow, and a comparison that changes
 *   shape with the thing it is compared to is not a comparison.
 *
 *   Every form draws the same `dataKey` in the same `color`. A mark is a shape,
 *   not an identity — spend is blue whether it is an area, a line or a bar.
 *
 *   Print takes no switch. The report and the deck pass `fixedWidth`, and a PDF
 *   whose charts depend on what the person who exported it last clicked is not
 *   reproducible. Paper gets one deterministic form.
 *
 *   A remembered preference is validated before it becomes state. localStorage
 *   is writable by anything on the origin and survives a rename of the form
 *   ids, so an unvalidated read puts an unknown string into `form` — and every
 *   branch below is an equality test, so NOTHING renders. An empty plot frame
 *   with working axes is the quietest possible failure.
 *
 * This reads the component source rather than rendering it: the suite runs in
 * `node` with no DOM, and these are structural facts about the file, which is
 * where the mistakes would be made.
 */

const SRC = readFileSync(join(__dirname, "TrendCharts.tsx"), "utf8");

/** The three form ids, read from the component rather than restated here. */
const FORMS = [...SRC.matchAll(/\{\s*id:\s*"(\w+)",\s*label:\s*"[^"]+"\s*\}/g)].map(
  (m) => m[1],
);

/** The `{form === "x" && ( ... )}` block for one form, brace-matched. */
function markBlock(form: string): string {
  const start = SRC.indexOf(`{form === "${form}" && (`);
  expect(start, `no render branch for the "${form}" form`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after the "${form}" branch`);
}

/**
 * The previous-period mark, and the JSX condition that gates it.
 *
 * Anchored on `dataKey={prevKey}` — the one thing that MAKES a mark the ghost —
 * rather than on the text of its condition. An earlier version matched the
 * literal `{prevKey && (`, so it stopped finding the ghost the moment anyone
 * edited that line, which is precisely the edit it exists to catch: it reported
 * a missing ghost instead of a gated one. Anchoring on `strokeDasharray`
 * instead was worse — it matched CartesianGrid, which is also dashed.
 *
 * It also has to start inside the chart: `prevKey` gates the panel LEGEND
 * higher up too, and matching that one asserted things about a row of <span>s
 * while the ghost went unchecked.
 */
function ghost(): { mark: string; guard: string } {
  const body = SRC.slice(SRC.indexOf("<ComposedChart"));
  const key = body.indexOf("dataKey={prevKey}");
  expect(key, "nothing inside the chart draws prevKey — the ghost is gone")
    .toBeGreaterThan(-1);

  const open = body.lastIndexOf("<", key);
  const close = body.indexOf("/>", key);
  const guardStart = body.lastIndexOf("{", open);
  expect(guardStart, "the ghost is not inside a JSX condition").toBeGreaterThan(-1);

  return { mark: body.slice(open, close + 2), guard: body.slice(guardStart, open) };
}

describe("trend chart form switcher", () => {
  it("finds the component and all three forms", () => {
    // Anti-rot: every assertion below is driven by these, so a regex that stops
    // matching turns the whole file green while checking nothing.
    expect(SRC.length).toBeGreaterThan(5000);
    expect(FORMS).toEqual(["area", "line", "bar"]);
  });

  it("🔴 draws the previous period as a dashed line in every form", () => {
    const { mark, guard } = ghost();
    expect(mark.startsWith("<Line"), `the ghost is no longer a <Line>: ${mark.slice(0, 40)}`)
      .toBe(true);
    expect(mark).toMatch(/strokeDasharray/);
    expect(guard).toMatch(/prevKey/);
    expect(
      guard.includes("form"),
      "the ghost is now gated on `form` — it must draw the same way in all " +
        `three, or the comparison moves with the thing being compared: ${guard.trim()}`,
    ).toBe(false);
  });

  it("🔴 every form draws the same series in the same colour", () => {
    const wrong: string[] = [];
    for (const form of FORMS) {
      const block = markBlock(form);
      if (!/dataKey=\{dataKey\}/.test(block)) {
        wrong.push(`"${form}" does not draw {dataKey}`);
      }
      // Area and line stroke it; bar fills it. Either way it is `color`.
      if (!/(stroke|fill)=\{color\}/.test(block)) {
        wrong.push(`"${form}" does not paint with {color}`);
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("🔴 hides the switcher wherever the output is printed", () => {
    expect(
      SRC,
      "the switcher must be gated on `fixedWidth`, which only the report and " +
        "deck set — an exported PDF cannot depend on a stored click",
    ).toMatch(/\{!fixedWidth && <FormSwitch/);
  });

  it("🔴 validates a remembered preference before trusting it", () => {
    const hook = SRC.slice(SRC.indexOf("function useChartForm"));
    const body = hook.slice(0, hook.indexOf("\n}\n"));

    expect(body).toMatch(/getItem\(FORM_KEY\)/);
    expect(
      body,
      "a value read back from localStorage reaches setForm without passing " +
        "isChartForm — an unknown string matches no branch and the plot " +
        "renders empty",
    ).toMatch(/if\s*\(isChartForm\([^)]*\)\)\s*setForm/);

    // Both accessors throw outright in a locked-down or private-mode browser,
    // which would take the whole dashboard down rather than one preference.
    expect(body.match(/catch/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("keys the legend to the mark on screen", () => {
    const legend = SRC.slice(SRC.indexOf("{prevKey && ("), SRC.indexOf("<ComposedChart"));
    expect(
      legend,
      "the 'This period' swatch no longer depends on `form`, so the legend " +
        "draws a line beside a bar chart",
    ).toMatch(/form === "bar"/);
  });

  it("defaults to a form that renders without a stored preference", () => {
    const m = SRC.match(/useState<ChartForm>\("(\w+)"\)/);
    expect(m, "useChartForm no longer has a literal default").not.toBeNull();
    expect(
      FORMS,
      `the default "${m?.[1]}" is not one of the switcher's forms, so a first ` +
        "visit renders no mark at all",
    ).toContain(m?.[1]);
  });
});
