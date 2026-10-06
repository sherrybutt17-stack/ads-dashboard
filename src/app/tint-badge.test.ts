import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 `.tint-badge` — text on a wash of its own colour.
 *
 * The shape is a trap: the wash pulls the GROUND toward the colour the text
 * already is, so the badge eats its own contrast, and it does so quietly. Ten
 * sites had hand-rolled it, and the ones on screen measured 4.25:1 ("✓ mapped"),
 * 4.28 ("not used") and 4.43 ("Auto-map") in dark — wrong, but not wrong-looking.
 *
 * Two things are checked here, because either one alone leaves the hole open:
 * the class's own arithmetic, and that nobody spells the pattern by hand again.
 */

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf8");
const ACCENT_TS = readFileSync(join(ROOT, "src", "lib", "accent.ts"), "utf8");

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
const mix = (a: Rgb, b: Rgb, p: number): Rgb => ({
  r: a.r * p + b.r * (1 - p),
  g: a.g * p + b.g * (1 - p),
  b: a.b * p + b.b * (1 - p),
});

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

/** The two percentages the class actually ships. */
function tintPercents(): { wash: number; ink: number } {
  const rule = CSS.match(/\.tint-badge\s*\{([^}]*)\}/);
  expect(rule, "globals.css no longer defines .tint-badge").toBeTruthy();
  const wash = rule![1].match(
    /background:\s*color-mix\(in srgb,\s*var\(--tint\)\s*(\d+)%,\s*transparent\s*\)/,
  );
  const ink = rule![1].match(
    /color:\s*color-mix\(in srgb,\s*var\(--tint\)\s*(\d+)%,\s*var\(--text-primary\)\s*\)/,
  );
  expect(wash, ".tint-badge no longer washes --tint toward transparent").toBeTruthy();
  expect(ink, ".tint-badge no longer mixes --tint toward --text-primary").toBeTruthy();
  return { wash: Number(wash![1]) / 100, ink: Number(ink![1]) / 100 };
}

const SURFACES = ["--surface-page", "--surface-1", "--surface-2"] as const;
const STATUS = [
  "--status-good",
  "--status-warning",
  "--status-serious",
  "--status-critical",
  "--text-muted",
] as const;
const FLOOR = 4.5;

describe(".tint-badge", () => {
  const perClient = [...ACCENT_TS.matchAll(/color:\s*"(#[0-9a-fA-F]{6})"/g)].map((m) =>
    m[1].toLowerCase(),
  );

  it("re-derives the tints it is checking", () => {
    expect(perClient.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(LIGHT).length).toBeGreaterThan(20);
  });

  it(`🔴 every tint clears ${FLOOR}:1 on its own wash, on every surface`, () => {
    const { wash, ink } = tintPercents();
    const failures: string[] = [];
    for (const [themeName, theme] of [
      ["light", LIGHT],
      ["dark", DARK],
    ] as const) {
      const primary = parse(resolve(theme, "--text-primary"));
      const tints = [
        ...STATUS.map((t) => [t, resolve(theme, t)] as const),
        ["--violet-500", resolve(theme, "--violet-500")] as const,
        ...perClient.map((c) => ["accent", c] as const),
      ];
      for (const [name, hex] of tints) {
        const tint = parse(hex);
        const fg = mix(tint, primary, ink);
        for (const surf of SURFACES) {
          // color-mix(X w%, transparent) over a surface composites to X at
          // alpha w on that surface.
          const bg = mix(tint, parse(resolve(theme, surf)), wash);
          const r = contrast(fg, bg);
          if (r < FLOOR) {
            failures.push(`${themeName}: ${name} ${hex} on its own wash over ${surf} = ${r.toFixed(2)}:1`);
          }
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("🔴 keeps enough of the tint that the badge still reads as its colour", () => {
    // Mixed too far toward the ink and "✓ mapped" is grey text on a grey pill.
    expect(tintPercents().ink).toBeGreaterThanOrEqual(0.6);
  });
});

/* ------------------------------------------------------------------ */

const SRC = join(ROOT, "src");
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const TOKEN = /var\(--(?:accent|status-(?:good|warning|serious|critical)|text-muted)\)/g;

describe("nobody hand-rolls a tint badge", () => {
  const files = tsxFiles(SRC);

  it("walks a plausible number of files", () => {
    // Without this the scan below passes vacuously if the walk breaks.
    expect(files.length).toBeGreaterThan(40);
  });

  it("🔴 no element sets `color: X` over a wash of the same X", () => {
    const found: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("%, transparent)")) return;
        const washTokens = new Set(line.match(TOKEN) ?? []);
        if (!washTokens.size) return;
        // A `color:` within a few lines naming the same token is the defect.
        const from = Math.max(0, i - 6);
        for (let j = from; j < Math.min(lines.length, i + 7); j++) {
          if (j === i) continue;
          const l = lines[j];
          if (!/\bcolor:/.test(l)) continue;
          // Other properties legitimately reuse the token as a border or glow.
          if (/background|boxShadow|border|fill|stroke/.test(l)) continue;
          if ((l.match(TOKEN) ?? []).some((t) => washTokens.has(t))) {
            found.push(
              `${file.slice(ROOT.length + 1)}:${i + 1}  wash and ink are both ${[...washTokens][0]}`,
            );
            break;
          }
        }
      });
    }
    expect(
      found,
      "Use .tint-badge with an inline --tint; a raw token on a wash of itself " +
        "measures as low as 4.25:1 and looks completely deliberate:\n  " +
        found.join("\n  "),
    ).toEqual([]);
  });
});
