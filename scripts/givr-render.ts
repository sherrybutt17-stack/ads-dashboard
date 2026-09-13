/** What would the dashboard query return for GIVR over its real window? */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { clients } from "../src/db/schema";
import { getPeriodMetrics } from "../src/lib/metrics/queries";
import { windowFromKeys } from "../src/lib/dates";

async function main() {
  const [c] = await db.select().from(clients).where(eq(clients.slug, "new-fb-ads-testing"));
  console.log("client:", { slug: c.slug, tz: c.timezone, status: c.status, paidLeadFilter: (c as any).paidLeadFilter });
  for (const [label, startKey, endKey] of [
    ["lifetime", "2024-07-01", "2025-05-01"],
    ["last 30d", "2026-08-14", "2026-09-13"],
  ] as const) {
    const w = windowFromKeys(startKey, endKey, c.timezone);
    const m = await getPeriodMetrics(c.id, w, label, undefined, undefined, "meta");
    console.log(label, JSON.stringify(m, null, 1).slice(0, 700));
  }
}
main();
