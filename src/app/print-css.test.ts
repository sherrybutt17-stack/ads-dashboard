import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The print theme pin, verified as a property of the stylesheet rather than as
 * a claim in a comment.
 *
 * Context: `data-theme` is stamped on `<html>` before first paint and defaults
 * to DARK, so without this pin a reader who hits Cmd-P gets `#0a0b0f` across
 * every sheet. The pin works by CSS cascade rules that are easy to state and
 * easy to break silently:
 *
 *   `:root[data-theme="dark"]` is specificity (0,2,0) in BOTH the normal and
 *   the print block. A media query adds nothing. So the print block wins ONLY
 *   because it is later in the file — and someone appending a new rule below it
 *   next month has no way of knowing that.
 *
 * These tests fail in exactly the two ways that matter: the block moving, and a
 * new dark token being introduced without a paper value.
 */

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** The body of a top-level block, matched by brace counting rather than regex —
 *  these blocks nest, and `[\s\S]*?}` stops at the first inner brace. */
function blockAt(startIndex: number): string {
  const open = CSS.indexOf("{", startIndex);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced braces in globals.css");
}

function customProps(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

const printStart = CSS.indexOf("@media print");
const darkStart = CSS.indexOf(':root[data-theme="dark"] {');
const printBlock = blockAt(printStart);
const darkBlock = blockAt(darkStart);

describe("print stylesheet", () => {
  it("has an @media print block at all", () => {
    expect(printStart).toBeGreaterThan(-1);
  });

  it("declares the pin for the explicit dark scope, not just :root", () => {
    // `:root` alone is (0,1,0) and loses to `:root[data-theme="dark"]` at
    // (0,2,0) — the pin would apply to nobody who has ever used the toggle.
    expect(printBlock).toContain(':root[data-theme="dark"]');
  });

  it("comes AFTER the dark block, which is the only reason it wins", () => {
    expect(darkStart).toBeGreaterThan(-1);
    expect(printStart).toBeGreaterThan(darkStart);
  });

  it("is the LAST rule in the file, so nothing appended can outrank it", () => {
    // Anything after the print block that re-declares a dark token at equal
    // specificity would silently take the page back to black.
    const after = CSS.slice(printStart + printBlock.length);
    expect(after).not.toMatch(/:root\[data-theme="dark"\]\s*\{/);
  });

  it("re-declares EVERY token the dark theme sets", () => {
    // The drift guard. Adding `--surface-3` to the dark block without a paper
    // value leaves one dark surface on an otherwise white page — the kind of
    // defect nobody finds until a client prints something.
    const missing = [...customProps(darkBlock)].filter(
      (p) => !customProps(printBlock).has(p),
    );
    expect(missing).toEqual([]);
  });

  it("forces backgrounds to print rather than letting the browser save ink", () => {
    // The funnel, the heatmap and the delta chips encode meaning in fill; a
    // browser dropping backgrounds would erase the encoding, not just the style.
    expect(printBlock).toContain("print-color-adjust: exact");
  });

  it("kills the entrance animation", () => {
    /*
     * `main > *` animates with `animation-fill-mode: both`, which holds
     * `opacity: 0` until each element's delay elapses. Print rasterises the
     * animation state as-is, so a fast Cmd-P can commit blank white sheets.
     */
    expect(CSS).toMatch(/@keyframes rise/);
    expect(printBlock).toMatch(/main\s*>\s*\*\s*\{[^}]*animation:\s*none/);
    expect(printBlock).toMatch(/main\s*>\s*\*\s*\{[^}]*opacity:\s*1/);
  });

  it("un-clips horizontally scrolling tables", () => {
    // On screen `.table-scroll` scrolls; on paper it CLIPS, and the columns
    // past the fold are gone with nothing to indicate it.
    expect(printBlock).toMatch(/\.table-scroll\s*\{[^}]*overflow:\s*visible/);
  });

  it("ships .print-only hidden by default", () => {
    // Otherwise page footers and print-only definitions leak onto the screen.
    const afterPrint = CSS.slice(printStart + printBlock.length);
    expect(afterPrint).toMatch(/\.print-only\s*\{\s*display:\s*none/);
  });
});
