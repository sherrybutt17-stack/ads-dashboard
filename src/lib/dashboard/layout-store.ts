import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dashboardLayouts, type LayoutAudience } from "@/db/schema";
import {
  resolveLayoutFull,
  LAYOUT_SCHEMA_VERSION,
  type ResolvedSection,
} from "./registry";

/**
 * Reading and writing stored dashboard layouts.
 *
 * Two rules govern everything here:
 *
 * **Lenient on read.** Every read goes through `resolveLayoutFull`, which is
 * total. A malformed row, a row from a newer deploy, a row naming a section
 * that no longer exists — all of them render the code defaults rather than
 * throwing. A dashboard full of real numbers must never 500 over a preference.
 *
 * **Strict on write.** The incoming payload is canonicalised through the same
 * resolver and the RESULT is persisted, so dedupe, unknown-id removal, required
 * sections and ordering are settled once at the boundary. What comes back out
 * is then exactly what went in, which is what makes the settings UI honest.
 */

export interface StoredLayoutRow {
  sections: ResolvedSection[];
  locked: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
  /** False when no row exists yet — the dashboard is on code defaults. */
  customised: boolean;
}

/**
 * Code defaults for one audience.
 *
 * A function rather than a constant because staff-only sections must be in the
 * staff default and absent from the client one — a shared constant computed
 * once would have to pick a side, and either choice is wrong for half the
 * callers. This is also the value returned when the table cannot be read, so it
 * has to be right for the audience asking rather than merely safe on average.
 */
function defaultsFor(audience: LayoutAudience): StoredLayoutRow {
  return {
    sections: resolveLayoutFull(null, { staff: audience === "staff" }),
    locked: false,
    updatedAt: null,
    updatedBy: null,
    customised: false,
  };
}

/**
 * The layout for one client and audience.
 *
 * Never throws. `dashboard_layouts` arrives in migration 0015, and a deployment
 * that has not run it must keep rendering dashboards — the same reason
 * `getClientBranding` swallows its errors.
 */
export async function getLayout(
  clientId: string,
  audience: LayoutAudience,
): Promise<StoredLayoutRow> {
  try {
    const [row] = await db
      .select()
      .from(dashboardLayouts)
      .where(
        and(
          eq(dashboardLayouts.clientId, clientId),
          eq(dashboardLayouts.audience, audience),
        ),
      )
      .limit(1);

    if (!row) return defaultsFor(audience);

    return {
      sections: resolveLayoutFull(
        {
          schemaVersion: row.schemaVersion,
          sections: row.sections,
        },
        { staff: audience === "staff" },
      ),
      locked: row.locked,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      customised: true,
    };
  } catch (err) {
    console.error("[layout] unavailable, using defaults:", err);
    return defaultsFor(audience);
  }
}

export type SaveOutcome =
  | { ok: true; row: StoredLayoutRow }
  | { ok: false; conflict: true; current: StoredLayoutRow };

/**
 * Persist a layout.
 *
 * `ifUnmodifiedSince` implements the optimistic concurrency the design calls
 * for: staff setting a client's default and the client editing it are writing
 * the SAME row, so without it the later write silently wins and the earlier
 * editor never learns their change is gone. With it, the loser gets a 409 and
 * the panel can say who edited it and when.
 *
 * Enforced in the UPDATE's WHERE clause rather than by read-then-write, so two
 * requests arriving together cannot both pass the check.
 */
export async function saveLayout(
  clientId: string,
  audience: LayoutAudience,
  input: {
    sections: Array<{ id: string; visible: boolean }>;
    locked?: boolean;
    updatedBy: string | null;
    ifUnmodifiedSince?: string;
  },
): Promise<SaveOutcome> {
  // Canonicalise: what gets stored is what the renderer would have produced.
  const canonical = resolveLayoutFull(input.sections, {
    staff: audience === "staff",
  }).map((s) => ({
    id: s.def.id,
    visible: s.visible,
  }));

  const now = new Date();
  const base = {
    sections: canonical,
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    updatedAt: now,
    updatedBy: input.updatedBy,
  };

  // Only ever set explicitly, never spread — `locked` must be untouchable from
  // a payload that did not name it. See `layout-write.ts`.
  const set: Record<string, unknown> = { ...base };
  if (input.locked !== undefined) set.locked = input.locked;

  if (input.ifUnmodifiedSince) {
    const expected = new Date(input.ifUnmodifiedSince);
    const updated = await db
      .update(dashboardLayouts)
      .set(set)
      .where(
        and(
          eq(dashboardLayouts.clientId, clientId),
          eq(dashboardLayouts.audience, audience),
          /*
           * 🔴 MILLISECOND precision, and the precision is the whole mechanism.
           *
           * This was written as `date_trunc('second', …)` out of a worry that
           * `updated_at` round-trips through JSON as an ISO string while
           * Postgres stores microseconds. A test caught what that costs: two
           * writes inside the same second both matched the same stale stamp, so
           * the check passed for both and one edit vanished — the exact race the
           * mechanism exists to catch, in the exact timeframe races happen.
           *
           * The worry was also unfounded. `updated_at` is written from a JS
           * `Date`, which carries millisecond precision and no more, so a
           * millisecond comparison is lossless in both directions.
           */
          sql`date_trunc('milliseconds', ${dashboardLayouts.updatedAt}) = date_trunc('milliseconds', ${expected.toISOString()}::timestamptz)`,
        ),
      )
      .returning({ id: dashboardLayouts.id });

    if (updated.length === 0) {
      /*
       * Either someone else wrote first, or there is no row yet. Both are
       * reported as a conflict: a conditional write against a row that does not
       * exist is a caller working from a view of the world that was never true.
       */
      return { ok: false, conflict: true, current: await getLayout(clientId, audience) };
    }
    return { ok: true, row: await getLayout(clientId, audience) };
  }

  await db
    .insert(dashboardLayouts)
    .values({ clientId, audience, ...base, ...(set as object) })
    .onConflictDoUpdate({
      target: [dashboardLayouts.clientId, dashboardLayouts.audience],
      set,
    });

  return { ok: true, row: await getLayout(clientId, audience) };
}

/** Reset to code defaults by deleting the row rather than storing a copy of them. */
export async function resetLayout(
  clientId: string,
  audience: LayoutAudience,
): Promise<void> {
  /*
   * Deleting, not writing today's defaults. A stored copy of the defaults stops
   * tracking them: a section shipped next month would arrive visible for
   * everyone on real defaults and be governed by a frozen snapshot for anyone
   * who had ever pressed Reset.
   */
  await db
    .delete(dashboardLayouts)
    .where(
      and(
        eq(dashboardLayouts.clientId, clientId),
        eq(dashboardLayouts.audience, audience),
      ),
    );
}
