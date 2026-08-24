/**
 * Moving one section up or down the list.
 *
 * Pure, and in `lib/` rather than inside the drawer component, for the reason
 * `table-columns.ts` records: a `"use client"` module is a boundary, and a
 * function that lives behind it cannot be called from a server component or
 * tested without one. This one is small enough that inlining it would have been
 * tempting and wrong for the same reason.
 *
 * ── Why a swap and not a splice ───────────────────────────────────────
 *
 * A single-step swap is what the two buttons promise. Lifting the item out and
 * re-inserting it produces the same result for one step and a different one the
 * moment a caller passes a larger delta — and the difference (everything
 * between shifts by one, versus two items trading places) is exactly the kind
 * of thing nobody notices until a list is long enough to matter.
 */

export interface Orderable {
  id: string;
}

/**
 * Move `id` by `direction` places.
 *
 * 🔴 Returns the SAME array reference when nothing moves. React state setters
 * bail out of a re-render on referential equality, so this makes a click at
 * either end genuinely free rather than a render that paints identical output —
 * and, more usefully, it means an "unsaved changes" check comparing references
 * cannot be tripped by a no-op click.
 *
 * Both ends are no-ops rather than wraps. A section that jumped from the top of
 * the list to the bottom because someone clicked up once too often would read
 * as a bug, and it would be undone by a click that then reads as another bug.
 */
export function moveSection<T extends Orderable>(
  items: readonly T[],
  id: string,
  direction: number,
): readonly T[] {
  const from = items.findIndex((c) => c.id === id);
  if (from < 0) return items;

  const step = Math.trunc(direction);
  if (!Number.isFinite(step) || step === 0) return items;

  const to = from + step;
  if (to < 0 || to >= items.length) return items;

  const next = [...items];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * Has the order changed from what was loaded?
 *
 * Compares by id and position only. Visibility is tracked separately and a
 * checkbox toggle must NOT be reported as a reordering — the drawer shows a
 * different line for each, and conflating them would tell someone their order
 * changed when they only hid a panel.
 */
export function orderChanged<T extends Orderable>(
  before: readonly T[],
  after: readonly T[],
): boolean {
  if (before.length !== after.length) return false;
  return after.some((c, i) => before[i]?.id !== c.id);
}
