import { describe, it, expect } from "vitest";
import { TITLE_MAX } from "./catalog";
import { BUILTIN } from "./registry";
import { hasName, renamed } from "./rename";
import type { BoardWidget } from "./types";

/**
 * Renaming a widget from the board editor: what is stored, and when the
 * widget goes back to its automatic name.
 */

const box = { id: "w-1", x: 0, y: 0, w: 3, h: 3 };
const kpi = { ...box, kind: "kpi", platform: "meta", metric: "spend" } as BoardWidget;
const automatic = "Ad spend";

describe("renamed", () => {
  it("stores the new name, trimmed", () => {
    expect(renamed(kpi, "  Monthly spend  ", BUILTIN)).toEqual({ ...kpi, title: "Monthly spend" });
  });

  it("🔴 goes back to the automatic name when the name is cleared", () => {
    const named = { ...kpi, title: "Monthly spend" } as BoardWidget;
    const back = renamed(named, "   ", BUILTIN);
    expect(back).not.toHaveProperty("title");
    expect(back).toEqual(kpi);
  });

  it("stores nothing for a name typed exactly as the automatic one reads", () => {
    // So the tile still follows its stat if the stat is relabelled later.
    expect(renamed(kpi, automatic, BUILTIN)).not.toHaveProperty("title");
  });

  it("keeps everything else about the widget — its stat, place and size", () => {
    const moved = { ...kpi, x: 6, y: 4, w: 4, h: 5 } as BoardWidget;
    expect(renamed(moved, "Spend", BUILTIN)).toMatchObject({ x: 6, y: 4, w: 4, h: 5, metric: "spend", title: "Spend" });
  });

  it("cuts a name at the longest a board will save", () => {
    const long = renamed(kpi, "x".repeat(TITLE_MAX + 20), BUILTIN);
    expect(long.title).toHaveLength(TITLE_MAX);
  });
});

describe("hasName", () => {
  it("offers a rename only where a name is shown", () => {
    expect(hasName(kpi)).toBe(true);
    expect(hasName({ ...box, kind: "text", text: "Hi", size: "heading" } as BoardWidget)).toBe(false);
    expect(hasName({ ...box, kind: "logo" } as BoardWidget)).toBe(false);
    expect(hasName({ ...box, kind: "funnel", platform: "meta" } as BoardWidget)).toBe(true);
  });
});
