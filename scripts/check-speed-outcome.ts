/**
 * What the speed→outcome panel actually says, against live data. Read-only.
 *
 * The point of running this rather than trusting the tests: the fixtures prove
 * the engine is right, they cannot prove the cohort is big enough for it to say
 * anything. A panel that is correct and permanently inconclusive is a panel
 * nobody should ship without knowing that first.
 *
 *   npx tsx --env-file=.env.local scripts/check-speed-outcome.ts [slug] [days]
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { getSpeedToLeadOutcomes, getMappedStages } from "@/lib/metrics/queries";
import { buildSpeedOutcome } from "@/lib/metrics/speed-outcome";
import { trailingWindowInclusive } from "@/lib/dates";

const pct = (v: number | null) => (v === null ? "  -  " : `${(v * 100).toFixed(0).padStart(3)}%`);

async function main() {
  const slug = process.argv[2];
  const days = Number(process.argv[3] ?? 90);
  const all = (await db.select().from(clients)).filter(
    (c) => c.status !== "archived" && (!slug || c.slug === slug),
  );

  for (const c of all) {
    const w = trailingWindowInclusive(days, c.timezone);
    const [cohort, mapped] = await Promise.all([
      getSpeedToLeadOutcomes(
        c.id,
        w,
        c.timezone,
        { mode: c.paidLeadFilter, tag: c.paidLeadTag },
        "meta",
      ),
      getMappedStages(c.id),
    ]);
    const r = buildSpeedOutcome(cohort.leads, {
      asOf: new Date(),
      mappedStages: mapped,
      trackingStartedAt: cohort.trackingStartedAt,
      preTracking: cohort.preTracking,
    });

    console.log(`\n=== ${c.name} (${c.slug}) — trailing ${days}d, ${c.timezone}`);
    console.log(
      `    tracking since ${r.trackingStartedAt ?? "never"} · cohort ${r.cohort} · pre-tracking ${r.preTracking}`,
    );
    console.log(
      `    calling window: ${
        r.callingWindow
          ? `days ${r.callingWindow.days.join(",")} hours ${r.callingWindow.startHour}-${r.callingWindow.endHour} (from ${r.callingWindow.calls} calls)`
          : "not measurable"
      }`,
    );
    console.log(`    opens on: ${r.defaultStage}`);

    for (const s of r.stages) {
      console.log(
        `\n    ${s.label.padEnd(8)} mapped=${s.mapped} matured=${s.matured} maturing=${s.maturing} ` +
          `converted=${s.converted} maturation=${s.maturationDays.toFixed(1)}d ` +
          `(${s.maturationMeasured ? "measured" : "default"})`,
      );
      for (const b of s.buckets) {
        console.log(
          `      ${b.label.padEnd(13)} n=${String(b.leads).padStart(3)} k=${String(b.converted).padStart(3)} ` +
            `${pct(b.rate)}  [${pct(b.lo)} … ${pct(b.hi)}]${b.inComparison ? "" : "  (not compared)"}`,
        );
      }
      if (s.verdict) {
        console.log(
          `      VERDICT ${s.verdict.strength}  fast ${pct(s.verdict.fast.rate)} (n=${s.verdict.fast.leads}) ` +
            `vs slow ${pct(s.verdict.slow.rate)} (n=${s.verdict.slow.leads})  ` +
            `P(fast better)=${(s.verdict.probFastBetter * 100).toFixed(1)}%`,
        );
      } else {
        console.log(`      VERDICT none — one arm of the contrast is empty`);
      }
      if (s.control) {
        console.log(
          `      CONTROL in-hours  fast ${pct(s.control.fast.rate)} (n=${s.control.fast.leads}) ` +
            `vs slow ${pct(s.control.slow.rate)} (n=${s.control.slow.leads})  ` +
            `P=${(s.control.probFastBetter * 100).toFixed(1)}%`,
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
