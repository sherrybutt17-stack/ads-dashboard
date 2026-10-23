import type { CSSProperties } from "react";

/**
 * Loading UI for a board.
 *
 * Mirrors `page.tsx` and the starter board's first rows — a logo and three
 * headline tiles, four more tiles, two donuts — on the same 12-column grid, so
 * the cells land where their placeholders were. Like the dashboard's skeleton,
 * the sidebar is drawn solid: it is chrome and looks the same either side of
 * the wait.
 */
const CELLS: Array<{ x: number; y: number; w: number; h: number }> = [
  { x: 0, y: 0, w: 3, h: 3 },
  { x: 3, y: 0, w: 3, h: 3 },
  { x: 6, y: 0, w: 3, h: 3 },
  { x: 9, y: 0, w: 3, h: 3 },
  { x: 0, y: 3, w: 3, h: 3 },
  { x: 3, y: 3, w: 3, h: 3 },
  { x: 6, y: 3, w: 3, h: 3 },
  { x: 9, y: 3, w: 3, h: 3 },
  { x: 0, y: 6, w: 6, h: 7 },
  { x: 6, y: 6, w: 6, h: 7 },
];

export default function Loading() {
  return (
    <div
      className="flex min-h-full flex-1 flex-col gap-3 lg:flex-row lg:gap-5 lg:p-5"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading board…</span>

      <div className="sidenav flex shrink-0 flex-col gap-1 px-3 py-3 lg:sticky lg:top-5 lg:h-[calc(100vh-40px)] lg:w-[232px] lg:px-4 lg:py-5">
        <div className="mb-2 flex items-center gap-2.5 px-1 py-1">
          <div
            className="h-9 w-9 shrink-0 rounded-[var(--radius)]"
            style={{ background: "var(--surface-2)" }}
          />
          <div
            className="h-4 w-28 rounded-full"
            style={{ background: "var(--surface-2)" }}
          />
        </div>
        <div className="flex flex-row gap-1 lg:flex-col">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-10 w-[104px] shrink-0 rounded-[var(--radius-sm)] lg:w-full"
              style={{ background: "var(--surface-2)" }}
            />
          ))}
        </div>
      </div>

      <div className="app-frame flex min-w-0 flex-1 flex-col">
        <header className="border-b" style={{ borderColor: "var(--border)" }}>
          <div className="flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3.5 sm:px-6">
            <div className="skeleton h-9 w-9 rounded-[var(--radius)]" />
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="skeleton h-3.5 w-24 rounded-full" />
              <div className="skeleton h-4 w-40 rounded-full" />
            </div>
            <div className="skeleton h-8 w-[260px] rounded-[var(--radius)]" />
            <div className="skeleton h-9 w-[112px] rounded-[var(--radius-sm)]" />
          </div>
        </header>

        <main className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-4 px-4 py-7 sm:px-6">
          <div className="board-grid">
            {CELLS.map((c, i) => (
              <div
                key={i}
                className="board-cell"
                style={
                  {
                    "--bx": String(c.x + 1),
                    "--bw": String(c.w),
                    "--by": String(c.y + 1),
                    "--bh": String(c.h),
                  } as CSSProperties
                }
              >
                <div className="skeleton h-full w-full rounded-[var(--radius-xl)]" />
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
