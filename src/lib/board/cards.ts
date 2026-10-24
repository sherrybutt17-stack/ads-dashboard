/**
 * How creative cards fill a fixed box — a widget on a printed page.
 *
 * Whole cards only. A card cut at the page edge hides exactly the stats a
 * reader came for, so a box that cannot hold another full card shows fewer
 * cards and says how many were left out.
 *
 * A page is a fixed size and a widget cannot be taller than one, so before
 * leaving cards out the layout tries a COMPACT card — one line of body text,
 * no context line, a smaller (but still recognisable) picture — which is what
 * lets a full-page widget print two rows of three, as Whatagraph's report does.
 *
 * Pure, so the arithmetic is testable without a browser.
 */

/** The narrowest a card may be: 3 across on a full-width widget, as Whatagraph lays them out. */
export const CARD_MIN_WIDTH = 280;
export const CARD_GAP = 12;
/** Stats per row inside a card. */
export const CARD_STATS_PER_ROW = 3;

/** Meta's link-ad image ratio, 1.91:1. */
const THUMB_ASPECT = 1.91;
/** The smallest picture a card keeps; below it, the picture is dropped. */
const THUMB_MIN = 64;
/** A compact card's picture never shrinks below this: it must still show the ad. */
const THUMB_COMPACT_MIN = 90;
const THUMB_MAX = 180;

/** The text part of a card, in px — kept in step with `BoardCreatives`. */
export function cardTextHeight(o: { stats: number; rankings: boolean; compact?: boolean }): number {
  const padding = 24;
  const name = 20;
  const headline = 18;
  // Two lines of body, or one when compact.
  const body = o.compact ? 16 : 32;
  // "3 ads · 74% of spend" — left out when compact.
  const context = o.compact ? 0 : 16;
  const link = 18;
  // A two-line label (26) and its value (20), and the row gap.
  const statRow = 54;
  const ranking = o.rankings ? 18 : 0;
  const lines = (o.compact ? 4 : 5) + (o.rankings ? 1 : 0);
  const gaps = 6 * lines;
  return (
    padding +
    name +
    headline +
    body +
    context +
    link +
    Math.ceil(Math.max(1, o.stats) / CARD_STATS_PER_ROW) * statRow +
    ranking +
    gaps
  );
}

export interface CardLayout {
  columns: number;
  rows: number;
  /** Thumbnail height in px; 0 = no thumbnail, there was no room for one. */
  thumbH: number;
  /** Cards that fit, ≤ the cards there are. */
  shown: number;
  /** One line of body and no context line, so more rows fit. */
  compact: boolean;
}

export function cardGrid(
  box: { width: number; height: number },
  o: { stats: number; rankings: boolean; cards: number },
): CardLayout {
  const cards = Math.max(0, o.cards);
  const columns = Math.max(1, Math.floor((box.width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
  const colWidth = (box.width - CARD_GAP * (columns - 1)) / columns;
  const natural = Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.floor(colWidth / THUMB_ASPECT)));
  const needed = Math.max(1, Math.ceil(cards / columns));
  const layout = (rows: number, thumbH: number, compact: boolean): CardLayout => ({
    columns,
    rows,
    thumbH,
    shown: Math.min(cards, columns * rows),
    compact,
  });

  // As designed: full text and natural pictures, as many rows as the cards need.
  const full = cardTextHeight(o);
  const fullRows = Math.min(needed, Math.floor((box.height + CARD_GAP) / (full + natural + CARD_GAP)));
  if (fullRows >= needed) return layout(needed, natural, false);

  // Compact: the most rows (more than the full layout manages) whose pictures stay recognisable.
  const text = cardTextHeight({ ...o, compact: true });
  for (let rows = needed; rows > Math.max(fullRows, 1); rows--) {
    const thumb = Math.floor((box.height - rows * text - (rows - 1) * CARD_GAP) / rows);
    if (thumb >= THUMB_COMPACT_MIN) return layout(rows, Math.min(natural, thumb), true);
  }

  if (fullRows >= 1) return layout(fullRows, natural, false);
  // Not even one full row: shrink the picture, then drop it — never the card.
  const room = box.height - full;
  return layout(1, room >= THUMB_MIN ? Math.min(natural, room) : 0, false);
}
