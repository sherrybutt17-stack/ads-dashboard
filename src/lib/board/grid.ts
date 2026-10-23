import { WIDGET_KINDS, type Size, type WidgetKind } from "./catalog";
import type { WidgetBox } from "./types";

/**
 * Board geometry, shared by every renderer.
 *
 * The view page draws the board as a CSS grid, the editor drags it with
 * react-grid-layout, and the PDF lays it out in fixed pixels. All three must
 * put a widget in the same place, so the numbers live here once:
 *
 *   column width = (content width − 11 × GAP) / 12
 *   widget height = h × ROW + (h − 1) × GAP
 *
 * which is exactly react-grid-layout's arithmetic with `rowHeight: 40` and
 * `margin: [16, 16]`, and exactly CSS grid's with `grid-auto-rows: 40px` and
 * `gap: 16px`.
 */
export const BOARD_COLS = 12;
export const ROW_PX = 40;
export const GAP_PX = 16;

/** Rows that fit on one landscape PDF page under its header. */
export const ROWS_PER_PAGE = 12;

/** Bottom edge, in rows, of the lowest widget. */
export function boardHeightRows(boxes: readonly WidgetBox[]): number {
  return boxes.reduce((max, b) => Math.max(max, b.y + b.h), 0);
}

export function boxHeightPx(h: number): number {
  return h * ROW_PX + Math.max(0, h - 1) * GAP_PX;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A widget's pixel rectangle on a board `contentWidth` pixels wide. */
export function cellRect(box: Pick<WidgetBox, "x" | "y" | "w" | "h">, contentWidth: number): Rect {
  const col = (contentWidth - (BOARD_COLS - 1) * GAP_PX) / BOARD_COLS;
  return {
    left: box.x * (col + GAP_PX),
    top: box.y * (ROW_PX + GAP_PX),
    width: box.w * col + Math.max(0, box.w - 1) * GAP_PX,
    height: boxHeightPx(box.h),
  };
}

function overlaps(a: WidgetBox, b: WidgetBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function collides(box: WidgetBox, placed: readonly WidgetBox[]): boolean {
  return placed.some((p) => p.id !== box.id && overlaps(box, p));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function limitsFor(kind: WidgetKind): { min: Size; max: Size } {
  const k = WIDGET_KINDS[kind];
  return { min: k.min, max: k.max };
}

/**
 * Make any arrangement valid: inside the grid, within each kind's size limits,
 * no overlaps, no gaps above a widget.
 *
 * Vertical compaction in reading order (top to bottom, then left to right) —
 * the same rule react-grid-layout applies while dragging, so a layout the editor
 * produced comes back from here unchanged. `prefer` wins ties at the same row,
 * which is how a keyboard "move up" can take another widget's place instead of
 * bouncing back below it.
 */
export function normalizeLayout<T extends WidgetBox & { kind: WidgetKind }>(
  boxes: readonly T[],
  opts: { prefer?: string } = {},
): T[] {
  const sized = boxes.map((b) => {
    const { min, max } = limitsFor(b.kind);
    const w = clamp(Math.round(b.w) || min.w, min.w, Math.min(max.w, BOARD_COLS));
    const x = clamp(Math.round(b.x) || 0, 0, BOARD_COLS - w);
    const h = clamp(Math.round(b.h) || min.h, min.h, max.h);
    const y = Math.max(0, Math.round(b.y) || 0);
    return { ...b, x, y, w, h };
  });

  const order = [...sized].sort(
    (a, b) =>
      a.y - b.y ||
      (a.id === opts.prefer ? -1 : b.id === opts.prefer ? 1 : 0) ||
      a.x - b.x,
  );

  const placed: T[] = [];
  for (const item of order) {
    const box = { ...item };
    // Rise as far as nothing above blocks it…
    while (box.y > 0 && !collides({ ...box, y: box.y - 1 }, placed)) box.y -= 1;
    // …then sink below anything it still lands on.
    while (collides(box, placed)) box.y += 1;
    placed.push(box);
  }

  // Back in the caller's order, so ids keep their positions in the array.
  const byId = new Map(placed.map((p) => [p.id, p]));
  return sized.map((b) => byId.get(b.id) ?? b);
}

/** The highest free spot a `w × h` widget fits, scanning row by row. */
export function firstFreeSlot(
  boxes: readonly WidgetBox[],
  w: number,
  h: number,
): { x: number; y: number } {
  const width = clamp(w, 1, BOARD_COLS);
  const bottom = boardHeightRows(boxes);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x <= BOARD_COLS - width; x++) {
      const probe = { id: "\u0000probe", x, y, w: width, h };
      if (!collides(probe, boxes)) return { x, y };
    }
  }
  return { x: 0, y: bottom };
}

/**
 * Keyboard move: one column or one row at a time.
 *
 * Moving up into another widget takes that widget's row (and it compacts below);
 * moving down past one jumps beneath it. Without that, an arrow press into a
 * neighbour would do nothing visible, and a keyboard user could never reorder.
 */
export function moveBy<T extends WidgetBox & { kind: WidgetKind }>(
  boxes: readonly T[],
  id: string,
  dx: number,
  dy: number,
): T[] {
  const me = boxes.find((b) => b.id === id);
  if (!me) return [...boxes];
  const others = boxes.filter((b) => b.id !== id);
  let { x, y } = me;

  if (dx !== 0) x = clamp(x + dx, 0, BOARD_COLS - me.w);

  if (dy < 0 && y > 0) {
    const target = { ...me, x, y: y - 1 };
    const above = others
      .filter((o) => overlaps(target, o))
      .sort((a, b) => a.y - b.y)[0];
    y = above ? Math.min(above.y, y - 1) : y - 1;
  } else if (dy > 0) {
    const target = { ...me, x, y: y + 1 };
    const below = others
      .filter((o) => overlaps(target, o) && o.y >= me.y)
      .sort((a, b) => a.y + a.h - (b.y + b.h))
      .pop();
    y = below ? below.y + below.h : y + 1;
  }

  const moved = boxes.map((b) => (b.id === id ? { ...b, x, y } : b));
  return normalizeLayout(moved, { prefer: dy < 0 ? id : undefined });
}

/** Keyboard resize, within the kind's limits and the grid's width. */
export function resizeBy<T extends WidgetBox & { kind: WidgetKind }>(
  boxes: readonly T[],
  id: string,
  dw: number,
  dh: number,
): T[] {
  const resized = boxes.map((b) => {
    if (b.id !== id) return b;
    const { min, max } = limitsFor(b.kind);
    const w = clamp(b.w + dw, min.w, Math.min(max.w, BOARD_COLS - b.x));
    const h = clamp(b.h + dh, min.h, max.h);
    return { ...b, w, h };
  });
  return normalizeLayout(resized, { prefer: id });
}

export interface BoardPage<T extends WidgetBox> {
  /** First row on this page. */
  start: number;
  /** Rows the page spans (may exceed ROWS_PER_PAGE; then it is scaled). */
  rows: number;
  /** ≤ 1: shrink factor when the page holds more than ROWS_PER_PAGE rows. */
  zoom: number;
  boxes: T[];
}

/** The smallest a page is drawn to take a little more, rather than go out mostly empty. */
export const MIN_PAGE_ZOOM = 0.85;

/**
 * Cut a board into pages without cutting through a widget.
 *
 * A cut is only allowed on a row where every widget either ends above it or
 * starts at or below it. Within that rule:
 *
 *   · A page that would go out with two or more rows empty may take a little
 *     more — up to `ROWS_PER_PAGE / MIN_PAGE_ZOOM` rows — drawn slightly
 *     smaller. The starter board is five pages cut strictly and three this
 *     way, and a half-empty sheet reads as a missing chart.
 *   · A page never ends on a heading (`keepWithNext`) when an earlier cut
 *     exists: a section title alone at the foot of a sheet, its widgets
 *     overleaf, is the printed-document mistake everyone notices.
 *   · When the next clean cut is further away than that (two tall widgets
 *     staggered side by side), the page takes the rows it needs and is scaled
 *     down to fit, however far, rather than slicing a chart in half.
 */
export function paginate<T extends WidgetBox>(
  boxes: readonly T[],
  rowsPerPage = ROWS_PER_PAGE,
  opts: { keepWithNext?: (box: T) => boolean } = {},
): BoardPage<T>[] {
  const total = boardHeightRows(boxes);
  if (total === 0) return [];

  const safe = (row: number) => boxes.every((b) => b.y + b.h <= row || b.y >= row);
  // A cut whose last row holds nothing but headings would strand them.
  const strands = (row: number) => {
    const { keepWithNext } = opts;
    if (!keepWithNext || row === total) return false;
    const last = boxes.filter((b) => b.y <= row - 1 && b.y + b.h >= row);
    return last.length > 0 && last.every(keepWithNext);
  };
  /** Clean cuts in (lo, hi], largest first, a stranding cut only as a last resort. */
  const bestCut = (lo: number, hi: number): number | undefined => {
    const cuts: number[] = [];
    for (let r = Math.min(total, hi); r > lo; r--) if (safe(r)) cuts.push(r);
    return cuts.find((r) => !strands(r)) ?? cuts[0];
  };
  const stretch = Math.floor(rowsPerPage / MIN_PAGE_ZOOM);
  const fullEnough = rowsPerPage - 2;

  const pages: BoardPage<T>[] = [];
  let start = 0;

  while (start < total) {
    let end = bestCut(start, start + rowsPerPage) ?? -1;
    if (end === -1 || (end - start < fullEnough && end < total)) {
      end = bestCut(start + rowsPerPage, start + stretch) ?? end;
    }
    if (end === -1) {
      for (let r = start + stretch + 1; r <= total; r++) {
        if (safe(r)) {
          end = r;
          break;
        }
      }
      if (end === -1) end = total;
    }
    const rows = end - start;
    pages.push({
      start,
      rows,
      zoom: rows > rowsPerPage ? rowsPerPage / rows : 1,
      boxes: boxes
        .filter((b) => b.y >= start && b.y < end)
        .map((b) => ({ ...b, y: b.y - start })),
    });
    start = end;
  }
  return pages;
}
