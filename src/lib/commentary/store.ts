import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { monthlyCommentary, type MonthlyCommentaryRow } from "@/db/schema";
import type { AdPlatform } from "@/lib/metrics/queries";
import {
  parseCommitments,
  parseOutcomes,
  previousMonthKey,
  type Commitment,
  type Outcome,
} from "./model";

/**
 * Reading and writing monthly commentary.
 *
 * Two write paths and two read paths, split the same way §6.2's summary store
 * is, and for the same reason: the guarantee that a client cannot be shown an
 * unfinished note should be a property of which function you can call, not of
 * which argument you passed.
 *
 *   `saveCommentary`      — what a person types. Cannot publish.
 *   `publishCommentary`   — the only function that writes the frozen columns.
 *
 *   `getCommentary`       — the working copy, for the agency's editor.
 *   `getPublishedMonths`  — the frozen copy, for the client's report.
 *
 * 🔴 `getPublishedMonths` selects the published columns and maps them into the
 * plain fields, so a report renderer physically cannot reach a draft even by
 * asking for the wrong property name.
 */

export interface CommentaryKey {
  clientId: string;
  platform: AdPlatform;
  month: string;
}

export interface CommentaryContent {
  did: string;
  commitments: Commitment[];
  outcomes: Outcome[];
}

