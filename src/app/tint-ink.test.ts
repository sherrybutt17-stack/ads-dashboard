import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 A pastel card is a GROUND, and a ground has to hold the worst ink on it.
 *
 * The `--tint-*` family paints the four KPI cards at the top of the roll-up.
 * Unlike `--series-N`, which is a mark judged against the 3:1 non-text floor,
 * every tint carries type: a 12px label in --text-secondary, a 26px figure in
 * --text-primary, and an 11.5px caption in --text-muted. The caption is the
 * binding constraint and it is the one nobody checks, because it is the line
 * you stop reading after the first week — which is exactly how a card ships
 * looking deliberate while its supporting line is unreadable.
 *
 * So this measures every tint against every ink that lands on it, in all four
 * scopes, parsed out of the shipped stylesheet. A tint tuned in the light
 * theme and inverted by eye for the dark one is the normal way this breaks:
 * the dark tints are not the light ones darkened, they were walked toward the
 * dark theme's ink until they cleared the floor.
 *
 * Deliberately NOT reused from `--series-*`. Those hues carry categorical
 * identity inside a chart, and painting a card in one would put a data colour
 * on a non-data object — `series-palette.test.ts` enforces that separation
 * from the other side.
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

/**
 * The declarations inside one scope, as a name → hex map.
 *
 * `end` bounds the slice at the scope's own closing brace: the light `:root`
 * closes at column 0 while the print block's `:root` is nested one level and
 * closes indented. Slicing to the wrong one silently merges two scopes into a
 * map where every assertion below still passes.
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

const PRINT_ROOT = CSS.indexOf(
  ':root[data-theme="light"] {',
  CSS.indexOf("@media print"),
);

const SCOPES = [
  { name: "light", vars: scope(":root {") },
  {
    name: "dark (media query)",
    vars: scope(':root:where(:not([data-theme="light"])) {'),
  },
  { name: "dark (toggle)", vars: scope(':root[data-theme="dark"] {') },
  { name: "print", vars: scope(CSS.slice(PRINT_ROOT, PRINT_ROOT + 27), "\n  }") },
] as const;

const TINTS = ["violet", "blue", "mint", "amber"] as const;

/** Every ink `BookKpis` puts on a tint, worst last. */
const INKS = ["--text-primary", "--text-secondary", "--text-muted"] as const;

/**
 * Above AA on purpose — the same margin `--series-N-ink` was tuned to.
 *
 * A value sitting at exactly 4.50 passes today and fails the moment someone
 * nudges a text token one step lighter, and text tokens get nudged. The
 * headroom is the point, not a rounding allowance.
 */
const FLOOR = 4.75;

describe("KPI card tints", () => {
  it("declares the whole family, and its inks, in all four scopes", () => {
    /*
     * Anti-rot. Every loop below iterates the parsed maps, so a broken marker
     * or regex would make this entire file pass while measuring nothing.
     */
    expect(PRINT_ROOT).toBeGreaterThan(0);

    for (const { name, vars } of SCOPES) {
      expect(
        Object.keys(vars).length,
        `${name} parsed almost nothing — the scope marker has moved`,
      ).toBeGreaterThan(20);
      for (const t of TINTS) {
        expect(vars[`--tint-${t}`], `${name} is missing --tint-${t}`).toMatch(
          /^#[0-9a-f]{6}$/,
        );
      }
      for (const ink of INKS) {
        expect(vars[ink], `${name} is missing ${ink}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }

    /*
     * Distinct slices, not one slice read four times. Each marker is a
     * substring search, and one that stops matching lands on the FIRST
     * `:root {` in the file — the light one — so a scope would silently be
     * measured against the wrong palette and agree with itself.
     *
     * Three palettes, not four: the two dark scopes ARE meant to be byte-identical
     * (the test below is what holds them that way), so they are compared as one.
     */
    const distinct = [SCOPES[0], SCOPES[1], SCOPES[3]];
    const seen = new Set(distinct.map((s) => JSON.stringify(s.vars)));
    expect(
      seen.size,
      "light, dark and print did not parse as three different palettes — " +
        "a scope marker has stopped matching",
    ).toBe(distinct.length);
  });

  it("holds every ink above the floor on every tint, in every scope", () => {
    const failures: string[] = [];
    for (const { name, vars } of SCOPES) {
      for (const t of TINTS) {
        const ground = vars[`--tint-${t}`];
        for (const ink of INKS) {
          const r = contrast(vars[ink], ground);
          if (r < FLOOR) {
            failures.push(
              `${name}: ${ink} on --tint-${t} is ${r.toFixed(2)}:1 (need ${FLOOR})`,
            );
          }
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("keeps the two dark scopes identical", () => {
    /*
     * The OS setting and the in-app toggle are two hand-maintained copies of
     * one palette. A tint fixed in one and not the other means the same card
     * reads differently depending on how the reader arrived at dark mode,
     * which is unreproducible by whoever reports it.
     */
    const media = SCOPES[1].vars;
    const toggle = SCOPES[2].vars;
    for (const t of TINTS) {
      expect(toggle[`--tint-${t}`], `--tint-${t} differs between dark scopes`).toBe(
        media[`--tint-${t}`],
      );
    }
  });
});
