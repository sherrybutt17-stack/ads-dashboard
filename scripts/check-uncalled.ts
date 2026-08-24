/**
 * The call list, on live data. Read-only.
 *
 * Two things to watch. First, whether the list is short enough to be a list —
 * a "call these people" panel that returns eighty names is a database export.
 * Second, whether anybody on it looks like they have already been dealt with;
 * one such row is all it takes for a client to stop trusting the panel.
 *
 *   npx tsx --env-file=.env.local scripts/check-uncalled.ts [slug]
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { getUncalledLeads } from "@/lib/metrics/queries";
import { buildUncalled, measureWorkingDays } from "@/lib/metrics/uncalled";

const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function main() {
  const slug = process.argv[2];
  const all = (await db.select().from(clients)).filter(
    (c) => c.status !== "archived" && (!slug || c.slug === slug),
  );

  for (const c of all) {
    const input = await getUncalledLeads(
      c.id,
      c.timezone,
      { mode: c.paidLeadFilter, tag: c.paidLeadTag },
      "meta",
    );
    const r = buildUncalled(input.leads, {
      callWeekdays: input.callWeekdays,
      trackingStartedAt: input.trackingStartedAt,
      preTracking: input.preTracking,
      costPerLead: input.costPerLead,
    });

    console.log(`\n=== ${c.name} (${c.slug})  tz=${c.timezone}  filter=${c.paidLeadFilter}`);
    if (r.trackingStartedAt === null) {
      console.log("    no call visibility yet — every lead is unknown, not uncalled");
      continue;
    }
    console.log(
      `    tracking since ${r.trackingStartedAt.slice(0, 10)}  ·  ${input.leads.length} uncalled trackable leads fetched`,
    );
    console.log(
      `    working week: ${
        r.workingDays ? r.workingDays.map((d) => WEEKDAY[d]).join(" ") : "not measurable"
      }  (from ${input.callWeekdays.reduce((n, d) => n + d.calls, 0)} calls: ${input.callWeekdays
        .sort((a, b) => a.dow - b.dow)
        .map((d) => `${WEEKDAY[d.dow]}=${d.calls}`)
        .join(" ")})`,
    );
    console.log(
      `    CALLABLE ${r.callable}  (replied ${r.replied})   cost ${
        r.wastedSpend === null ? "-" : r.wastedSpend.toFixed(0)
      }   cpl ${input.costPerLead === null ? "-" : input.costPerLead.toFixed(2)}`,
    );
    console.log(
      `    excluded: progressed ${r.progressed}  closed ${r.closedWithoutCall}  ` +
        `no-phone ${r.noPhone}  too-recent ${r.tooRecent}  outside-filter ${r.outsideFilter}  ` +
        `pre-tracking ${r.preTracking}`,
    );

    for (const row of r.rows) {
      console.log(
        `      ${String(row.workingDaysWaiting).padStart(3)}wd ${String(row.calendarDays).padStart(4)}d  ` +
          `${row.kind.padEnd(9)}  ${(row.name ?? "?").slice(0, 24).padEnd(24)}  ` +
          `${row.noOpportunity ? "NO OPP" : (row.ghlStageName ?? row.stageLabel ?? "unmapped")}`,
      );
    }
    if (r.notListed > 0) console.log(`      … and ${r.notListed} more`);

    /*
     * What the panel would have said with a threshold measured from this
     * client's own response times, the way the aging panel measures its bars.
     * Printed as a sanity check on the decision NOT to do that here.
     */
    const days = measureWorkingDays(input.callWeekdays);
    if (days === null) console.log("    (clock is falling back to calendar days)");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
