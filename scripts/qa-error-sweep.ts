/** Every error the application itself has recorded, and every silent-zero run. */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const q = async (t: string) => {
  for (let i = 0; i < 6; i++) {
    try { return (await sql.query(t)) as any[]; }
    catch { await new Promise(r => setTimeout(r, 900 * (i + 1))); }
  }
  throw new Error("db unavailable");
};

async function main() {
  console.log("=== sync_runs: failures, ever ===");
  const f = await q(`
    SELECT c.slug, s.kind::text, s.status, s.started_at::text, left(s.error, 150) err
      FROM sync_runs s LEFT JOIN clients c ON c.id=s.client_id
     WHERE s.status = 'failed' ORDER BY s.started_at DESC LIMIT 15`);
  console.log(f.length ? "" : "  none");
  f.forEach((r: any) => console.log(`  ${r.started_at.slice(0,16)} ${String(r.slug).padEnd(20)} ${r.kind.padEnd(14)} ${r.err}`));

  console.log("\n=== sync_runs: stuck in 'running' ===");
  const r2 = await q(`
    SELECT c.slug, s.kind::text, s.started_at::text
      FROM sync_runs s LEFT JOIN clients c ON c.id=s.client_id
     WHERE s.status='running' ORDER BY s.started_at DESC LIMIT 10`);
  console.log(r2.length ? "" : "  none");
  r2.forEach((r: any) => console.log(`  ${r.started_at.slice(0,16)} ${r.slug} ${r.kind}`));

  console.log("\n=== webhook_events: errors / ignored ===");
  const w = await q(`
    SELECT status, COUNT(*)::int n, MAX(received_at)::text last, left(MAX(error), 120) sample
      FROM webhook_events GROUP BY status ORDER BY n DESC`);
  w.forEach((r: any) => console.log(`  ${String(r.status).padEnd(10)} ${String(r.n).padStart(6)}  last ${String(r.last).slice(0,16)}  ${r.sample ?? ""}`));

  console.log("\n=== webhook_events: distinct error texts ===");
  const we = await q(`
    SELECT left(error, 130) err, COUNT(*)::int n, MAX(received_at)::text last
      FROM webhook_events WHERE error IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 10`);
  console.log(we.length ? "" : "  none");
  we.forEach((r: any) => console.log(`  ${String(r.n).padStart(5)}  last ${String(r.last).slice(0,16)}  ${r.err}`));

  console.log("\n=== recent syncs that SUCCEEDED but wrote nothing ===");
  const z = await q(`
    SELECT c.slug, s.kind::text, COUNT(*)::int runs, MAX(s.started_at)::text last
      FROM sync_runs s JOIN clients c ON c.id=s.client_id
     WHERE s.status='success' AND COALESCE(s.rows_written,0)=0
       AND s.started_at > now() - interval '7 days'
     GROUP BY 1,2 ORDER BY runs DESC LIMIT 10`);
  console.log(z.length ? "" : "  none");
  z.forEach((r: any) => console.log(`  ${String(r.slug).padEnd(20)} ${r.kind.padEnd(14)} ${String(r.runs).padStart(4)} runs, last ${r.last.slice(0,16)}`));

  console.log("\n=== connect_stash: stale rows (abandoned connects) ===");
  const cs = await q(`
    SELECT provider, COUNT(*)::int n, MAX(created_at)::text last,
           COUNT(*) FILTER (WHERE expires_at < now())::int expired
      FROM connect_stash GROUP BY provider`);
  console.log(cs.length ? "" : "  none");
  cs.forEach((r: any) => console.log(`  ${String(r.provider).padEnd(8)} ${r.n} rows (${r.expired} expired), last ${String(r.last).slice(0,16)}`));
}
main();
