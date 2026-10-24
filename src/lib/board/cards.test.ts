import { describe, it, expect } from "vitest";
import { CARD_GAP, cardGrid, cardTextHeight } from "./cards";
import { boxHeightPx } from "./grid";

/**
 * Creative cards on a printed page: whole cards only, three across on a full
 * width, and the thumbnail is the first thing to give way.
 */

// A full-width widget on the 992px content of a landscape page, less the card's padding.
const FULL = 992 - 32;
const tall = (rows: number) => boxHeightPx(rows) - 32 - 28;

describe("cardGrid", () => {
  it("lays a full-width widget out three across, as Whatagraph does", () => {
    const l = cardGrid({ width: FULL, height: tall(12) }, { stats: 3, rankings: false, cards: 6 });
    expect(l.columns).toBe(3);
  });

  it("🔴 never shows more cards than fit whole", () => {
    for (const rows of [7, 8, 9, 10, 11, 12]) {
      const box = { width: FULL, height: tall(rows) };
      const l = cardGrid(box, { stats: 6, rankings: true, cards: 12 });
      const text = cardTextHeight({ stats: 6, rankings: true, compact: l.compact });
      const used = l.rows * (text + l.thumbH) + (l.rows - 1) * CARD_GAP;
      expect(used, `${rows} rows`).toBeLessThanOrEqual(box.height);
      expect(l.shown).toBe(Math.min(12, l.columns * l.rows));
    }
  });

  it("shows only the cards there are", () => {
    const l = cardGrid({ width: FULL, height: tall(12) }, { stats: 3, rankings: false, cards: 2 });
    expect(l.shown).toBe(2);
    expect(l.rows).toBe(1);
  });

  it("🔴 prints two rows of three on a full page by going compact, rather than leaving half out", () => {
    // A full-page widget, its notes line taken off, with Whatagraph's three stats.
    const l = cardGrid({ width: FULL, height: tall(12) - 34 }, { stats: 3, rankings: false, cards: 6 });
    expect(l).toMatchObject({ columns: 3, rows: 2, shown: 6, compact: true });
    expect(l.thumbH).toBeGreaterThanOrEqual(90);
  });

  it("stays full-size when the cards fit as designed", () => {
    const l = cardGrid({ width: FULL, height: tall(12) }, { stats: 3, rankings: false, cards: 3 });
    expect(l).toMatchObject({ rows: 1, shown: 3, compact: false });
  });

  it("drops the thumbnail before it drops a card", () => {
    // A box too short for a card with a recognisable picture.
    const text = cardTextHeight({ stats: 6, rankings: true });
    const l = cardGrid({ width: FULL, height: text + 20 }, { stats: 6, rankings: true, cards: 6 });
    expect(l.thumbH).toBe(0);
    expect(l.rows).toBe(1);
    expect(l.shown).toBe(3);
  });

  it("keeps a narrow widget to one column", () => {
    const l = cardGrid({ width: 300, height: tall(9) }, { stats: 3, rankings: false, cards: 6 });
    expect(l.columns).toBe(1);
    expect(l.shown).toBeGreaterThanOrEqual(1);
  });
});
