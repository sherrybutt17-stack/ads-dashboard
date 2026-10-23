import { describe, it, expect } from "vitest";
import { starterBoard } from "./catalog";
import {
  BOARD_COLS,
  GAP_PX,
  ROWS_PER_PAGE,
  ROW_PX,
  boardHeightRows,
  cellRect,
  firstFreeSlot,
  moveBy,
  normalizeLayout,
  paginate,
  MIN_PAGE_ZOOM,
  resizeBy,
} from "./grid";
import type { BoardWidget } from "./types";

const k = (id: string, x: number, y: number, w = 3, h = 3): BoardWidget => ({
  id,
  kind: "kpi",
  platform: "meta",
  metric: "spend",
  x,
  y,
  w,
  h,
});

function noOverlaps(boxes: BoardWidget[]) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(hit, `${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
}

describe("normalizeLayout", () => {
  it("leaves a valid, compacted board exactly as it is", () => {
    const board = starterBoard({
      hasMeta: true,
      hasGoogle: true,
      hasTiktok: false,
      hasCrm: true,
      hasLogo: true,
      clientName: "Acme",
    });
    expect(normalizeLayout(board)).toEqual(board);
  });

  it("separates overlapping widgets and closes the gap above them", () => {
    const out = normalizeLayout([k("a", 0, 0), k("b", 0, 0), k("c", 6, 9)]);
    noOverlaps(out);
    expect(out.find((w) => w.id === "c")!.y).toBe(0);
  });

  it("keeps every widget inside the grid and within its size limits", () => {
    const out = normalizeLayout([k("a", 11, 0, 6, 1), { ...k("b", 0, 3), w: 40, h: 40 }]);
    for (const w of out) {
      expect(w.x + w.w).toBeLessThanOrEqual(BOARD_COLS);
      expect(w.h).toBeLessThanOrEqual(6);
      expect(w.h).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("keyboard moves", () => {
  it("moving up swaps places with the widget above", () => {
    const out = moveBy([k("top", 0, 0), k("low", 0, 3)], "low", 0, -1);
    expect(out.find((w) => w.id === "low")!.y).toBe(0);
    expect(out.find((w) => w.id === "top")!.y).toBe(3);
  });

  it("moving down jumps below the widget underneath", () => {
    const out = moveBy([k("top", 0, 0), k("low", 0, 3)], "top", 0, 1);
    expect(out.find((w) => w.id === "low")!.y).toBe(0);
    expect(out.find((w) => w.id === "top")!.y).toBe(3);
  });

  it("moves sideways one column at a time and stops at the edge", () => {
    expect(moveBy([k("a", 0, 0)], "a", 1, 0)[0].x).toBe(1);
    expect(moveBy([k("a", 9, 0)], "a", 1, 0)[0].x).toBe(9);
    expect(moveBy([k("a", 0, 0)], "a", -1, 0)[0].x).toBe(0);
  });

  it("resizes within the kind's limits and the grid's width", () => {
    expect(resizeBy([k("a", 0, 0)], "a", 1, 0)[0].w).toBe(4);
    expect(resizeBy([k("a", 0, 0, 2)], "a", -1, 0)[0].w).toBe(2);
    expect(resizeBy([k("a", 9, 0)], "a", 2, 0)[0].w).toBe(3);
    expect(resizeBy([k("a", 0, 0, 3, 6)], "a", 0, 1)[0].h).toBe(6);
  });

  it("pushes neighbours down rather than overlapping them when growing", () => {
    const out = resizeBy([k("a", 0, 0), k("b", 0, 3)], "a", 0, 1);
    noOverlaps(out);
  });
});

describe("placing and printing", () => {
  it("finds the highest free slot", () => {
    expect(firstFreeSlot([k("a", 0, 0)], 3, 3)).toEqual({ x: 3, y: 0 });
    expect(firstFreeSlot([k("a", 0, 0, 12)], 3, 3)).toEqual({ x: 0, y: 3 });
  });

  it("matches CSS grid and react-grid-layout geometry", () => {
    const width = 1200;
    const col = (width - (BOARD_COLS - 1) * GAP_PX) / BOARD_COLS;
    const r = cellRect({ x: 2, y: 1, w: 3, h: 2 }, width);
    expect(r.left).toBeCloseTo(2 * (col + GAP_PX));
    expect(r.top).toBe(ROW_PX + GAP_PX);
    expect(r.width).toBeCloseTo(3 * col + 2 * GAP_PX);
    expect(r.height).toBe(2 * ROW_PX + GAP_PX);
  });

  it("never cuts a widget across two pages", () => {
    const board = starterBoard({
      hasMeta: true,
      hasGoogle: true,
      hasTiktok: false,
      hasCrm: true,
      hasLogo: true,
      clientName: "Acme",
    });
    const pages = paginate(board);
    const placed = pages.flatMap((p) => p.boxes.map((b) => b.id));
    expect(placed.sort()).toEqual(board.map((w) => w.id).sort());
    for (const p of pages) {
      for (const b of p.boxes) expect(b.y + b.h).toBeLessThanOrEqual(p.rows);
      // A little more on a sheet, drawn slightly smaller — never tiny.
      expect(p.zoom).toBeGreaterThanOrEqual(MIN_PAGE_ZOOM);
      expect(p.zoom).toBe(p.rows > ROWS_PER_PAGE ? ROWS_PER_PAGE / p.rows : 1);
    }
    expect(pages.reduce((n, p) => n + p.rows, 0)).toBe(boardHeightRows(board));
  });

  it("fills a sheet rather than sending it out half empty", () => {
    const board = starterBoard({
      hasMeta: true,
      hasGoogle: true,
      hasTiktok: false,
      hasCrm: true,
      hasLogo: true,
      clientName: "Acme",
    });
    // Strict twelve-row sheets cut the starter into five, two of them half
    // empty; with the document's heading rule it takes three.
    const pages = paginate(board, ROWS_PER_PAGE, {
      keepWithNext: (w) => w.kind === "text" && w.size === "heading",
    });
    expect(pages.map((p) => p.rows)).toEqual([13, 11, 13]);
  });

  it("🔴 never ends a sheet on a heading when it can start the next", () => {
    const heading = (id: string, y: number) =>
      ({ id, kind: "text", text: "Section", size: "heading", x: 0, y, w: 12, h: 1 }) as BoardWidget;
    const block = (id: string, y: number, h: number) =>
      ({ id, kind: "series", platform: "meta", metric: "spend", form: "line", compare: false, x: 0, y, w: 12, h }) as BoardWidget;
    // 11 rows of chart, then a heading on row 11 whose chart needs 8 more.
    const board = [block("a", 0, 11), heading("h", 11), block("b", 12, 8)];
    const pages = paginate(board, ROWS_PER_PAGE, {
      keepWithNext: (w) => w.kind === "text" && w.size === "heading",
    });
    expect(pages.map((p) => p.boxes.map((b) => b.id))).toEqual([["a"], ["h", "b"]]);
    // Without the rule, the heading would be stranded at the foot of the first.
    expect(paginate(board)[0].boxes.map((b) => b.id)).toEqual(["a", "h"]);
  });

  it("scales a page down rather than slicing a staggered pair", () => {
    // Two tall widgets side by side, offset so no clean cut exists within a page.
    const tall = [
      { id: "a", kind: "series", platform: "meta", metric: "spend", form: "line", compare: false, x: 0, y: 0, w: 6, h: 10 },
      { id: "b", kind: "series", platform: "meta", metric: "spend", form: "line", compare: false, x: 6, y: 6, w: 6, h: 10 },
    ] as BoardWidget[];
    const pages = paginate(tall);
    expect(pages).toHaveLength(1);
    expect(pages[0].rows).toBe(16);
    expect(pages[0].zoom).toBeCloseTo(ROWS_PER_PAGE / 16);
  });
});
