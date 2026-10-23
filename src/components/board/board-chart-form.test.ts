import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 The board's charts follow the dashboard's chart rules, and these are the
 * rules a screenshot of one widget cannot show are broken.
 *
 *   One axis. A board makes it easy to ask for two stats at once; the answer
 *   is two widgets, never a second y-scale on one plot.
 *
 *   The ramp in fixed order, without `--series-8` (the status red).
 *
 *   A circle only for parts of a whole, gated on the data, never on the form
 *   alone — a saved donut of a stat that went negative falls back to bars.
 *
 *   Thin marks: bars at most 24px with rounded data ends, 2px lines.
 *
 *   The saved form is the form. Unlike `CategoryChart`, nothing here reads or
 *   writes a remembered preference, or one viewer's click would repaint the
 *   board for the next.
 *
 * Read from source, like `category-chart-form.test.ts`: the suite runs in node
 * with no DOM.
 */

const SRC = readFileSync(join(__dirname, "BoardChart.tsx"), "utf8");

describe("board charts", () => {
  it("🔴 never draws a second y-axis", () => {
    expect(SRC).not.toMatch(/yAxisId/);
    expect(SRC).not.toMatch(/orientation="right"/);
    // One per plot: the series chart, the column chart and the hbar chart.
    expect((SRC.match(/<YAxis\b/g) ?? []).length).toBe(3);
  });

  it("names the ramp once, slots 1 to 7 in order, without the status slot", () => {
    const ramp = SRC.match(/const RAMP = \[([\s\S]*?)\]/)?.[1] ?? "";
    expect([...ramp.matchAll(/--series-(\d)/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(SRC).not.toMatch(/--series-8/);
  });

  it("🔴 gates the circle on the data", () => {
    expect(SRC).toMatch(/const circle = \(form === "pie" \|\| form === "donut"\) && circleAllowed\(rows\)/);
    // Every pie branch reads the gated value, not the requested form.
    expect(SRC).toMatch(/if \(shownForm === "pie" \|\| shownForm === "donut"\)/);
  });

  it("colours slices by entity and bars by one colour", () => {
    expect(SRC).toMatch(/circle \? categorySlots\(dimension, rows\) : barSlots\(dimension, rows\)/);
  });

  it("draws thin marks", () => {
    const bars = [...SRC.matchAll(/<Bar\b[^>]*>/g)].map((m) => m[0]);
    expect(bars.length).toBeGreaterThanOrEqual(3);
    for (const b of bars) expect(b, b).toMatch(/maxBarSize=\{24\}/);
    for (const b of bars) expect(b, b).toMatch(/radius=\{\[/);
    const strokes = [...SRC.matchAll(/strokeWidth=\{([\d.]+)\}/g)].map((m) => Number(m[1]));
    expect(Math.max(...strokes)).toBeLessThanOrEqual(2);
  });

  it("keeps no remembered form", () => {
    expect(SRC).not.toMatch(/localStorage|sessionStorage/);
  });

  it("gives every chart a table a screen reader can read", () => {
    expect((SRC.match(/<table className="sr-only">/g) ?? []).length).toBe(2);
  });
});
