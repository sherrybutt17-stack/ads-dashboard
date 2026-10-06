import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 Two cascade traps in globals.css, both of which shipped silently.
 *
 * The file opens with `@import "tailwindcss"` and wraps none of its own rules
 * in `@layer`, so every component rule here is UNLAYERED — and unlayered CSS
 * beats anything in a layer on a tie, whatever the source order. Tailwind's
 * `rounded-*` utilities live in `@layer utilities`. So a bare `border-radius`
 * on a component class in globals.css does not set a default that call sites
 * can override; it sets a value they cannot reach.
 *
 * `.skeleton` had `border-radius: 6px`. Every placeholder in the loading screen
 * asked for its own shape — a pill for the segmented control, `--radius-xl` for
 * the chart blocks, an asymmetric corner for the notched panel — and every one
 * of them rendered as a 6px rectangle. Confirmed in a real browser, where a
 * `.skeleton rounded-full` probe computed to 6px.
 *
 * The focus ring had the mirror-image problem within the file itself. It is
 * `:where(...):focus-visible`, so it carries the specificity of `:focus-visible`
 * alone — a tie with any single class — and it sits below `.btn-accent`. Its
 * `border-radius: 4px` therefore won, and keyboard-focusing the primary button
 * snapped its corners from 12px to 4px. An outline already follows the
 * element's own border-radius, so the declaration bought nothing.
 *
 * Neither shows up in a typecheck, a lint or a render test. So this checks.
 */

const SRC = join(__dirname, "..");
const GLOBALS = join(__dirname, "globals.css");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(entry)) out.push(p);
  }
  return out;
}

/** The body of a rule, given the exact selector line that opens it. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} is no longer declared in globals.css`).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", at);
  return css.slice(at, end);
}

describe("skeleton shape", () => {
  it("leaves the radius to the call site", () => {
    const body = ruleBody(readFileSync(GLOBALS, "utf8"), ".skeleton");
    expect(
      /border-radius/.test(body),
      ".skeleton sets border-radius again — being unlayered, it will override " +
        "every rounded-* utility at the call sites instead of defaulting them.",
    ).toBe(false);
  });

  it("is given a shape everywhere it is used", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        // Only className literals — prose mentioning the word is not a call site.
        const m = line.match(/className="([^"]*\bskeleton\b[^"]*)"/);
        if (m && !/\brounded-/.test(m[1])) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}  ${m[1]}`);
        }
      });
    }
    expect(
      offenders,
      "a .skeleton with no rounded-* class renders as a sharp rectangle:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

describe("focus ring", () => {
  it("does not reshape what it lands on", () => {
    const body = ruleBody(
      readFileSync(GLOBALS, "utf8"),
      ":where(a, button, input, select, textarea, [tabindex]):focus-visible",
    );
    expect(/outline:/.test(body), "the focus ring lost its outline").toBe(true);
    expect(
      /border-radius/.test(body),
      "the focus ring sets border-radius again — it outranks every component " +
        "class declared above it, so focusing will change the element's shape.",
    ).toBe(false);
  });
});
