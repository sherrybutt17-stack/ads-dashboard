import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A dismissal catcher must never be able to paint over the thing it dismisses.
 *
 * ── The bug this exists to stop coming back ───────────────────────────
 *
 * `DateRangePicker` renders a full-screen click-catcher so that clicking away
 * closes the calendar. That catcher was portalled to <body> on its own, for a
 * real reason recorded in the file: it lives inside the sticky header, whose
 * `backdrop-filter` makes the header the containing block for fixed
 * descendants, so in place the catcher covered only the header strip.
 *
 * `backdrop-filter` also opens a STACKING CONTEXT, and that is the half that
 * bit. The calendar left behind was `z-30` inside a header painted at `z-10`,
 * while the portalled catcher sat at `z-20` in the ROOT context — above the
 * entire header, calendar included. So the catcher covered the calendar and
 * swallowed every click on it. Pressing "‹" to go back a month dismissed the
 * popover instead of paging it, which made the calendar impossible to navigate
 * and put every date before the current month out of reach. A client with a
 * dormant ad account could not open the only range that had any data in it.
 *
 * Nothing catches this: it typechecks, it builds, it renders, and it looks
 * correct in a screenshot. Only clicking it reveals the fault, and the two
 * halves that disagree are in different files.
 *
 * The invariant: if a component portals a full-screen catcher, the overlay that
 * catcher belongs to must be portalled with it, so both land in the same
 * stacking context and plain z-order decides which is on top.
 */

const DIR = join(process.cwd(), "src/components");

function sources(): Array<{ name: string; text: string }> {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));
}

/** The text between <Portal> and </Portal>, concatenated. */
function portalBodies(text: string): string {
  return [...text.matchAll(/<Portal>([\s\S]*?)<\/Portal>/g)]
    .map((m) => m[1])
    .join("\n");
}

describe("portalled overlays", () => {
  it("🔴 keeps a dialog in the same portal as its click-catcher", () => {
    const offenders: string[] = [];

    for (const { name, text } of sources()) {
      const inPortal = portalBodies(text);
      // Only files that actually portal a full-screen catcher are in scope.
      if (!/fixed inset-0/.test(inPortal)) continue;
      // …and only those that also own a dialog.
      if (!/role="dialog"/.test(text)) continue;

      const dialogsInPortal = (inPortal.match(/role="dialog"/g) ?? []).length;
      const dialogsTotal = (text.match(/role="dialog"/g) ?? []).length;
      if (dialogsInPortal < dialogsTotal) {
        offenders.push(
          `${name}: ${dialogsTotal - dialogsInPortal} dialog(s) outside the portal holding the catcher`,
        );
      }
    }

    expect(
      offenders,
      "A portalled `fixed inset-0` catcher sits in the root stacking context. " +
        "A dialog left behind in a header with `backdrop-filter` is trapped in " +
        "that header's context and paints UNDER the catcher however high its " +
        "z-index, so every click on it dismisses instead of working:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("🔴 does not position a portalled dialog with `absolute`", () => {
    // A portalled node's offset parent is the document, so `absolute right-0`
    // silently resolves against the page rather than the trigger — the popover
    // lands in the corner instead of under the button that opened it.
    const offenders: string[] = [];
    for (const { name, text } of sources()) {
      const inPortal = portalBodies(text);
      if (!inPortal.trim()) continue;
      for (const m of inPortal.matchAll(/className="([^"]*\babsolute\b[^"]*)"/g)) {
        offenders.push(`${name}: "${m[1]}"`);
      }
    }
    expect(offenders, offenders.join("\n  ")).toEqual([]);
  });
});
