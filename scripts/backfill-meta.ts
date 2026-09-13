/**
 * Backfill a client's Meta history over an arbitrary window.
 *
 * Run: npx tsx --env-file=.env.local scripts/backfill-meta.ts <slug> <days>
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { clients } from "../src/db/schema";
import { backfillClientMetrics } from "../src/lib/meta/sync";

async function main() {
  const slug = process.argv[2] ?? "new-fb-ads-testing";
  const days = Number(process.argv[3] ?? 800);
  const [client] = await db.select().from(clients).where(eq(clients.slug, slug));
  if (!client) throw new Error(`no client ${slug}`);
  console.log(`backfilling ${slug} (${client.timezone}) over ${days} days…`);
  const rows = await backfillClientMetrics(client, days);
  console.log(`wrote ${rows} rows`);
}
main();
