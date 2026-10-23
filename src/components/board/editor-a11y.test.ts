import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 The board editor has to be usable without a mouse, and none of what makes
 * it so shows up in a screenshot.
 *
 *   Every drag has a keyboard twin. The drag handle is a real button; arrow
 *   keys move the widget and Shift with an arrow resizes it, and the widget
 *   menu repeats both in words. A canvas that only drags is a canvas a
 *   keyboard or switch user cannot arrange at all.
 *
 *   Every change is said out loud — an `aria-live` region, because a widget
 *   that silently jumped three rows has, for a screen-reader user, vanished.
 *
 *   Only the handle drags. Without that, a click on a sort button or a chart
 *   inside a widget would nudge it instead of doing what it says.
 *
 *   The menu is a menu: portalled (grid items are transformed, which would
 *   capture a fixed panel), Escape closes it and returns focus, arrows walk it.
 *
 * And two facts about where the grid library may live: it loads in the editor
 * only, client-side only, and at one exact version — 2.x is the line that
 * stopped calling `findDOMNode`, which React 19 removed.
 *
 * Read from source, like the chart-form tests: the suite runs in node.
 */

const DIR = __dirname;
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

const EDITOR = read("BoardEditor.tsx");
const CANVAS = read("BoardCanvasRgl.tsx");
const MENU = read("WidgetMenu.tsx");
const PICKER = read("WidgetPicker.tsx");

describe("board editor accessibility", () => {
  it("🔴 makes the drag handle a labelled button with a keyboard path", () => {
    // To the closing tag: the opening one contains `=>`, which ends a `[^>]` scan early.
    const handle = EDITOR.match(/<button\s+type="button"\s+className="board-drag-handle[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(handle, "no drag-handle button").not.toBe("");
    expect(handle).toContain('type="button"');
    expect(handle).toMatch(/aria-label=\{`Move or resize \$\{title\}`\}/);
    expect(handle).toContain("aria-describedby={HINT_ID}");
    expect(handle).toContain("onKeyDown={(e) => onHandleKey(e, w)}");
  });

  it("🔴 moves on the arrow keys and resizes with Shift", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(EDITOR, `${key} is not handled`).toContain(`${key}:`);
    }
    expect(EDITOR).toMatch(/if \(e\.shiftKey\) resize\(w, step\[0\], step\[1\]\);\s*else move\(w, step\[0\], step\[1\]\);/);
    // And the hint that says so exists, under the id the handles point at.
    expect(EDITOR).toMatch(/<p id=\{HINT_ID\} className="sr-only">/);
  });

  it("🔴 announces every change", () => {
    expect(EDITOR).toMatch(/<div aria-live="polite" className="sr-only">\s*\{said\}/);
    // Each kind of change sets the announcement.
    for (const phrase of ["moved to row", "columns wide", "Added ", "Removed ", "Duplicated ", "Updated "]) {
      expect(EDITOR, `nothing announces "${phrase}"`).toContain(phrase);
    }
  });

  it("asks before a tab is closed on unsaved changes", () => {
    expect(EDITOR).toMatch(/window\.addEventListener\("beforeunload"/);
    expect(EDITOR).toMatch(/if \(!dirty\) return;/);
  });

  it("explains itself below laptop width instead of offering a cramped canvas", () => {
    expect(EDITOR).toMatch(/className="card[^"]*lg:hidden"/);
    expect(EDITOR).toContain('className="hidden lg:block"');
  });

  it("🔴 drags by the handle only", () => {
    expect(CANVAS).toMatch(/dragConfig=\{\{ handle: "\.board-drag-handle"/);
  });

  it("🔴 portals the widget menu and makes it a real menu", () => {
    expect(MENU).toContain("<Portal>");
    expect(MENU).toContain("useDismissOnEscape(open, close, trigger)");
    expect(MENU).toContain('role="menu"');
    expect(MENU).toContain('role="menuitem"');
    expect(MENU).toContain('aria-haspopup="menu"');
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(MENU, `${key} does not move through the menu`).toContain(`"${key}"`);
    }
  });

  it("repeats every arrangement in the menu, in words", () => {
    for (const label of ["Move up", "Move down", "Move left", "Move right", "Wider", "Narrower", "Taller", "Shorter"]) {
      expect(MENU).toContain(`label: "${label}"`);
    }
  });

  it("shows impossible choices disabled, with the reason", () => {
    expect(PICKER).toMatch(/<option key=\{m\} value=\{m\} disabled=\{Boolean\(block\)\}>/);
    expect(PICKER).toContain("title={verdict.ok ? undefined : verdict.reason}");
  });
});

describe("the grid library", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
    }
    return out;
  }

  it("🔴 is imported by the canvas module alone", () => {
    const importers = walk(join(process.cwd(), "src"))
      .filter((f) => /from "react-grid-layout/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(process.cwd().length + 1));
    expect(importers).toEqual(["src/components/board/BoardCanvasRgl.tsx"]);
  });

  it("🔴 loads client-side only, from the editor", () => {
    expect(EDITOR).toMatch(/dynamic\(\(\) => import\("\.\/BoardCanvasRgl"\), \{\s*ssr: false/);
  });

  it("is pinned to an exact 2.x version", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.dependencies["react-grid-layout"]).toMatch(/^2\.\d+\.\d+$/);
  });
});
