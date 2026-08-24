/**
 * The maturation curve and the like-for-like check, against live data.
 * Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/check-maturation.ts [slug]
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { getCohortMaturation } from "@/lib/metrics/queries";
import { buildMaturation, shareAt } from "@/lib/metrics/maturation";
import { trailingMonths } from "@/lib/dates";

async function main() {
  const slug = process.argv[2];
  const all = (await db.select().from(clients)).filter(
    (c) => c.status !== "archived" && (!slug || c.slug === slug),
  );

  for (const c of all) {
    const months = trailingMonths(12, c.timezone);
    const input = await getCohortMaturation(
      c.id,
      months,
      c.timezone,
      { mode: c.paidLeadFilter, tag: c.paidLeadTag },
      "meta",
    );
    const r = buildMaturation(
      months.map((m) => ({
        month: m.monthKey,
        label: m.label,
        leads: input.leadsByMonth.get(m.monthKey) ?? 0,
        startUtc: m.startUtc.toISOString(),
        complete: m.endUtc.getTime() <= Date.now(),
      })),
      input.conversions.map((x) => ({
        month: x.month,
        stage: x.stage as "appointment_booked" | "showed" | "closed_won",
        days: x.days,
      })),
      { asOf: new Date() },
    );

    console.log(`\n=== ${c.name} (${c.slug}) — ${input.conversions.length} conversions`);

    for (const cur of r.curves) {
      console.log(
        `    ${cur.label.padEnd(8)} curve=${cur.measured ? `measured from ${cur.basis} months` : `NOT measured (${cur.basis} qualify)`}` +
          (cur.measured
            ? `  half=${cur.halfDays?.toFixed(0)}d  90%=${cur.ninetyDays?.toFixed(0)}d` +
              `  [7d ${(shareAt(cur.curve, 7) * 100).toFixed(0)}% · 30d ${(shareAt(cur.curve, 30) * 100).toFixed(0)}%]`
            : ""),
      );
    }

    console.log("\n    like-for-like:");
    for (const ch of r.checks) {
      console.log(
        `      ${ch.stage.padEnd(20)} at ${String(ch.atDays).padStart(3)}d: ` +
          `${ch.recent.label} ${ch.recent.converted}/${ch.recent.leads} vs ` +
          `${ch.prior.label} ${ch.prior.converted}/${ch.prior.leads}  ` +
          `(raw ${ch.rawRecent} vs ${ch.rawPrior})` +
          (ch.misleading ? "   ← RAW READING IS MISLEADING" : ""),
      );
    }

    console.log("\n    cohorts (appointments):");
    for (const row of r.cohorts.slice(0, 6)) {
      const s = row.stages.appointment_booked;
      console.log(
        `      ${row.label.padEnd(9)} ${String(row.leads).padStart(4)} leads  ` +
          `${String(s.observed).padStart(3)} booked  ` +
          `${(s.maturity * 100).toFixed(0).padStart(3)}% matured  ` +
          `on track for ${s.projected === null ? "(too early)" : `≈${s.projected}`}` +
          (row.complete ? "" : "  [part month]"),
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