export interface StoredCommentary extends CommentaryContent {
  month: string;
  published: (CommentaryContent & { at: string; by: string | null }) | null;
  hasUnpublishedChanges: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

function contentOf(r: MonthlyCommentaryRow): CommentaryContent {
  return {
    did: r.did,
    commitments: parseCommitments(r.commitments),
    outcomes: parseOutcomes(r.outcomes),
  };
}

function publishedContentOf(r: MonthlyCommentaryRow): CommentaryContent | null {
  if (r.publishedAt === null || r.publishedDid === null) return null;
  return {
    did: r.publishedDid,
    commitments: parseCommitments(r.publishedCommitments),
    outcomes: parseOutcomes(r.publishedOutcomes),
  };
}

function sameContent(a: CommentaryContent, b: CommentaryContent): boolean {
  return (
    a.did === b.did &&
    JSON.stringify(a.commitments) === JSON.stringify(b.commitments) &&
    JSON.stringify(a.outcomes) === JSON.stringify(b.outcomes)
  );
}

function toStored(r: MonthlyCommentaryRow): StoredCommentary {
  const working = contentOf(r);
  const frozen = publishedContentOf(r);
  return {
    month: r.month,
    ...working,
    published: frozen
      ? { ...frozen, at: r.publishedAt!.toISOString(), by: r.publishedBy }
      : null,
    hasUnpublishedChanges: frozen !== null && !sameContent(working, frozen),
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedBy,
  };
}

/**
 * The working copy for one month, plus the previous month's PUBLISHED plan.
 *
 * 🔴 The prior plan is the published one even here, in the agency's own editor.
 * A commitment that was never published was never made to anyone — it is a
 * private note — and answering it on a report would present the client with a
 * promise they never received. Holding both surfaces to the same rule is what
 * stops the editor and the report disagreeing about what was owed.
 *
 * Degrades to nulls rather than throwing, like every other migration-dependent
 * read here: a table that does not exist yet must cost this panel, not the page.
 */
export async function getCommentary(k: CommentaryKey): Promise<{
  current: StoredCommentary | null;
  prior: { month: string; commitments: Commitment[]; published: boolean } | null;
  error: string | null;
}> {
  const priorMonth = previousMonthKey(k.month);
  try {
    const rows = await db
      .select()
      .from(monthlyCommentary)
      .where(
        and(
          eq(monthlyCommentary.clientId, k.clientId),
          eq(monthlyCommentary.platform, k.platform),
          inArray(monthlyCommentary.month, [k.month, priorMonth]),
        ),
      );

    const currentRow = rows.find((r) => r.month === k.month) ?? null;
    const priorRow = rows.find((r) => r.month === priorMonth) ?? null;
    const priorPublished = priorRow ? publishedContentOf(priorRow) : null;

    return {
      current: currentRow ? toStored(currentRow) : null,
      prior: priorRow
        ? {
            month: priorMonth,
            commitments: priorPublished?.commitments ?? [],
            published: priorPublished !== null,
          }
        : null,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[commentary] unavailable:", message);
    return { current: null, prior: null, error: message };
  }
}

/**
 * The frozen copy for a month and the one before it — everything a report may
 * read, and nothing else.
 *
 * Returns the two separately rather than assembling the accountability here
 * because assembling it needs the month's figures, which this module has no
 * business fetching. See `report.ts`.
 */
export async function getPublishedMonths(k: CommentaryKey): Promise<{
  current: CommentaryContent | null;
  prior: { month: string; commitments: Commitment[] } | null;
}> {
  const priorMonth = previousMonthKey(k.month);
  try {
    const rows = await db
      .select()
      .from(monthlyCommentary)
      .where(
        and(
          eq(monthlyCommentary.clientId, k.clientId),
          eq(monthlyCommentary.platform, k.platform),
          inArray(monthlyCommentary.month, [k.month, priorMonth]),
        ),
      );

    const currentRow = rows.find((r) => r.month === k.month);
    const current = currentRow ? publishedContentOf(currentRow) : null;
    const priorRow = rows.find((r) => r.month === priorMonth);
    const prior = priorRow ? publishedContentOf(priorRow) : null;

    return {
      current,
      prior: prior ? { month: priorMonth, commitments: prior.commitments } : null,
    };
  } catch (err) {
    console.error("[commentary] published read failed:", err);
    return { current: null, prior: null };
  }
}

/** Store what a person typed. Never touches the published columns. */
export async function saveCommentary(
  k: CommentaryKey,
  content: CommentaryContent,
  actor: string,
): Promise<StoredCommentary> {
  const values = {
    clientId: k.clientId,
    platform: k.platform,
    month: k.month,
    did: content.did,
    commitments: content.commitments,
    outcomes: content.outcomes,
    updatedAt: new Date(),
    updatedBy: actor,
  };

  const [row] = await db
    .insert(monthlyCommentary)
    .values(values)
    .onConflictDoUpdate({
      target: [
        monthlyCommentary.clientId,
        monthlyCommentary.platform,
        monthlyCommentary.month,
      ],
      /*
       * An explicit column list, never a spread of `values`. A spread is one
       * careless edit away from carrying a `publishedDid` key into the update,
       * which is exactly the escape hatch this design closes.
       */
      set: {
        did: values.did,
        commitments: values.commitments,
        outcomes: values.outcomes,
        updatedAt: values.updatedAt,
        updatedBy: values.updatedBy,
      },
    })
    .returning();

  return toStored(row);
}

/**
 * Freeze the working copy as the published one.
 *
 * 🔴 The only function that writes `published_*`. It copies column-to-column
 * rather than from a request body, so what reaches a client is necessarily the
 * text that was stored and reviewed — a caller cannot smuggle different prose
 * into the published copy in the same call.
 */
export async function publishCommentary(
  k: CommentaryKey,
  actor: string,
): Promise<StoredCommentary | null> {
  const [row] = await db
    .update(monthlyCommentary)
    .set({
      publishedDid: monthlyCommentary.did,
      publishedCommitments: monthlyCommentary.commitments,
      publishedOutcomes: monthlyCommentary.outcomes,
      publishedAt: new Date(),
      publishedBy: actor,
    })
    .where(where(k))
    .returning();
  return row ? toStored(row) : null;
}

/** Withdraw a published commentary. The working copy is left untouched. */
export async function unpublishCommentary(
  k: CommentaryKey,
): Promise<StoredCommentary | null> {
  const [row] = await db
    .update(monthlyCommentary)
    .set({
      publishedDid: null,
      publishedCommitments: null,
      publishedOutcomes: null,
      publishedAt: null,
      publishedBy: null,
    })
    .where(where(k))
    .returning();
  return row ? toStored(row) : null;
}

function where(k: CommentaryKey) {
  return and(
    eq(monthlyCommentary.clientId, k.clientId),
    eq(monthlyCommentary.platform, k.platform),
    eq(monthlyCommentary.month, k.month),
  );
}
