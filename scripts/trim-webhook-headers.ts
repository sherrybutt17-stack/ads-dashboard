/**
 * One-off: strip Vercel's own `x-vercel-*` headers from stored webhook events,
 * then give the space back (27 Oct 2026: ~170 MB of a 1 GB database).
 *
 * New events no longer store them (`headersToStore`); this cleans the old.
 * Safe to run more than once, and while webhooks are arriving:
 *   · events are trimmed 1,000 at a time, each batch its own short statement;
 *   · only `x-vercel-*` keys go — GHL's signature headers, our `__signature`
 *     mark (read by the install flow) and every payload are untouched;
 *   · the space comes back via VACUUM FULL, which holds the table for its
 *     duration (seconds). It refuses to queue behind anything (lock_timeout
 *     3 s) and gives up after 2 minutes — either way nothing is lost, and
 *     webhooks that waited are retried by GHL.
 *
 * Without --apply it only reports, in a read-only session.
 *
 * Run: npx tsx --env-file=../ads-dashboard/.env scripts/trim-webhook-headers.ts [--apply]
 */
import pg from "pg";
import { COUNT_UNTRIMMED_SQL, trimStoredPlatformHeaders } from "../src/lib/webhook-headers";

const SIZES_SQL = `
SELECT pg_size_pretty(pg_total_relation_size('webhook_events')) AS events,
       pg_size_pretty(sum(pg_database_size(datname))::bigint) AS all_databases,
       current_setting('neon.max_cluster_size', true) AS limit
  FROM pg_database`;

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — pass --env-file");

  const db = new pg.Client({ connectionString: url, ssl: true });
  await db.connect();
  try {
    if (!apply) await db.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const sizes = async (when: string) => {
      const s = (await db.query(SIZES_SQL)).rows[0];
      console.log(`${when}: webhook events ${s.events} · whole database ${s.all_databases} of ${s.limit ?? "?"}`);
    };

    await sizes("Before");
    const waiting = (await db.query(COUNT_UNTRIMMED_SQL)).rows[0].n as number;
    console.log(`${waiting} stored events carry Vercel headers.`);
    if (!apply) {
      console.log("Dry run — nothing changed. Run again with --apply to trim them.");
      return;
    }

    const trimmed = await trimStoredPlatformHeaders(
      (text, params) => db.query(text, params),
      (n) => process.stdout.write(`\r  trimmed ${n} of ${waiting}…`),
    );
    console.log(`\nTrimmed ${trimmed} events. Giving the space back…`);

    await db.query("SET lock_timeout = '3s'");
    await db.query("SET statement_timeout = '120s'");
    try {
      await db.query("VACUUM (FULL, ANALYZE) webhook_events");
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "55P03" || code === "57014") {
        console.log("The table was busy, so the space wasn't given back yet. Nothing is lost — run the same command again in a few minutes.");
        return;
      }
      throw err;
    }
    await sizes("After");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
