import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Status colours must be readable on the surface they land on.
 *
 * 🔴 Computed, never eyeballed. The previous set survived because it looked
 * fine to whoever picked it: --status-warning #fab219 measured **1.65:1** on
 * the light --surface-2 — an alarm the reader cannot see — and --status-critical
 * 3.30:1 on the dark one, which is the colour carrying "this data is missing,
 * not zero". Both passed review for years because nobody ran the arithmetic.
 *
 * Contrast is a closed formula, so there is no excuse for a judgement call
 * here. This parses the real CSS rather than a copy of the values, so the test
 * cannot pass against numbers that are no longer shipped.
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
 * Bounded by the next `}` at the scope's own indentation so the light `:root`
 * does not swallow the dark blocks that follow it.
 */
function scope(startMarker: string): Record<string, string> {
  const from = CSS.indexOf(startMarker);
  expect(from, `globals.css no longer contains ${startMarker}`).toBeGreaterThan(-1);
  const body = CSS.slice(from, CSS.indexOf("\n}", from));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

const LIGHT = scope(":root {");
const DARK_MEDIA = scope(':root:where(:not([data-theme="light"])) {');
const DARK_TOGGLE = scope(':root[data-theme="dark"] {');

const STATUS = [
  "--status-good",
  "--status-warning",
  "--status-serious",
  "--status-critical",
] as const;

const SURFACES = ["--surface-page", "--surface-1", "--surface-2"] as const;

/** AA for normal-size text. These tokens are overwhelmingly `color:`. */
const FLOOR = 4.5;

/**
 * A dark scope inherits anything it does not restate, so its effective value is
 * its own declaration falling back to light's.
 */
const resolve = (dark: Record<string, string>, name: string) =>
  dark[name] ?? LIGHT[name];

describe("status colour contrast", () => {
  it("parses the scopes it is checking", () => {
    // Without this the loops below can pass vacuously on an empty map.
    expect(Object.keys(LIGHT).length).toBeGreaterThan(20);
    expect(Object.keys(DARK_MEDIA).length).toBeGreaterThan(20);
    expect(Object.keys(DARK_TOGGLE).length).toBeGreaterThan(20);
  });

  for (const [themeName, theme] of [
    ["light", LIGHT],
    ["dark (media query)", DARK_MEDIA],
    ["dark (theme toggle)", DARK_TOGGLE],
  ] as const) {
    it(`🔴 every status colour clears ${FLOOR}:1 on every ${themeName} surface`, () => {
      const failures: string[] = [];
      for (const status of STATUS) {
        const fg = resolve(theme, status);
        expect(fg, `${status} is not declared in ${themeName} or in :root`).toBeTruthy();
        for (const surface of SURFACES) {
          const bg = resolve(theme, surface);
          const ratio = contrast(fg, bg);
          if (ratio < FLOOR) {
            failures.push(
              `${status} ${fg} on ${surface} ${bg} = ${ratio.toFixed(2)}:1`,
            );
          }
        }
      }
      expect(
        failures,
        `Unreadable status text in ${themeName}. These tokens are ~110 \`color:\` ` +
          `declarations across the app, so this is the AA text floor, not the 3:1 ` +
          `graphical one:\n  ${failures.join("\n  ")}`,
      ).toEqual([]);
    });
  }

  it("🔴 a status colour is never the same value as a delta colour", () => {
    /*
     * Recorded on --delta-good in the CSS: it was lifted off #0ca30c precisely
     * because a green delta and a green health dot rendered identically. A
     * status alarm ("we cannot reach Meta") and a metric moving the wrong way
     * ("leads fell 8%") are different events, and one of them is actionable
     * infrastructure while the other is just the week.
     */
    for (const [themeName, theme] of [
      ["light", LIGHT],
      ["dark (media query)", DARK_MEDIA],
      ["dark (theme toggle)", DARK_TOGGLE],
    ] as const) {
      const deltas = new Set(
        ["--delta-good", "--delta-bad"].map((d) => resolve(theme, d)),
      );
      for (const status of STATUS) {
        expect(
          deltas.has(resolve(theme, status)),
          `${status} and a --delta-* token are the same colour in ${themeName}`,
        ).toBe(false);
      }
    }
  });

  it("🔴 the two dark scopes declare identical status values", () => {
    // The media query covers the OS setting and the [data-theme] scope covers
    // the in-app toggle. Drift means the toggle silently changes an alarm's
    // colour, which is the kind of thing nobody notices until it is wrong.
    for (const status of STATUS) {
      expect(DARK_MEDIA[status], status).toBe(DARK_TOGGLE[status]);
    }
  });
});
