import type { CSSProperties } from "react";
import type { BoardData, BoardWidget as Widget, WidgetData } from "@/lib/board/types";
import { BoardWidget } from "./BoardWidget";

const MISSING: WidgetData = {
  kind: "unavailable",
  tone: "problem",
  title: "This widget could not be loaded",
};

/**
 * A board, laid out: every widget in the cell its saved box names.
 *
 * Markup only, and a server component, so viewing a board ships no layout
 * code — the drag library lives in the editor alone. The geometry is the
 * editor's (12 columns, 40px rows, 16px gaps; see `grid.ts`), placed with CSS
 * variables so the stylesheet owns the rules and a phone can stack the cells
 * into one column, in reading order, without a second layout.
 *
 * Cells are emitted top to bottom, left to right. On a wide screen the grid
 * places them by their variables and the order does not show; on a phone it
 * is the order, and the order a screen reader reads at every width.
 */
export function BoardGrid({
  widgets,
  data,
  slug,
  range,
  basis,
}: {
  widgets: readonly Widget[];
  data: BoardData;
  slug: string;
  range: { start: string; end: string };
  basis: string;
}) {
  const ordered = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  // A Google tile beside a Meta tile has to say which is which; a board of one
  // platform does not need the label on every card.
  const platforms = new Set(widgets.flatMap((w) => ("platform" in w ? [w.platform] : [])));
  const showPlatform = platforms.size > 1;

  return (
    <div className="board-grid">
      {ordered.map((w) => (
        <div
          key={w.id}
          className="board-cell"
          style={
            {
              "--bx": String(w.x + 1),
              "--bw": String(w.w),
              "--by": String(w.y + 1),
              "--bh": String(w.h),
            } as CSSProperties
          }
        >
          <BoardWidget
            widget={w}
            data={data[w.id] ?? MISSING}
            slug={slug}
            range={range}
            basis={basis}
            showPlatform={showPlatform}
          />
        </div>
      ))}
    </div>
  );
}
