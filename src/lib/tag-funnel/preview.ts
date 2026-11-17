import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type { Client } from "@/db/schema";
import type { DateWindow } from "@/lib/dates";
import { paidLeadPredicate, type PaidLeadFilter } from "@/lib/metrics/queries";
import { FROM_AD, ensureTagHistory } from "./index";
import { normalizeTag } from "./project";

/*
 * Kept apart from ./index.ts so the webhook path, which rebuilds tag leads,
 * does not pull the whole metrics query module in with it.
 */

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

/** Thrown to roll the preview's transaction back; never escapes this file. */
class PreviewDone extends Error {}

export interface LeadPreview {
  /** Paid leads by pipeline stages, as a pipeline client's dashboard counts them. */
  pipeline: number;
  /** Paid leads the PROPOSED tag mapping would count. */
  tags: number;
  /** Paid leads by tags as the client is counted NOW — only when it is already on tags. */
  current: number | null;
}

/**
 * Paid leads in a window, for the confirmation shown before saving: by
 * pipeline, by the proposed tag mapping, and — for a client already on tags —
 * by its tags as saved now, so editing a mapping shows the real before.
 *
 * The proposed count must be the number the save will produce, so it reads the
 * same evidence the save does: tag history is seeded exactly as a save seeds it
 * (current tags AND every tag the webhook log ever showed on a contact), inside
 * a transaction that is always rolled back. Nothing is written.
 *
 * All three use the client's paid-lead rule, as the Leads tile does.
 */
export async function previewLeadCounts(
  client: Pick<Client, "id" | "paidLeadFilter" | "paidLeadTag" | "crmMappingMode">,
  proposal: { everyContact: boolean; tags: string[] },
  window: DateWindow,
): Promise<LeadPreview> {
  const filter: PaidLeadFilter = { mode: client.paidLeadFilter, tag: client.paidLeadTag };
  const paid = paidLeadPredicate(filter);
  const tags = [...new Set(proposal.tags.map(normalizeTag).filter(Boolean))];

  const ledgerLeads = async (tagRows: boolean) =>
    Number(
      rows<{ n: number }>(
        await db.execute<{ n: number }>(sql`
          SELECT COUNT(DISTINCT st.opportunity_id)::int AS n
          FROM stage_transitions st
          ${paid ? sql`JOIN contacts c ON c.id = st.contact_id` : sql``}
          WHERE st.client_id = ${client.id}
            AND ${tagRows ? sql`st.source::text = 'tag'` : sql`st.source::text <> 'tag'`}
            -- In a shared sub-account, only the people the split gives this client.
            AND NOT EXISTS (
              SELECT 1 FROM opportunities fsx WHERE fsx.id = st.opportunity_id AND fsx.share_counted = false
            )
            AND st.to_canonical::text = 'new_lead'
            AND st.changed_at >= ${window.startUtc}
            AND st.changed_at < ${window.endUtc}
            ${paid ? sql`AND ${paid}` : sql``}
        `),
      )[0]?.n ?? 0,
    );

  const pipeline = await ledgerLeads(false);
  const current = client.crmMappingMode === "tags" ? await ledgerLeads(true) : null;

  const isLead: SQL[] = [FROM_AD];
  if (proposal.everyContact) isLead.push(sql`true`);
  if (tags.length > 0) {
    // One array parameter: drizzle spreads a bare array into a row.
    isLead.push(
      sql`EXISTS (SELECT 1 FROM contact_tag_history h WHERE h.contact_id = c.id AND h.tag = ANY(${sql.param(tags)}::text[]))`,
    );
  }

  let proposed = 0;
  try {
    await db.transaction(async (tx) => {
      await ensureTagHistory(tx, client.id);
      const res = await tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n
        FROM contacts c
        WHERE c.client_id = ${client.id}
          AND c.share_counted IS NOT FALSE
          AND COALESCE(c.ghl_created_at, c.created_at) >= ${window.startUtc}
          AND COALESCE(c.ghl_created_at, c.created_at) < ${window.endUtc}
          AND (${sql.join(isLead, sql` OR `)})
          ${paid ? sql`AND ${paid}` : sql``}
      `);
      proposed = Number(rows<{ n: number }>(res)[0]?.n ?? 0);
      throw new PreviewDone();
    });
  } catch (err) {
    if (!(err instanceof PreviewDone)) throw err;
  }

  return { pipeline, tags: proposed, current };
}
