"use client";

import { useMemo, type ReactNode } from "react";
import { GridLayout, useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { BOARD_COLS, GAP_PX, ROW_PX, limitsFor } from "@/lib/board/grid";
import type { BoardWidget, WidgetBox } from "@/lib/board/types";

/**
 * The drag-and-resize surface, and the only module that loads the grid library.
 *
 * Imported by the editor through `next/dynamic` with `ssr: false`: the library
 * measures the DOM, and viewing a board — server HTML on a CSS grid — never
 * ships it at all. Same geometry as that grid (12 columns, 40px rows, 16px
 * gaps), so what you arrange here is what the board shows.
 *
 * 2.x passes `nodeRef` to the draggable and never calls `findDOMNode`, which
 * React 19 removed; the version is pinned exactly in package.json.
 *
 * Positions come back only when a drag or a resize ENDS, already compacted by
 * the same vertical rule `normalizeLayout` applies — not on every
 * `onLayoutChange`, which also fires on mount and would mark an untouched
 * board as edited.
 */
export default function BoardCanvasRgl({
  widgets,
  renderItem,
  onArrange,
}: {
  widgets: readonly BoardWidget[];
  renderItem: (widget: BoardWidget) => ReactNode;
  onArrange: (boxes: WidgetBox[], how: "move" | "resize") => void;
}) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });

  const layout: Layout = useMemo(
    () =>
      widgets.map((w) => {
        const { min, max } = limitsFor(w.kind);
        return {
          i: w.id,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          minW: min.w,
          minH: min.h,
          maxW: Math.min(max.w, BOARD_COLS),
          maxH: max.h,
        };
      }),
    [widgets],
  );

  const boxes = (l: Layout): WidgetBox[] => l.map((it) => ({ id: it.i, x: it.x, y: it.y, w: it.w, h: it.h }));

  return (
    <div ref={containerRef} className="board-canvas">
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols: BOARD_COLS, rowHeight: ROW_PX, margin: [GAP_PX, GAP_PX], containerPadding: [0, 0] }}
          // Only the handle starts a drag, so a click on a chart, a sort button
          // or the menu does what it says rather than nudging the widget.
          dragConfig={{ handle: ".board-drag-handle", threshold: 4 }}
          resizeConfig={{ handles: ["se", "e", "s"] }}
          compactor={verticalCompactor}
          onDragStop={(l) => onArrange(boxes(l), "move")}
          onResizeStop={(l) => onArrange(boxes(l), "resize")}
        >
          {widgets.map((w) => (
            <div key={w.id} className="board-edit-cell">
              {renderItem(w)}
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
