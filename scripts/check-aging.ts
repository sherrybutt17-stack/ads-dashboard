/**
 * What the aging panel says, against live data. Read-only.
 *
 * The number to watch is how many leads it flags. A bar measured correctly
 * should surface a workable list; a bar that flags four hundred leads is a bar
 * that is wrong, however defensible the statistics behind it look.
 *
 *   npx tsx --env-file=.env.local scripts/check-aging.ts [slug]
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { getStageAging } from "@/lib/metrics/queries";
import { buildAging } from "@/lib/metrics/aging";

async function main() {
  const slug = process.argv[2];
  const all = (await db.select().from(clients)).filter(
    (c) => c.status !== "archived" && (!slug || c.slug === slug),
  );

  for (const c of all) {
    const input = await getStageAging(
      c.id,
      { mode: c.paidLeadFilter, tag: c.paidLeadTag },
      "meta",
    );
    const r = buildAging(input.dwells, input.sitting);

    console.log(`\n=== ${c.name} (${c.slug})`);
    console.log(
      `    completed stays: ${input.dwells.length} · open opportunities: ${input.sitting.length}`,
    );
    const actionable = r.stages
      .filter((s) => !s.stalled)
      .reduce((n, s) => n + s.aging, 0);
    console.log(
      `    judgeable ${r.totalSitting} · overdue ${r.totalAging} (${actionable} in working stages) ` +
        `· gone quiet ${r.totalCold} · unmapped ${r.unmapped} · undated ${r.undated}`,
    );

    for (const s of r.stages) {
      console.log(
        `      ${s.label.padEnd(20)} bar=${s.thresholdDays.toFixed(1)}d ` +
          `(${s.measured ? `measured from ${s.movers}` : "default"}) ` +
          `gone-quiet=${s.hopelessDays === null ? "n/a" : s.hopelessDays.toFixed(0) + "d"}  ` +
          `sitting=${s.sitting} overdue=${s.aging} cold=${s.cold} ` +
          `exit=${s.exitRate === null ? "n/a" : (s.exitRate * 100).toFixed(0) + "%"}` +
          (s.stalled ? "  ← STALLED, nothing leaves this stage" : ""),
      );
    }

    if (r.leads.length) {
      console.log(`\n    top of the call list (${r.leads.length} shown, ${r.notListed} more):`);
      for (const l of r.leads.slice(0, 8)) {
        console.log(
          `      ${(l.name ?? "unnamed").slice(0, 24).padEnd(26)} ${l.stageLabel.padEnd(20)} ` +
            `${l.daysInStage.toFixed(0).padStart(4)}d (+${(l.daysInStage - l.thresholdDays).toFixed(0)} over)` +
            (l.everCalled === false ? "  NEVER CALLED" : l.everCalled === null ? "  (call unknown)" : ""),
        );
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
