/**
 * Run the creative-fatigue engine against LIVE data and print what it would say.
 *
 * Read-only. Same purpose as `check-anomalies.ts`: unit tests prove the
 * arithmetic, but only a real account shows whether the panel is quiet enough
 * to be worth reading. A fatigue detector that flags half the library every
 * week is noise with statistics on it.
 *
 *   npx tsx --env-file=.env.local scripts/check-fatigue.ts [days]
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { getCreativeFatigueInput } from "@/lib/metrics/queries";
import { assessFatigue, humanChange, FATIGUE_DAYS } from "@/lib/metrics/fatigue";
import { windowFromKeys, shiftDateKey, todayKey } from "@/lib/dates";

async function main() {
  const days = Number(process.argv[2] ?? FATIGUE_DAYS);
  const all = await db.select().from(clients);

  for (const c of all) {
    const today = todayKey(c.timezone);
    const window = windowFromKeys(shiftDateKey(today, -(days - 1)), today, c.timezone);

    console.log(`\n=== ${c.name} (${c.slug}) — ${window.startKey}…${window.endKey} ===`);

    let input;
    try {
      input = await getCreativeFatigueInput(c.id, window);
    } catch (err) {
      // Expected until migrations 0009–0017 are pushed: no `creative_key` column.
      console.log(`  cannot read ad-level data: ${(err as Error).message.slice(0, 120)}`);
      continue;
    }

    console.log(`  ${input.length} asset(s) with ad-level rows`);
    for (const a of input) {
      const delivered = a.days.filter((d) => d.impressions > 0).length;
      const spend = a.days.reduce((s, d) => s + d.spend, 0);
      console.log(
        `    ${a.creativeKey.slice(0, 18).padEnd(18)} ${a.type.padEnd(8)} ` +
          `${delivered} delivery days  $${spend.toFixed(0)}  ` +
          `${a.active ? "active" : "paused"}${a.learning ? " learning" : ""}  ${a.name.slice(0, 40)}`,
      );
    }

    const report = assessFatigue(input);
    console.log(
      `  judged=${report.judged} findings=${report.findings.length} hidden=${report.hidden} ` +
        `costOnly=${report.costOnly} skipped=${JSON.stringify(report.skipped)}`,
    );
    for (const f of report.findings) {
      console.log(`\n  [${f.severity}] ${f.name}  $${f.recentSpend.toFixed(0)} recent`);
      for (const s of f.signals) {
        console.log(
          `      ${s.label.padEnd(20)} ${s.baseline.toFixed(4)} → ${s.recent.toFixed(4)}  ` +
            `${(humanChange(s) * 100).toFixed(0)}%  conf=${(s.confidence * 100).toFixed(0)}%  ` +
            `disp=${s.dispersion.toFixed(1)}  mkt=${s.market === null ? "n/a" : (s.market * 100).toFixed(0) + "%"}`,
        );
      }
      console.log(`      ${f.reason}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
