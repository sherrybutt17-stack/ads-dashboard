/**
 * Backfill a client's TikTok history.
 *
 * Run: npx tsx --env-file=.env.local scripts/backfill-tiktok.ts <slug> <days>
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { clients } from "../src/db/schema";
import { backfillClientTiktokMetrics } from "../src/lib/tiktok/sync";

async function main() {
  const slug = process.argv[2] ?? "ebbie";
  const days = Number(process.argv[3] ?? 1000);
  const [client] = await db.select().from(clients).where(eq(clients.slug, slug));
  if (!client) throw new Error(`no client ${slug}`);
  console.log(`backfilling ${slug} (${client.timezone}) over ${days} days…`);
  console.log(`wrote ${await backfillClientTiktokMetrics(client, days)} rows`);
}
main();
