import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * 🔴 A label on a themed fill must wear a themed ink.
 *
 * Fourteen buttons and badges painted `text-white` (or `color: "#fff"`) on a
 * `var(--accent)` or `var(--status-*)` background. That is correct in light and
 * wrong in dark, because every one of those tokens flips to a LIGHT value when
 * the theme flips — while a hard-coded white does not flip at all. Measured on
 * the shipped values: white on the dark --status-warning is 1.83:1, on the dark
 * --status-critical 2.78:1, on the dark --accent 3.23:1. All three read as a
 * pale label dissolving into a pale button.
 *
 * Nothing about this is visible in a light-theme screenshot, and no type or
 * lint rule covers it, so it is exactly the kind of thing that ships. The fix
 * is --accent-ink / --status-ink, which flip with their fills;
 * status-contrast.test.ts proves those two tokens clear AA on every fill they
 * can land on. This test proves the call sites actually reach for them.
 *
 * Only a FLAT fill is flagged — a background whose whole value is the token.
 * Two things are deliberately out of scope:
 *
 *   A fixed brand fill. TikTok's #000000 is the same colour in both themes and
 *   gives white 21:1, so white on it is right and stays right.
 *
 *   Meta's blue sat on this line too, on the unexamined assumption that a brand
 *   colour must be safe. It was not: white on the headline #1877F2 measures
 *   4.23:1, and a contrast sweep of the rendered /c/[slug]/setup found it —
 *   after this exemption had kept it out of the test's sight for as long as it
 *   had shipped. It now uses #166FE5 (4.73:1), Meta's own hover step. The
 *   exemption is from the TOKEN rule — a brand fill cannot flip with the theme
 *   and should not pretend to — and never from the contrast floor.
 *
 *   A gradient anchored in a dark colour. The client monogram tiles run
 *   `linear-gradient(135deg, var(--accent), color-mix(var(--accent) 50%,
 *   #0d1b30))`, and the glyph sits over the centre of that ramp, not over the
 *   accent. Measured there across all eight accents in both themes, white
 *   never drops below 4.84:1 — it is the correct ink and the token would be
 *   wrong. A gradient's readable ink depends on where the label lands, which
 *   is not something a regex can know.
 *
 * The cost of that precision: an indirection like HealthChecklist's
 * `background: m.color`, where the token is named in a map further up the file,
 * is out of the window and will not be caught. Those sites are correct today;
 * this test holds the direct ones.
 */

const SRC = join(process.cwd(), "src");

/**
 * A flat themed fill.
 *
 * Matching is line-aware rather than anchored to `background:`, because both
 * halves of this pattern are routinely written as ternaries —
 * `background: done ? "var(--status-good)" : "var(--surface-2)"` — which an
 * anchored regex walks straight past. A line counts when it mentions
 * `background` AND contains the token as a COMPLETE quoted value.
 *
 * "Complete quoted value" is what keeps gradients out. The monogram tiles set
 * `background: "linear-gradient(135deg, var(--accent) 0%, …)"`, where the token
 * appears inside a longer string; a gradient's readable ink depends on where
 * the label lands on the ramp, which is not something a regex can know.
 */
const TOKEN = "(?:accent|status-(?:good|warning|serious|critical)|text-muted)";
const FLAT_VALUE = new RegExp(
  `"var\\(--${TOKEN}\\)"|"var\\(--brand,\\s*var\\(--accent\\)\\)"`,
);
const UTILITY_FILL = new RegExp(`\\bbg-\\[var\\(--${TOKEN}\\)\\]`);

const isThemedFill = (line: string) =>
  UTILITY_FILL.test(line) || (line.includes("background") && FLAT_VALUE.test(line));

/*
 * The label side, matched the same way and for the same reason: one site spells
 * it `color: done ? "#fff" : "var(--text-secondary)"`, so the literal is the
 * signal, not its adjacency to `color:`.
 */
const HARD_WHITE = /\btext-white\b|"#(?:fff|ffffff)"/;

const WINDOW = 6;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(entry)) out.push(p);
  }
  return out;
}

describe("ink on a themed fill", () => {
  const files = walk(SRC);

  it("finds the components it is scanning", () => {
    // Without this the scan below passes vacuously if the walk ever breaks.
    expect(files.length).toBeGreaterThan(40);
  });

  it("🔴 no hard-coded white label sits on a token that flips with the theme", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!HARD_WHITE.test(line)) return;
        const from = Math.max(0, i - WINDOW);
        if (lines.slice(from, i + WINDOW + 1).some(isThemedFill)) {
          offenders.push(`${relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 96)}`);
        }
      });
    }
    expect(
      offenders,
      `A hard-coded white label on a fill that flips to a light value in dark ` +
        `mode. Use text-[var(--accent-ink)] or text-[var(--status-ink)]:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
