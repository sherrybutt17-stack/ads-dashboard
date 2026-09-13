import { db } from "../src/db";
import { clients } from "../src/db/schema";
import { getAdDataExtent, getAdTotals } from "../src/lib/metrics/queries";
import { getAdPipeStatus } from "../src/lib/metrics/pipe-status";
import { trailingWindowInclusive } from "../src/lib/dates";
import { outOfRangeNotice } from "../src/lib/metrics/data-extent";

async function main() {
  for (const c of await db.select().from(clients)) {
    const w = trailingWindowInclusive(30, c.timezone);
    const [totals, extent, pipe] = await Promise.all([
      getAdTotals(c.id, w, undefined, "meta"),
      getAdDataExtent(c.id, "meta"),
      getAdPipeStatus(c, "meta"),
    ]);
    const notice = outOfRangeNotice(w, extent);
    console.log(
      `${c.slug.padEnd(22)} ${c.status.padEnd(8)} pipe=${pipe.state.padEnd(14)} ` +
      `30d spend=$${totals.spend.toFixed(2).padStart(9)} | extent=${extent ? `${extent.firstKey}..${extent.lastKey}` : "none"} ` +
      `| banner=${notice ? "YES -> " + notice.firstKey + ".." + notice.lastKey : "no"}`);
  }
}
main();
