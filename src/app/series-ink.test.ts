import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 A colour tuned for a MARK is not a colour you can set type in.
 *
 * `--series-N` is picked for a 2px line or a filled bar — a shape with area,
 * judged against the 3:1 non-text floor. Text is judged against 4.5:1, and the
 * gap between those two floors is where this whole file lives. Run the light
 * ramp as body copy and SIX OF EIGHT hues fail: `--series-4` amber measures
 * 2.17:1 on white, `--series-3` aqua 2.82:1, `--series-2` orange 3.20:1. Only
 * `--series-6` and `--series-7` clear the bar, and one of those only just.
 *
 * That failure is invisible in review. The heading is the right hue, it sits
 * where you expect, and nothing about a washed-out amber heading looks like a
 * defect — it looks like a design choice. So the section-heading colour comes
 * from a SECOND ramp, `--series-N-ink`, which holds each hue and moves only
 * lightness until the result clears 4.5:1 as text.
 *
 * Two ramps only work if they stay related. `--series-2-ink` must still read as
 * "the orange one" beside an orange bar, or the wayfinding it exists for breaks:
 * see `SectionHue` in lib/dashboard/registry.ts. So this measures both halves —
 * that the ink is readable, and that it is still the same hue as its mark.
 *
 * Computed, never eyeballed, and parsed out of the shipped stylesheet so the
 * test cannot pass against values that are no longer served.
 */

const CSS = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Hue in degrees and saturation as a fraction, HSL. */
function hueSat(hex: string): { hue: number; sat: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  if (hue < 0) hue += 360;
  const light = (max + min) / 2;
  return { hue, sat: d === 0 ? 0 : d / (1 - Math.abs(2 * light - 1)) };
}

/** Shortest distance between two hue angles, in degrees. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The declarations inside one scope, as a name → hex map.
 *
 * `end` bounds the slice at the scope's own closing brace: the light `:root`
 * closes at column 0, the print block's `:root` is nested one level and closes
 * indented, and slicing to the wrong one silently merges two scopes into a map
 * where every assertion below still passes.
 */
