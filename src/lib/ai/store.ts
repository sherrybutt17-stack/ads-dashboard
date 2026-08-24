import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { reportSummaries, type ReportSummaryRow } from "@/db/schema";
import type { AdPlatform } from "@/lib/metrics/queries";
import type { SummaryDraft } from "./summary";
import type { Framing } from "./framings";
import type { VerifyResult } from "./verify";

/**
 * Reading and writing the written summaries.
 *
 * Three write paths, deliberately separate rather than one `save()` with a
 * status argument:
 *
 *   `saveDraft`   — what generation produces. Cannot publish.
 *   `saveEdits`   — what a person types. Cannot publish.
 *   `publish`     — the only function that writes the frozen copy.
 *
 * A single function taking `{ published: boolean }` would put the whole
 * guarantee behind one caller passing the right argument. This way "the model
 * published something" is not a bug that can be written.
 */

export interface SummaryPeriod {
  clientId: string;
  platform: AdPlatform;
  rangeStart: string;
  rangeEnd: string;
}

export interface StoredSummary {
  framing: Framing;
  headline: string;
  body: string;
  verification: VerifyResult | null;
  model: string | null;
  updatedAt: string;
  updatedBy: string | null;
  published: {
    headline: string;
    body: string;
    at: string;
    by: string | null;
  } | null;
  /** The working copy differs from what was published. */
  hasUnpublishedChanges: boolean;
}

function where(p: SummaryPeriod, framing?: Framing) {
  const clauses = [
    eq(reportSummaries.clientId, p.clientId),
    eq(reportSummaries.platform, p.platform),
    eq(reportSummaries.rangeStart, p.rangeStart),
    eq(reportSummaries.rangeEnd, p.rangeEnd),
  ];
  if (framing) clauses.push(eq(reportSummaries.framing, framing));
  return and(...clauses);
}

function toStored(r: ReportSummaryRow): StoredSummary {
  const published =
    r.publishedBody != null && r.publishedAt != null
      ? {
          headline: r.publishedHeadline ?? "",
          body: r.publishedBody,
          at: r.publishedAt.toISOString(),
          by: r.publishedBy,
        }
      : null;
  return {
    framing: r.framing,
    headline: r.headline,
    body: r.body,
    verification: (r.verification as VerifyResult | null) ?? null,
    model: r.model,
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedBy,
    published,
    hasUnpublishedChanges:
      published !== null &&
      (published.headline !== r.headline || published.body !== r.body),
  };
}

/**
 * Every framing stored for a period.
 *
 * Degrades to an empty list rather than throwing, in line with every other
 * migration-dependent read on the dashboard: a table that does not exist yet
 * must cost the summary panel, not the page.
 */
export async function listSummaries(p: SummaryPeriod): Promise<{
  summaries: StoredSummary[];
  error: string | null;
}> {
  try {
    const rows = await db.select().from(reportSummaries).where(where(p));
    return { summaries: rows.map(toStored), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[summary] unavailable:", message);
    return { summaries: [], error: message };
  }
}

/**
 * What the CLIENT-facing report may read: the frozen copy, and nothing else.
 *
 * A working draft — however good, however recently generated — is not a
 * document the agency has stood behind. Reading `body` here instead of
 * `published_body` would make every regeneration instantly visible to whoever
 * holds the share link.
 */
export async function getPublishedSummaries(
  p: SummaryPeriod,
): Promise<Array<{ framing: Framing; headline: string; body: string }>> {
  try {
    const rows = await db.select().from(reportSummaries).where(where(p));
    return rows
      .filter((r) => r.publishedBody != null && r.publishedAt != null)
      .map((r) => ({
        framing: r.framing,
        headline: r.publishedHeadline ?? "",
        body: r.publishedBody!,
      }));
  } catch (err) {
    console.error("[summary] published read failed:", err);
    return [];
  }
}

/** Store a freshly generated draft. Never touches the published columns. */
export async function saveDraft(
  p: SummaryPeriod,
  draft: SummaryDraft,
  actor: string,
): Promise<StoredSummary> {
  const values = {
    clientId: p.clientId,
    platform: p.platform,
    rangeStart: p.rangeStart,
    rangeEnd: p.rangeEnd,
    framing: draft.framing,
    headline: draft.headline,
    body: draft.body,
    verification: draft.verification,
    generatedBy: actor,
    model: draft.model,
    updatedAt: new Date(),
    updatedBy: actor,
  };

  const [row] = await db
    .insert(reportSummaries)
    .values(values)
    .onConflictDoUpdate({
      target: [
        reportSummaries.clientId,
        reportSummaries.platform,
        reportSummaries.rangeStart,
        reportSummaries.rangeEnd,
        reportSummaries.framing,
      ],
      /*
       * Explicit column list, never a spread of `values`. A spread would be
       * one careless edit away from carrying a `publishedBody` key into the
       * update — which is exactly the escape hatch this whole design closes.
       */
      set: {
        headline: values.headline,
        body: values.body,
        verification: values.verification,
        generatedBy: values.generatedBy,
        model: values.model,
        updatedAt: values.updatedAt,
        updatedBy: values.updatedBy,
      },
    })
    .returning();

  return toStored(row);
}

/**
 * A person's edits.
 *
 * `generatedBy` and `model` are cleared: once someone has rewritten the text it
 * is theirs, and continuing to label it as model output would misattribute an
 * agency's own words. The verification is recomputed by the caller, which has
 * the brief; storing a stale one would be worse than storing none.
 */
export async function saveEdits(
  p: SummaryPeriod,
  framing: Framing,
  edits: { headline: string; body: string; verification: VerifyResult | null },
  actor: string,
): Promise<StoredSummary | null> {
  const [row] = await db
    .update(reportSummaries)
    .set({
      headline: edits.headline,
      body: edits.body,
      verification: edits.verification,
      generatedBy: null,
      model: null,
      updatedAt: new Date(),
      updatedBy: actor,
    })
    .where(where(p, framing))
    .returning();
  return row ? toStored(row) : null;
}

/**
 * Freeze the working copy as the published one.
 *
 * 🔴 The only function in the codebase that writes `published_*`. It copies
 * from the row rather than from a request body, so what gets published is
 * necessarily the text that was stored and reviewed — a caller cannot smuggle
 * different prose into the published copy in the same call.
 */
export async function publishSummary(
  p: SummaryPeriod,
  framing: Framing,
  actor: string,
): Promise<StoredSummary | null> {
  const [row] = await db
    .update(reportSummaries)
    .set({
      publishedHeadline: reportSummaries.headline,
      publishedBody: reportSummaries.body,
      publishedAt: new Date(),
      publishedBy: actor,
    })
    .where(where(p, framing))
    .returning();
  return row ? toStored(row) : null;
}

/** Withdraw a published summary. The working copy is left untouched. */
export async function unpublishSummary(
  p: SummaryPeriod,
  framing: Framing,
): Promise<StoredSummary | null> {
  const [row] = await db
    .update(reportSummaries)
    .set({
      publishedHeadline: null,
      publishedBody: null,
      publishedAt: null,
      publishedBy: null,
    })
    .where(where(p, framing))
    .returning();
  return row ? toStored(row) : null;
}
