/** What does the dashboard actually render for the ranges a demo will use? */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { clients } from "../src/db/schema";
import { getPeriodMetrics } from "../src/lib/metrics/queries";
import { windowFromKeys, trailingWindowInclusive } from "../src/lib/dates";

async function main() {
  const [c] = await db.select().from(clients).where(eq(clients.slug, "gg-ads"));
  const ranges: Array<[string, string, string]> = [
    ["last 30d (DEFAULT)", ...(() => { const w = trailingWindowInclusive(30, c.timezone); return [w.startKey, w.endKey] as [string, string]; })()],
    ["last 7d", ...(() => { const w = trailingWindowInclusive(7, c.timezone); return [w.startKey, w.endKey] as [string, string]; })()],
    ["August 2026", "2026-08-01", "2026-08-31"],
    ["July 2026", "2026-07-01", "2026-07-31"],
    ["September MTD", "2026-09-01", "2026-09-13"],
    ["year to date", "2026-01-01", "2026-09-13"],
  ];
  console.log("range                 leads  appts  shows   book%    show%   CP-LEAD   metaLeads");
  for (const [label, s, e] of ranges) {
    const w = windowFromKeys(s, e, c.timezone);
    const m = await getPeriodMetrics(c.id, w, label, undefined, undefined, "meta");
    const f = m.funnel, d = m.derived;
    const pct = (v: number | null) => (v === null ? "  –   " : (v * 100).toFixed(1).padStart(6));
    const flag = d.bookPct !== null && d.bookPct > 1 ? "  ⚠️ >100%" : "";
    console.log(
      `${label.padEnd(20)} ${String(f.new_lead).padStart(5)} ${String(f.appointment_booked).padStart(6)} ${String(f.showed).padStart(6)} ` +
      `${pct(d.bookPct)}  ${pct(d.showPct)}  ${(d.cpLead === null ? "–" : "$" + d.cpLead.toFixed(2)).padStart(9)}  ${String(m.ads.fbLeads).padStart(9)}${flag}`);
  }
}
main();
