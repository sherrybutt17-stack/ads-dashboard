import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 Every rounded corner comes from the radius scale.
 *
 * Before this there were thirteen distinct hard-coded radii — 3, 4, 5, 6, 7, 8,
 * 9, 10, 11, 12, 13, 14, 20 — across 188 call sites, because each component
 * picked the number that looked right in isolation. Nothing was broken, which
 * is exactly why it survived: an 8px card beside a 10px card beside a 9px
 * button reads as slightly unfinished and never as a bug worth filing.
 *
 * A scale only holds if new code cannot leave it, and nothing else in the build
 * complains about `rounded-[11px]`. So this does.
 *
 * The exception is deliberate and narrow: a corner at 4px or below is a
 * DRAWING, not a control — heatmap cells, tick marks, the 3px swatch in a
 * legend — where the radius is a hairline softening rather than a step on the
 * scale, and rounding it to 7px would visibly turn squares into lozenges.
 */

const SRC = join(__dirname, "..");
const GLOBALS = join(__dirname, "globals.css");

/** Corners at or below this are drawings; see above. */
const DRAWING_MAX = 4;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    // This file quotes the offending spellings in prose; scanning it would
    // flag itself.
    else if (/\.tsx?$/.test(entry) && entry !== "radius-scale.test.ts") out.push(p);
  }
  return out;
}

describe("radius scale", () => {
  it("declares every step", () => {
    const css = readFileSync(GLOBALS, "utf8");
    for (const step of [
      "--radius-frame",
      "--radius-xl",
      "--radius-lg",
      "--radius",
      "--radius-sm",
      "--radius-xs",
    ]) {
      expect(
        new RegExp(`\\n\\s*${step}:\\s*\\d+px;`).test(css),
        `${step} is no longer declared in globals.css`,
      ).toBe(true);
    }
  });

  it("has no hard-coded corner above the drawing floor", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        // Corner-specific spellings count too: `rounded-r-[5px]` is a corner.
        for (const m of line.matchAll(/rounded-(?:[a-z]{1,2}-)?\[(\d+)px\]/g)) {
          if (Number(m[1]) > DRAWING_MAX) {
            offenders.push(
              `${file.slice(SRC.length + 1)}:${i + 1}  ${m[0]} — use a scale token instead`,
            );
          }
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  /*
   * 🔴 The named utilities are the trap the bracket check above cannot see.
   *
   * Tailwind resolves `rounded-lg` to `var(--radius-lg)`, and since :root
   * redefines that token, the utility lands on the scale for free. It is easy to
   * assume that holds for the whole family. It does not, in two ways, and both
   * shipped: bare `rounded` is a LITERAL `0.25rem` that never reads a token at
   * all, so thirty-one controls had 4px corners; and `rounded-md` reads
   * `--radius-md`, which the scale does not declare, so it fell through to
   * Tailwind's own 6px on five more. Both were measured in a browser.
   *
   * So a named utility is allowed only when the token it reads is one the scale
   * declares. `rounded-full` is exempt — a pill is a shape, not a step.
   */
  it("uses no named radius utility that falls off the scale", () => {
    const css = readFileSync(GLOBALS, "utf8");
    const declared = (step: string) =>
      new RegExp(`\\n\\s*--radius-${step}:\\s*\\d+px;`).test(css);

    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        for (const cls of line.matchAll(/className="([^"]*)"/g)) {
          for (const m of cls[1].matchAll(/(?:^|\s)rounded(?:-([a-z0-9]+))?(?=\s|$)/g)) {
            const step = m[1];
            const where = `${file.slice(SRC.length + 1)}:${i + 1}`;
            if (step === "full" || step === "none") continue;
            if (!step) {
              offenders.push(
                `${where}  rounded — a literal 0.25rem, not var(--radius); name a step`,
              );
            } else if (!declared(step)) {
              offenders.push(
                `${where}  rounded-${step} — --radius-${step} is not on the scale`,
              );
            }
          }
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
