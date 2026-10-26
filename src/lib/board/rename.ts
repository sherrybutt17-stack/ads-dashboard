import { TITLE_MAX, defaultTitle } from "./catalog";
import { widgetQueryOf } from "./query";
import type { Registry } from "./registry";
import type { BoardWidget } from "./types";

/** Whether a widget shows a name at all: a text block shows its text, a logo its picture. */
export function hasName(w: BoardWidget): boolean {
  return w.kind !== "text" && w.kind !== "logo";
}

/**
 * A widget under a new name — or back on its automatic one when the name is
 * cleared, or typed out exactly as the automatic name reads, so a tile that
 * was never really renamed still follows its stat if the stat is relabelled.
 */
export function renamed(w: BoardWidget, name: string, reg: Registry): BoardWidget {
  const next = name.trim().slice(0, TITLE_MAX).trim();
  const { title: _old, ...rest } = w;
  void _old;
  return next && next !== defaultTitle(widgetQueryOf(w), reg)
    ? ({ ...rest, title: next } as BoardWidget)
    : (rest as BoardWidget);
}
