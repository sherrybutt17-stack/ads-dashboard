import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dashboardBoards } from "@/db/schema";
import { starterBoard, type StarterContext } from "./catalog";
import { normalizeLayout } from "./grid";
import { BOARD_SCHEMA_VERSION, resolveWidgets } from "./schema";
import type { BoardWidget } from "./types";

/**
 * Reading and writing a client's board — the same contract as the section
 * layout store (`layout-store.ts`), which has carried it in production.
 *
 * Forgiving on read: a missing table, a missing row, or an unreadable one all
 * produce a usable board (the starter), never an error page. Strict on write:
 * what is stored is what the renderer would produce, and a save that raced
 * another one is refused rather than silently overwriting it.
 */

export interface StoredBoard {
  widgets: BoardWidget[];
  locked: boolean;
  /** Null until the board is first saved. Sent back as `ifUnmodifiedSince`. */
  updatedAt: Date | null;
  updatedBy: string | null;
  /** A saved row exists. False means the computed starter is showing. */
  customised: boolean;
  /** Stored widgets that no longer validate and were left out. */
  dropped: number;
  /** Why a stored board could not be shown as saved. */
  problem: "newer_version" | "unreadable" | "unavailable" | null;
}

function starterFor(ctx: StarterContext, extra: Partial<StoredBoard> = {}): StoredBoard {
  return {
    widgets: starterBoard(ctx),
    locked: false,
    updatedAt: null,
    updatedBy: null,
    customised: false,
    dropped: 0,
    problem: null,
    ...extra,
  };
}

export async function getBoard(clientId: string, starter: StarterContext): Promise<StoredBoard> {
  try {
    const [row] = await db
      .select()
      .from(dashboardBoards)
      .where(eq(dashboardBoards.clientId, clientId))
      .limit(1);
    if (!row) return starterFor(starter);

    const resolved = resolveWidgets(row.widgets, row.schemaVersion);
    if (resolved.problem) {
      // Keep the lock and the timestamp: the next save must still be a
      // conditional one, and a locked board stays locked while unreadable.
      return starterFor(starter, {
        locked: row.locked,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        customised: true,
        problem: resolved.problem,
      });
    }
    return {
      widgets: resolved.widgets,
      locked: row.locked,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      customised: true,
      dropped: resolved.dropped,
      problem: null,
    };
  } catch (err) {
    console.error("[board] unavailable, using the starter:", err);
    return starterFor(starter, { problem: "unavailable" });
  }
}

export type SaveBoardOutcome =
  | { ok: true; board: StoredBoard }
  | { ok: false; conflict: true; current: StoredBoard };

export interface SaveBoardInput {
  /** Omitted for a lock-only change by staff. */
  widgets?: BoardWidget[];
  locked?: boolean;
  updatedBy: string | null;
  /** The `updatedAt` the editor started from. */
  ifUnmodifiedSince?: string;
  /** The editor started from the unsaved starter: refuse if someone saved first. */
  expectNew?: boolean;
  starter: StarterContext;
}

/**
 * Save a board, refusing a write that would overwrite someone else's.
 *
 * Three modes, chosen by what the editor knew when it started:
 *  - `ifUnmodifiedSince` — it opened a saved board: update only if nobody saved
 *    since (millisecond precision, as Postgres stores microseconds and JSON
 *    carries milliseconds — the same comparison as `layout-store.ts`);
 *  - `expectNew` — it opened the computed starter: insert only if there is
 *    still no row. Without this, two people saving the starter at once would
 *    each silently overwrite the other, the one race the layout store left open;
 *  - neither — last write wins (a lock-only change from staff).
 *
 * `locked` changes only when it is named, never by omission.
 */
export async function saveBoard(clientId: string, input: SaveBoardInput): Promise<SaveBoardOutcome> {
  const now = new Date();
  const widgets = input.widgets ? normalizeLayout(input.widgets) : undefined;

  const set: Record<string, unknown> = {
    updatedAt: now,
    updatedBy: input.updatedBy,
    schemaVersion: BOARD_SCHEMA_VERSION,
  };
  if (widgets) set.widgets = widgets;
  if (input.locked !== undefined) set.locked = input.locked;

  if (input.ifUnmodifiedSince) {
    const expected = new Date(input.ifUnmodifiedSince);
    const updated = await db
      .update(dashboardBoards)
      .set(set)
      .where(
        and(
          eq(dashboardBoards.clientId, clientId),
          sql`date_trunc('milliseconds', ${dashboardBoards.updatedAt}) = date_trunc('milliseconds', ${expected.toISOString()}::timestamptz)`,
        ),
      )
      .returning({ id: dashboardBoards.id });
    if (updated.length === 0) {
      return { ok: false, conflict: true, current: await getBoard(clientId, input.starter) };
    }
    return { ok: true, board: await getBoard(clientId, input.starter) };
  }

  // A row needs widgets. A lock-only change on a never-saved board stores the
  // starter as it stands, so the lock has something to hold.
  const values = {
    clientId,
    widgets: widgets ?? starterBoard(input.starter),
    schemaVersion: BOARD_SCHEMA_VERSION,
    locked: input.locked ?? false,
    updatedAt: now,
    updatedBy: input.updatedBy,
  };

  if (input.expectNew) {
    const inserted = await db
      .insert(dashboardBoards)
      .values(values)
      .onConflictDoNothing({ target: dashboardBoards.clientId })
      .returning({ id: dashboardBoards.id });
    if (inserted.length === 0) {
      return { ok: false, conflict: true, current: await getBoard(clientId, input.starter) };
    }
    return { ok: true, board: await getBoard(clientId, input.starter) };
  }

  await db
    .insert(dashboardBoards)
    .values(values)
    .onConflictDoUpdate({ target: dashboardBoards.clientId, set });
  return { ok: true, board: await getBoard(clientId, input.starter) };
}

/** Back to the computed starter. Deleting the row is what "reset" means. */
export async function resetBoard(clientId: string): Promise<void> {
  await db.delete(dashboardBoards).where(eq(dashboardBoards.clientId, clientId));
}
