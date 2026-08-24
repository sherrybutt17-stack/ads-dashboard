/**
 * Re-derive contact attribution from the raw payloads we already stored.
 *
 * This is NOT a migration and it fetches nothing. Every contact row keeps the
 * original attribution object in `raw_attribution`; the ids were simply read out
 * of the wrong places. Re-parsing recovers:
 *
 *   - campaign ids for leads that had none (read from `utm_id`, where this
 *     account's setup actually puts them),
 *   - ad-set ids, which had ZERO coverage because the old parser read
 *     `.adGroupId` — null on every production row,
 *   - `gclid` / `google_campaign_id`, never written by any code path before,
 *   - and it moves any campaign id that belongs to Google out of the Meta
 *     column, where it had been inflating the Facebook tab.
 *
 * Only ever fills or corrects: a value already present is left alone unless the
 * platform verdict says it is on the wrong platform. Idempotent — running twice
 * changes nothing the second time.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-attribution.ts [--apply]
 *
 * Dry run by default. Prints exactly what it would change.
 */
import { eq, isNotNull, and } from "drizzle-orm";
import { db } from "../src/db";
import { contacts, clients } from "../src/db/schema";
import {
  parseAttribution,
  normalizeRawAttribution,
} from "../src/lib/ghl/attribution";

const APPLY = process.argv.includes("--apply");

interface Change {
  id: string;
  field: string;
  from: string | null;
  to: string | null;
}

async function main() {
  const clientRows = await db.select().from(clients);

  let scanned = 0;
  const changes: Change[] = [];
  const perClient: Record<string, number> = {};

  for (const client of clientRows) {
    const rows = await db
      .select({
        id: contacts.id,
        metaCampaignId: contacts.metaCampaignId,
        metaAdsetId: contacts.metaAdsetId,
        metaAdId: contacts.metaAdId,
        googleCampaignId: contacts.googleCampaignId,
        gclid: contacts.gclid,
        raw: contacts.rawAttribution,
      })
      .from(contacts)
      .where(
        and(eq(contacts.clientId, client.id), isNotNull(contacts.rawAttribution)),
      );

    for (const row of rows) {
      scanned++;
      const parsed = parseAttribution(normalizeRawAttribution(row.raw));

      const next: Record<string, string | null> = {};
      const consider = (field: string, current: string | null, derived: string | null) => {
        // Fill a gap, or correct a value the platform verdict contradicts.
        // Never blank a value we cannot re-derive — the raw payload may predate
        // a field GHL has since started sending.
        if (derived && derived !== current) {
          next[field] = derived;
          changes.push({ id: row.id, field, from: current, to: derived });
        } else if (
          current &&
          !derived &&
          parsed.platform !== "unknown" &&
          // Only clear a Meta id when we are confident the lead is Google's,
          // and vice versa. An `unknown` verdict never clears anything.
          ((field.startsWith("meta") && parsed.platform === "google") ||
            (field.startsWith("google") && parsed.platform === "meta"))
        ) {
          next[field] = null;
          changes.push({ id: row.id, field, from: current, to: null });
        }
      };

      consider("metaCampaignId", row.metaCampaignId, parsed.metaCampaignId);
      consider("metaAdsetId", row.metaAdsetId, parsed.metaAdsetId);
      consider("metaAdId", row.metaAdId, parsed.metaAdId);
      consider("googleCampaignId", row.googleCampaignId, parsed.googleCampaignId);
      consider("gclid", row.gclid, parsed.gclid);

      if (Object.keys(next).length > 0) {
        perClient[client.slug] = (perClient[client.slug] ?? 0) + 1;
        if (APPLY) {
          await db.update(contacts).set(next).where(eq(contacts.id, row.id));
        }
      }
    }
  }

  const byField: Record<string, { filled: number; corrected: number; cleared: number }> = {};
  for (const c of changes) {
    byField[c.field] ??= { filled: 0, corrected: 0, cleared: 0 };
    if (c.to === null) byField[c.field].cleared++;
    else if (c.from === null) byField[c.field].filled++;
    else byField[c.field].corrected++;
  }

  console.log(`${APPLY ? "APPLIED" : "DRY RUN"} — scanned ${scanned} contacts\n`);
  console.log("field".padEnd(20), "filled".padEnd(8), "corrected".padEnd(11), "cleared");
  for (const [f, v] of Object.entries(byField)) {
    console.log(
      f.padEnd(20),
      String(v.filled).padEnd(8),
      String(v.corrected).padEnd(11),
      String(v.cleared),
    );
  }
  console.log("\ncontacts touched by client:", perClient);
  if (!APPLY) console.log("\nRe-run with --apply to write.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
