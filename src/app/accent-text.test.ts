import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 `.accent-text` and `.accent-fill` must clear AA on every accent, in both
 * themes.
 *
 * Both are `color-mix(in srgb, var(--accent) N%, var(--text-primary))` and the
 * whole justification of each is a number. For .accent-text the worst case
 * across the seven accents the app can carry is 4.08:1 light / 4.05:1 dark
 * unmixed, 4.38/4.38 at N=95, 4.73/4.68 at N=90 and 5.09/5.06 at N=85. Nothing
 * stops someone nudging N up to make the colour "pop" — at which point the rule
 * silently stops doing its job while still looking exactly like a considered
 * choice.
 *
 * So this parses N out of the shipped CSS and recomputes the mix, rather than
 * asserting the comment. It also re-derives the accent list from lib/accent.ts,
 * so adding a seventh per-client hue is checked the day it lands.
 */

const CSS = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
const ACCENT_TS = readFileSync(join(process.cwd(), "src", "lib", "accent.ts"), "utf8");

type Rgb = { r: number; g: number; b: number };

const parse = (hex: string): Rgb => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

function luminance({ r, g, b }: Rgb): number {
  const ch = [r, g, b]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `color-mix(in srgb, A p%, B)` — the sRGB interpolation the browser does. */
const mix = (a: Rgb, b: Rgb, p: number): Rgb => ({
  r: Math.round(a.r * p + b.r * (1 - p)),
  g: Math.round(a.g * p + b.g * (1 - p)),
  b: Math.round(a.b * p + b.b * (1 - p)),
});

/** The declarations inside one scope, bounded by the next `}` at its own depth. */
function scope(marker: string): Record<string, string> {
  const from = CSS.indexOf(marker);
  expect(from, `globals.css no longer contains ${marker}`).toBeGreaterThan(-1);
  const body = CSS.slice(from, CSS.indexOf("\n}", from));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

const LIGHT = scope(":root {");
const DARK = scope(':root[data-theme="dark"] {');
const resolve = (s: Record<string, string>, n: string) => s[n] ?? LIGHT[n];

/** The mix percentage the stylesheet actually ships for one of the two rules. */
function mixRatio(rule: "accent-text" | "accent-fill"): number {
  const m = CSS.match(
    new RegExp(
      `\\.${rule}\\s*\\{[^}]*color-mix\\(in srgb,\\s*var\\(--accent\\)\\s*(\\d+)%,\\s*var\\(--text-primary\\)\\s*\\)`,
    ),
  );
  expect(m, `.${rule} no longer mixes --accent toward --text-primary`).toBeTruthy();
  return Number(m![1]) / 100;
}
const accentTextRatio = () => mixRatio("accent-text");

const FLOOR = 4.5;

describe(".accent-text", () => {
  const perClient = [...ACCENT_TS.matchAll(/color:\s*"(#[0-9a-fA-F]{6})"/g)].map((m) =>
    m[1].toLowerCase(),
  );

  it("re-derives the accent list it is checking", () => {
    // Without this the loop below can pass vacuously on an empty list.
    expect(perClient.length).toBeGreaterThanOrEqual(6);
  });

  it(`🔴 clears ${FLOOR}:1 on every accent in both themes`, () => {
    const p = accentTextRatio();
    const failures: string[] = [];
    for (const [themeName, theme] of [
      ["light", LIGHT],
      ["dark", DARK],
    ] as const) {
      const ink = parse(resolve(theme, "--text-primary"));
      const card = parse(resolve(theme, "--surface-1"));
      // The house violet is what a page with no client in scope inherits.
      const accents = [resolve(theme, "--violet-500"), ...perClient];
      for (const a of accents) {
        const ratio = contrast(mix(parse(a), ink, p), card);
        if (ratio < FLOOR) {
          failures.push(
            `${themeName}: ${Math.round(p * 100)}% of ${a} on ${resolve(theme, "--surface-1")} = ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
    expect(
      failures,
      `.accent-text is not readable. It exists precisely because a raw --accent ` +
        `measures ~4.1:1 as text; a mix that fails is worse than no rule, because ` +
        `it looks deliberate:\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });

  it("🔴 keeps enough of the accent to still read as the accent", () => {
    // The other way this rule dies: mixed so far toward the ink that the
    // emphasis tile's eyebrow is just grey text and the accent is decorative.
    expect(accentTextRatio()).toBeGreaterThanOrEqual(0.6);
  });
});

/*
 * 🔴 The inverse rule. .accent-fill paints the accent as a BACKGROUND and puts
 * --accent-ink on it, so the pair it has to clear is ink-on-mix, not
 * mix-on-surface. It fails in both themes unmixed — 4.08:1 light (#6a6ff0) and
 * 4.47:1 dark (#aa5cc4) — which is the whole reason the rule exists, so the
 * same "someone nudges N" failure mode applies and is checked the same way.
 */
describe(".accent-fill", () => {
  const perClient = [...ACCENT_TS.matchAll(/color:\s*"(#[0-9a-fA-F]{6})"/g)].map((m) =>
    m[1].toLowerCase(),
  );

  it(`🔴 --accent-ink clears ${FLOOR}:1 on the mixed fill in both themes`, () => {
    const p = mixRatio("accent-fill");
    const failures: string[] = [];
    for (const [themeName, theme] of [
      ["light", LIGHT],
      ["dark", DARK],
    ] as const) {
      const primary = parse(resolve(theme, "--text-primary"));
      const ink = parse(resolve(theme, "--accent-ink"));
      for (const a of [resolve(theme, "--violet-500"), ...perClient]) {
        const fill = mix(parse(a), primary, p);
        const ratio = contrast(ink, fill);
        if (ratio < FLOOR) {
          failures.push(
            `${themeName}: --accent-ink ${resolve(theme, "--accent-ink")} on ${Math.round(p * 100)}% of ${a} = ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("🔴 keeps enough of the accent to still read as the client's colour", () => {
    // A pressed range button mixed too far toward the ink is just a grey chip,
    // and the per-client accent stops meaning anything.
    expect(mixRatio("accent-fill")).toBeGreaterThanOrEqual(0.6);
  });
});
