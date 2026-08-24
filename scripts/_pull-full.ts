/**
 * One-off: run the FULL Meta sync (ad-level creatives + audience breakdowns)
 * for every active client, which is what the nightly cron does.
 *
 * Needed once because `fb_breakdown_metrics`, `meta_ad_creatives` and the
 * ad-level rows in `fb_daily_metrics` only became storable when the schema was
 * pushed — so no sync has ever written them.
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { eq } from "drizzle-orm";
import { syncClientMetrics } from "@/lib/meta/sync";
import { trailingWindowInclusive } from "@/lib/dates";

const DAYS = Number(process.env.PULL_DAYS ?? 30);

async function main() {
  const rows = await db.select().from(clients).where(eq(clients.status, "active"));
  console.log(`${rows.length} active client(s), pulling ${DAYS} days\n`);

  for (const client of rows) {
    const window = trailingWindowInclusive(DAYS, client.timezone);
    process.stdout.write(`${client.slug.padEnd(20)} ${window.startKey} → ${window.endKey} ... `);
    try {
      const { rowsWritten } = await syncClientMetrics(client, {
        since: window.startKey,
        until: window.endKey,
        includeReach: true,
        isReconcile: true,
        includeAdLevel: true,
        includeBreakdowns: true,
      });
      console.log(`✅ ${rowsWritten} rows`);
    } catch (err) {
      const e = err as { message?: string; cause?: unknown };
      const cause = e.cause as
        | { message?: string; detail?: string; column?: string; code?: string }
        | undefined;
      console.log(`❌ ${cause?.message ?? e.message?.slice(0, 120)}`);
      if (cause?.detail) console.log(`   detail: ${cause.detail}`);
      if (cause?.column) console.log(`   column: ${cause.column}`);
      if (cause?.code) console.log(`   code:   ${cause.code}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