function scope(marker: string, end = "\n}"): Record<string, string> {
  const from = CSS.indexOf(marker);
  expect(from, `globals.css no longer contains ${marker}`).toBeGreaterThan(-1);
  const body = CSS.slice(from, CSS.indexOf(end, from));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

const PRINT_ROOT = CSS.indexOf(':root[data-theme="light"] {', CSS.indexOf("@media print"));

/**
 * All four places the ramp is declared.
 *
 * Dark is written twice on purpose — once for the OS setting, once for the
 * in-app toggle — and print re-declares the light values under BOTH dark
 * selectors so a page printed from dark mode still comes out on white paper.
 * Four copies, maintained by hand; css-vars.test.ts holds the two dark scopes
 * to the same KEYS, and this holds all four to readable VALUES.
 */
const SCOPES = [
  { name: "light", vars: scope(":root {") },
  { name: "dark (media query)", vars: scope(':root:where(:not([data-theme="light"])) {') },
  { name: "dark (toggle)", vars: scope(':root[data-theme="dark"] {') },
  { name: "print", vars: scope(CSS.slice(PRINT_ROOT, PRINT_ROOT + 27), "\n  }") },
] as const;

const N = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * Both grounds a section heading can land on: a card (`--surface-1`) and the
 * banded ground behind it (`--surface-2`). Checking only the card is how
 * --text-muted once shipped at 4.34:1 on the ground carrying most of the copy.
 */
const SURFACES = ["--surface-1", "--surface-2"] as const;

/** WCAG AA for normal-size text. Section headings are ~19px regular weight. */
const FLOOR = 4.5;

/**
 * The floor the ramp was actually tuned to, which is deliberately above AA.
 *
 * A value sitting at 4.50 passes today and fails the moment someone nudges a
 * surface a step lighter — and surfaces get nudged. The margin is the point.
 */
const TUNED_FLOOR = 4.7;

describe("series ink ramp", () => {
  it("parses all four scopes and finds a complete ramp in each", () => {
    // Anti-rot. Every loop below iterates the parsed map, so a broken marker or
    // regex makes the entire file pass while measuring nothing.
    expect(PRINT_ROOT).toBeGreaterThan(0);
    for (const { name, vars } of SCOPES) {
      expect(Object.keys(vars).length, `${name} parsed almost nothing`).toBeGreaterThan(20);
      for (const n of N) {
        expect(vars[`--series-${n}-ink`], `${name} is missing --series-${n}-ink`).toMatch(
          /^#[0-9a-f]{6}$/,
        );
        expect(vars[`--series-${n}`], `${name} is missing --series-${n}`).toMatch(
          /^#[0-9a-f]{6}$/,
        );
      }
      for (const s of SURFACES) {
        expect(vars[s], `${name} is missing ${s}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }

    /*
     * Four slices, not one slice read four times.
     *
     * Every marker above is a substring search, and a marker that stops
     * matching lands on the FIRST `:root {` in the file — the light one. Each
     * scope then holds a perfectly valid, perfectly readable light ramp, and
     * all twelve assertions below pass while the dark and print ramps go
     * entirely unmeasured. These three grounds differ between the scopes by
     * design, so they are what proves the slices are distinct.
     */
    const [light, darkMedia, darkToggle, print] = SCOPES.map((s) => s.vars);
    expect(darkMedia["--surface-1"], "dark media query read the light scope").not.toBe(
      light["--surface-1"],
    );
    expect(darkToggle["--surface-1"], "dark toggle read the light scope").not.toBe(
      light["--surface-1"],
    );
    expect(print["--surface-2"], "print read the light scope").not.toBe(
      light["--surface-2"],
    );
  });

  for (const { name, vars } of SCOPES) {
    it(`🔴 every ${name} ink clears ${FLOOR}:1 on both surfaces`, () => {
      const bad: string[] = [];
      for (const n of N) {
        const ink = vars[`--series-${n}-ink`];
        for (const s of SURFACES) {
          const r = contrast(ink, vars[s]);
          if (r < FLOOR) {
            bad.push(`--series-${n}-ink ${ink} on ${s} ${vars[s]} = ${r.toFixed(2)}:1`);
          }
        }
      }
      expect(bad, bad.join("\n")).toEqual([]);
    });

    it(`keeps ${name} ink above the ${TUNED_FLOOR}:1 it was tuned to`, () => {
      const thin: string[] = [];
      for (const n of N) {
        const ink = vars[`--series-${n}-ink`];
        for (const s of SURFACES) {
          const r = contrast(ink, vars[s]);
          if (r < TUNED_FLOOR) {
            thin.push(`--series-${n}-ink ${ink} on ${s} = ${r.toFixed(2)}:1`);
          }
        }
      }
      expect(
        thin,
        "still AA, but with no headroom left — darken it rather than shipping a " +
          "value that a one-step surface tweak pushes under 4.5:\n" + thin.join("\n"),
      ).toEqual([]);
    });

    it(`keeps ${name} ink the same hue as its mark`, () => {
      const drifted: string[] = [];
      for (const n of N) {
        const mark = hueSat(vars[`--series-${n}`]);
        const ink = hueSat(vars[`--series-${n}-ink`]);
        const dh = hueGap(mark.hue, ink.hue);
        const ds = Math.abs(mark.sat - ink.sat);
        // The shipped ramp holds hue to 0.3° and saturation to 0.6pp — only
        // lightness moves. These bounds pass that comfortably and still catch
        // an ink swapped for a neighbouring hue.
        if (dh > 2) drifted.push(`--series-${n}-ink is ${dh.toFixed(1)}° off its mark`);
        if (ds > 0.02) {
          drifted.push(
            `--series-${n}-ink is ${(ds * 100).toFixed(1)}pp off its mark's saturation`,
          );
        }
      }
      expect(
        drifted,
        "ink must read as the same colour as the bars beneath it — hold hue and " +
          "saturation, move only lightness:\n" + drifted.join("\n"),
      ).toEqual([]);
    });
  }

  it("all four scopes declare the whole ramp rather than inheriting it", () => {
    /*
     * A scope that omits `--series-4-ink` inherits the light one, which is a
     * near-black amber on a near-black dark surface. It is not a missing colour
     * -- it is a heading that disappears, in exactly one theme.
     */
    const missing: string[] = [];
    for (const { name, vars } of SCOPES) {
      for (const n of N) {
        if (!vars[`--series-${n}-ink`]) missing.push(`${name}: --series-${n}-ink`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("🔴 is not redundant — the mark ramp genuinely fails as text", () => {
    /*
     * The obvious "simplification" is to delete this ramp and point headings at
     * `--series-N`. This is the measurement that says no. If it ever goes green
     * -- because the mark ramp was darkened for some other reason — then the
     * second ramp really has become dead weight and should go, but that is a
     * decision someone makes on purpose, not a thing that drifts.
     */
    const light = SCOPES[0].vars;
    const failing = N.filter((n) => contrast(light[`--series-${n}`], light["--surface-1"]) < FLOOR);
    expect(
      failing.length,
      `only ${8 - failing.length} of 8 mark colours are unreadable as text on ` +
        `--surface-1; if that is now zero, --series-N-ink has no reason to exist`,
    ).toBeGreaterThanOrEqual(5);
  });
});
