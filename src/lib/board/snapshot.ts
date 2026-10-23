import { BOARD_SCHEMA_VERSION, resolveWidgets } from "./schema";
import type { BoardWidget } from "./types";

/**
 * A board frozen into a share link.
 *
 * Stored in `share_links.view`, the column that already holds a report link's
 * section choice — the `kind` tag is what tells the two apart, so no column was
 * added and no live link had to be migrated. A report view has no `kind`, and
 * `normalizeView` rejects anything without a `sections` array, so an older
 * deploy reading a board link falls back to the standard report rather than
 * crashing.
 *
 * A snapshot, not a pointer to the board: the link shows what the sender saw.
 * The client may rearrange their board the next morning, and a link already in
 * someone's inbox must not change underneath the email that sent it.
 */
export interface BoardSnapshot {
  kind: "board";
  schemaVersion: number;
  widgets: BoardWidget[];
}

export function toSnapshot(widgets: readonly BoardWidget[]): BoardSnapshot {
  return { kind: "board", schemaVersion: BOARD_SCHEMA_VERSION, widgets: [...widgets] };
}

/**
 * The widgets of a stored snapshot, or null when the value is not one.
 *
 * Read with the same lenient reader as a stored board: widgets a later build
 * no longer understands are dropped and counted rather than failing the page,
 * and a snapshot written by a newer build is refused — null — instead of
 * guessed at.
 */
export function parseSnapshot(raw: unknown): { widgets: BoardWidget[]; dropped: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { kind?: unknown; schemaVersion?: unknown; widgets?: unknown };
  if (r.kind !== "board") return null;
  const version = typeof r.schemaVersion === "number" ? r.schemaVersion : BOARD_SCHEMA_VERSION;
  const resolved = resolveWidgets(r.widgets, version);
  if (resolved.problem) return null;
  return { widgets: resolved.widgets, dropped: resolved.dropped };
}
