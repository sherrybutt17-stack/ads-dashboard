import { describe, it, expect } from "vitest";
import { moveSection, orderChanged } from "./reorder";
import { SECTIONS, resolveLayout, LAYOUT_SCHEMA_VERSION } from "./registry";

const list = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe("moveSection", () => {
  it("swaps with the neighbour above", () => {
    expect(ids(moveSection(list("a", "b", "c"), "b", -1))).toEqual(["b", "a", "c"]);
  });

  it("swaps with the neighbour below", () => {
    expect(ids(moveSection(list("a", "b", "c"), "b", 1))).toEqual(["a", "c", "b"]);
  });

  it("🔴 does nothing at either end, rather than wrapping", () => {
    /*
     * A section that jumped from the top of the list to the bottom because
     * someone clicked up once too often would read as a bug — and would then be
     * undone by a click that reads as another one.
     */
    const l = list("a", "b", "c");
    expect(ids(moveSection(l, "a", -1))).toEqual(["a", "b", "c"]);
    expect(ids(moveSection(l, "c", 1))).toEqual(["a", "b", "c"]);
  });

  it("🔴 returns the SAME reference when nothing moves", () => {
    /*
     * React bails out of a re-render on referential equality, so a click at
     * either end is genuinely free — and an unsaved-changes check comparing
     * references cannot be tripped by a no-op.
     */
    const l = list("a", "b", "c");
    expect(moveSection(l, "a", -1)).toBe(l);
    expect(moveSection(l, "nope", 1)).toBe(l);
    expect(moveSection(l, "b", 0)).toBe(l);
  });

  it("does not mutate the input", () => {
    const l = list("a", "b", "c");
    moveSection(l, "b", -1);
    expect(ids(l)).toEqual(["a", "b", "c"]);
  });

  it("refuses a non-finite or fractional step rather than producing a hole", () => {
    const l = list("a", "b", "c");
    expect(moveSection(l, "b", NaN)).toBe(l);
    expect(moveSection(l, "b", Infinity)).toBe(l);
    // 0.5 truncates to 0, which is a no-op — not an off-by-one into itself.
    expect(moveSection(l, "b", 0.5)).toBe(l);
  });

  it("handles a single-item and an empty list", () => {
    expect(ids(moveSection(list("a"), "a", 1))).toEqual(["a"]);
    expect(moveSection([], "a", 1)).toEqual([]);
  });

  it("🔴 is reversible, so a mis-click is one click to undo", () => {
    const l = list("a", "b", "c", "d");
    const there = moveSection(l, "c", -1);
    expect(ids(moveSection(there, "c", 1))).toEqual(ids(l));
  });

  it("walks an item from one end to the other one step at a time", () => {
    let l: readonly { id: string }[] = list("a", "b", "c", "d");
    for (let i = 0; i < 3; i++) l = moveSection(l, "a", 1);
    expect(ids(l)).toEqual(["b", "c", "d", "a"]);
  });
});

describe("orderChanged", () => {
  it("is false for an untouched list", () => {
    const l = list("a", "b", "c");
    expect(orderChanged(l, l)).toBe(false);
    expect(orderChanged(l, list("a", "b", "c"))).toBe(false);
  });

  it("is true once two items have traded places", () => {
    expect(orderChanged(list("a", "b"), list("b", "a"))).toBe(true);
  });

  it("🔴 ignores visibility, which is tracked separately", () => {
    /*
     * The drawer shows a different line for "order changed" than for a hidden
     * panel. Reporting a checkbox toggle as a reordering would tell someone
     * their order moved when it did not.
     */
    const before = [{ id: "a", visible: true }, { id: "b", visible: true }];
    const after = [{ id: "a", visible: false }, { id: "b", visible: true }];
    expect(orderChanged(before, after)).toBe(false);
  });

  it("is false when the lengths differ, rather than guessing", () => {
    // A length change means a section shipped or was removed between load and
    // compare — not something the user did, and not something to nag about.
    expect(orderChanged(list("a", "b"), list("a", "b", "c"))).toBe(false);
  });
});

describe("a reordered layout survives the resolver", () => {
  it("🔴 renders in the saved order, not the registry order", () => {
    /*
     * The property that made reorder additive: the stored shape has always been
     * an ordered array and `resolveLayout` has always sorted by it. If this
     * fails, the drawer is writing an order nothing reads.
     */
    const reversed = [...SECTIONS].reverse().map((s) => ({ id: s.id, visible: true }));
    const out = resolveLayout(
      { schemaVersion: LAYOUT_SCHEMA_VERSION, sections: reversed },
      { staff: true },
    );
    expect(out.map((d) => d.id)).toEqual(reversed.map((r) => r.id));
  });

  it("keeps a hidden section out while honouring the order of the rest", () => {
    const stored = SECTIONS.map((s, i) => ({
      id: s.id,
      // Hide every other one, without touching the order.
      visible: s.required ? true : i % 2 === 0,
    })).reverse();
    const out = resolveLayout(
      { schemaVersion: LAYOUT_SCHEMA_VERSION, sections: stored },
      { staff: true },
    );
    const expected = stored.filter((s) => s.visible).map((s) => s.id);
    expect(out.map((d) => d.id)).toEqual(expected);
  });
});
