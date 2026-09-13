/**
 * Ad-level backfill for one client over a date range, chunked by month.
 *
 * The bulk backfill pulls campaign level only, which is all the KPI row and the
 * trend chart need. The creative grid needs ad level, so a dormant account
 * restored from history has spend but no creatives until this runs.
 *
 * Run: npx tsx --env-file=.env.local scripts/backfill-adlevel.ts <slug> <since> <until>
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { clients } from "../src/db/schema";
import { syncClientMetrics } from "../src/lib/meta/sync";

async function main() {
  const slug = process.argv[2] ?? "new-fb-ads-testing";
  const since = process.argv[3] ?? "2024-07-01";
  const until = process.argv[4] ?? "2025-04-30";
  const [client] = await db.select().from(clients).where(eq(clients.slug, slug));
  if (!client) throw new Error(`no client ${slug}`);

  let cursor = since;
  let total = 0;
  while (cursor <= until) {
    const [y, m] = cursor.split("-").map(Number);
    const lastOfMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const chunkEnd = lastOfMonth < until ? lastOfMonth : until;
    const res = await syncClientMetrics(client, {
      since: cursor,
      until: chunkEnd,
      includeAdLevel: true,
    });
    total += res.rowsWritten;
    console.log(`${cursor}..${chunkEnd}  ${res.rowsWritten} rows`);
    cursor = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`total ${total} rows`);
}
main();
