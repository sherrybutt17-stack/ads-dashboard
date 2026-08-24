import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 Every `position: fixed` overlay must escape its ancestors through a portal.
 *
 * Per the CSS spec, an ancestor carrying `filter`, `backdrop-filter`,
 * `transform`, `perspective`, `contain` or `will-change` becomes the
 * **containing block for every `position: fixed` descendant**. Two such
 * ancestors exist in this app and both are load-bearing:
 *
 *   - the dashboard header, permanently, via
 *     `backdropFilter: saturate(180%) blur(14px)` — and DateRangePicker,
 *     CustomiseSections, ShareReport and ExportMenu all render inside it;
 *   - `main > *`, transiently, via the `rise` entrance animation's `transform`.
 *     It settles at `transform: none`, so this one only bites during the 0.55s
 *     animation — but MetricInfo positions its panel from
 *     `getBoundingClientRect()`, which is viewport-relative, so a stale
 *     containing block puts the panel in the wrong place rather than merely
 *     clipping it.
 *
 * None of this throws. The Sections and Share dialogs rendered cut off at a
 * hard horizontal edge with the page visible at full brightness below, because
 * `inset: 0` resolved against a short wide strip. A click-away catcher covers
 * only the header, so clicking the page does not dismiss the popover it belongs
 * to. Every symptom reads as "this component is janky", not as a layout bug.
 *
 * Removing the blur would fix today's instances and leave the trap armed. The
 * portal is the durable fix, so this test enforces the portal.
 */

const DIR = __dirname;

/** Overlays that are deliberately NOT portalled, each with the reason. */
const EXEMPT: Record<string, string> = {
  "present/Deck.tsx":
    "Present mode renders as its own full-screen route, not inside the " +
    "dashboard header or main. It has no transformed or filtered ancestor, so " +
    "there is no containing block to escape.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const files = walk(DIR).map((p) => ({
  rel: p.slice(DIR.length + 1),
  src: readFileSync(p, "utf8"),
}));

describe("fixed-position overlays", () => {
  it("finds a realistic number of components", () => {
    // Anti-rot: a broken walker makes everything below vacuously true.
    expect(files.length).toBeGreaterThan(20);
  });

  it("🔴 Modal renders through a portal into document.body", () => {
    const modal = files.find((f) => f.rel === "Modal.tsx")!;
    expect(modal, "Modal.tsx moved — update this test").toBeTruthy();
    expect(modal.src).toContain("createPortal");
    expect(modal.src).toMatch(/createPortal\(\s*children\s*,\s*document\.body\s*\)/);
  });

  it("🔴 the portal is guarded for the server render", () => {
    /*
     * `document` does not exist during SSR. Client components are still
     * server-rendered for the initial HTML, so an unguarded `createPortal`
     * throws a ReferenceError during the render that produces the page.
     *
     * Asserted on `useSyncExternalStore` specifically, not just "some guard":
     * the obvious `useState(false)` + `useEffect(() => setMounted(true))` also
     * works but sets state inside an effect, which cascades a render and trips
     * `react-hooks/set-state-in-effect`. The store version gives React a real
     * server snapshot instead.
     */
    const modal = files.find((f) => f.rel === "Modal.tsx")!;
    expect(modal.src).toContain("useSyncExternalStore");
    expect(modal.src).toMatch(/if \(!useIsHydrated\(\)\) return null/);
    expect(
      modal.src,
      "the server snapshot must return false, or SSR tries to portal",
    ).toMatch(/\(\) => false/);
  });

  it("🔴 every fixed overlay is portalled or explicitly exempt", () => {
    const offenders: string[] = [];

    for (const { rel, src } of files) {
      if (rel === "Modal.tsx") continue; // defines the mechanism
      if (!/className="[^"]*\bfixed\b[^"]*"/.test(src)) continue;
      if (rel in EXEMPT) continue;

      const portalled =
        src.includes("<Portal>") || src.includes("createPortal");
      if (!portalled) offenders.push(rel);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These render a position:fixed element without a portal. Wrap it in ` +
            `<Portal> from "./Modal", or add it to EXEMPT in this file with a ` +
            `reason why it has no transformed/filtered ancestor:\n` +
            offenders.map((f) => `  ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("keeps every exemption pointing at a file that still exists", () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect(
        files.some((f) => f.rel === rel),
        `EXEMPT lists ${rel}, which no longer exists — drop the entry`,
      ).toBe(true);
      expect(EXEMPT[rel].length, `${rel} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it("🔴 Modal keeps its five accessibility behaviours", () => {
    // The portal must not have cost any of them. Each was added deliberately;
    // see the docblock in Modal.tsx.
    const { src } = files.find((f) => f.rel === "Modal.tsx")!;
    expect(src, "role=dialog").toContain('role="dialog"');
    expect(src, "aria-modal").toContain('aria-modal="true"');
    expect(src, "Escape closes").toContain('e.key === "Escape"');
    expect(src, "focus trap").toContain('e.key !== "Tab"');
    expect(src, "focus return").toContain("opener.focus()");
    expect(src, "scroll lock").toContain('document.body.style.overflow = "hidden"');
  });
});
