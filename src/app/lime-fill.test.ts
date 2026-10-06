import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * 🔴 Lime is a FILL, and never type.
 *
 * It is legible in exactly one arrangement and catastrophic in the obvious
 * alternatives, measured on the shipped values:
 *
 *   #bef264 carrying #16161d ink     13.78:1   the only arrangement that works
 *   #bef264 AS text on --surface-1    1.31:1   invisible
 *   #bef264 as a ring on the page     1.08:1   invisible
 *
 * That 1.31 is the trap, because a lime heading does not LOOK broken in a
 * review screenshot on a bright laptop — it looks like a tasteful accent. It
 * is unreadable, and it is unreadable in both themes, since `--lime` is held
 * identical across them on purpose: a house colour that shifted with the theme
 * would make the same button read as two different brands.
 *
 * So there is no "--lime-ink" in the sense `--series-N-ink` is one. `--lime-on`
 * is the ink that sits ON the fill — near-black — and it is the only member of
 * the family that may legally appear as a `color:`. This test fails the build
 * if `--lime` or `--lime-hover` is ever set as type, in the stylesheet or at a
 * call site.
 *
 * Scope note: this is a static check over source text, which means it holds the
 * DIRECT sites. An indirection — a token name stored in a map and read back
 * through a variable — is out of its window, the same limitation `fill-ink`
 * documents for its own pattern.
 */

const SRC = join(process.cwd(), "src");
const CSS = join(SRC, "app", "globals.css");

/**
 * `--lime` and `--lime-hover`, and specifically NOT `--lime-on`.
 *
 * The closing paren is load-bearing: `var(--lime-on)` contains the literal
 * `var(--lime`, so a prefix match would flag the one usage that is correct and
 * flag it everywhere, which is the fastest way to get a test deleted.
 */
const FILL = /var\(--lime(?:-hover)?\)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe("lime is a fill", () => {
  it("is never a color: in the stylesheet", () => {
    const offenders: string[] = [];
    readFileSync(CSS, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // `-color` catches border-color / background-color; only the bare
        // `color:` property sets type.
        const m = line.match(/(?:^|[;{\s])color:\s*([^;]+)/);
        if (m && FILL.test(m[1])) offenders.push(`globals.css:${i + 1}  ${line.trim()}`);
      });
    expect(
      offenders,
      "lime set as type measures 1.31:1 on --surface-1 — use --lime-on, " +
        "which is the ink that goes ON the fill:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("is never a text colour at a call site", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const where = `${relative(SRC, file)}:${i + 1}`;
          // The two house forms: an inline style object, and a Tailwind
          // arbitrary value. Both are how every other colour is set here.
          const inline = line.match(/\bcolor:\s*"([^"]+)"/);
          if (inline && FILL.test(inline[1])) offenders.push(`${where}  ${line.trim()}`);
          if (/\btext-\[var\(--lime(?:-hover)?\)\]/.test(line)) {
            offenders.push(`${where}  ${line.trim()}`);
          }
        });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("pairs the fill with its own ink wherever it is painted", () => {
    /*
     * The other half of the rule. A lime background is only safe because
     * `--lime-on` rides with it, and the two places that paint one — the
     * sidebar's current-page pill and the house action button — are the two
     * that must say so. A lime fill with no ink beside it inherits whatever
     * the surrounding theme is setting, which in dark mode is near-white:
     * 1.5:1, the same button, unreadable, for half the operators.
     */
    /*
     * Comments stripped first. A rule's "selector" here is everything since the
     * previous closing brace, and every rule worth checking in this file is
     * introduced by a block comment — leave them in and the selector reads as
     * two paragraphs of prose, which no prefix comparison below can match.
     */
    const css = readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    /*
     * Every rule that paints lime, found by what it DOES rather than by name.
     * Anchoring on `.btn-lime {` looked right and was not: that selector also
     * opens the geometry block it shares with `.btn-accent`, which sets no
     * colour at all, so the check passed over a rule that could never have
     * failed it.
     */
    const painted = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
      new RegExp(`background(?:-color)?:\\s*${FILL.source}`).test(m[2]),
    );

    expect(
      painted.length,
      "nothing paints --lime any more — the sidebar pill and the house " +
        "action button are the two that should",
    ).toBeGreaterThanOrEqual(2);

    /*
     * The ink does not have to be on the SAME rule — a `:hover` variant repaints
     * the fill and inherits the colour from the base rule it modifies, which is
     * how `.btn-lime:hover` is written and how it should be. So a painted rule
     * passes if it sets `--lime-on` itself, or if a rule whose selector it
     * extends does.
     */
    const inked = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[2].includes("color: var(--lime-on)"))
      .flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")));

    const naked = painted
      .map((m) => m[1].trim().replace(/\s+/g, " "))
      .filter((sel) => !inked.some((base) => sel.startsWith(base)));

    expect(
      naked,
      "a lime fill with no --lime-on inherits the surrounding theme's ink, " +
        "which in dark mode is near-white on lime at 1.5:1:\n" + naked.join("\n"),
    ).toEqual([]);
  });
});
