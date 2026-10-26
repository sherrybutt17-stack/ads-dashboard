import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 🔴 A board document is always light, as the PDF is.
 *
 * The share link, the print view and the PDF are one component
 * (`BoardDocument`), and the PDF is printed — light. A reader whose dashboard
 * is set to dark would otherwise open a shared board looking nothing like the
 * PDF of it. The `.paper` rule re-declares, at its light value, every token
 * the dark theme changes; this keeps it equal to `:root` when either moves.
 */

const CSS = readFileSync(join(__dirname, "globals.css"), "utf8");
const DOC = readFileSync(join(__dirname, "..", "components", "board", "BoardDocument.tsx"), "utf8");

/** The declarations of the rule whose selector starts at `selector`, comments removed. */
function rule(selector: string): Record<string, string> {
  const at = CSS.indexOf(selector);
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = CSS.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  return out;
}

const LIGHT = rule(":root {");
const DARK = rule(':root[data-theme="dark"] {');
const PAPER = rule("\n.paper {");

describe("the paper theme", () => {
  it("🔴 declares every token the dark theme changes, at its light value", () => {
    const dark = Object.keys(DARK);
    expect(dark.length).toBeGreaterThan(50);
    for (const token of dark) {
      expect(PAPER[token], `${token} is not reset to light on paper`).toBe(LIGHT[token]);
    }
  });

  it("asks for light form controls and scrollbars too", () => {
    const at = CSS.indexOf("\n.paper {");
    expect(CSS.slice(at, CSS.indexOf("}", at))).toContain("color-scheme: light;");
  });

  it("still gives way to the print colours, which come later in the file", () => {
    const paperAt = CSS.indexOf("\n.paper {");
    const printAt = CSS.indexOf("@media print");
    expect(printAt).toBeGreaterThan(paperAt);
    const printRule = CSS.slice(printAt, CSS.indexOf("{", CSS.indexOf(":root,", printAt)));
    expect(printRule).toMatch(/:root\[data-theme="light"\],\s*\.paper\s*$/);
  });

  it("🔴 is what every board document is drawn on", () => {
    expect(DOC).toContain('className="paper flex min-h-full flex-1 flex-col"');
    expect(DOC).toContain('background: "var(--surface-page)"');
  });
});
