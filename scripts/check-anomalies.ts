/**
 * Run the anomaly detector against LIVE data and print what it would say.
 *
 * Read-only. The point is not that the arithmetic works — unit tests cover that
 * against fixtures — but whether it is quiet enough on a real account. A
 * detector that fires on a third of the days in the window is noise dressed as
 * signal, and the only way to find that out is to point it at real numbers.
 *
 *   npx tsx --env-file=.env.local scripts/check-anomalies.ts [days]
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { getDailySeries, getAdDataDays } from "@/lib/metrics/queries";
import { detectAnomalies, BASELINE_DAYS } from "@/lib/metrics/anomaly";
import { eachDateKey, windowFromKeys, shiftDateKey, todayKey } from "@/lib/dates";

async function main() {
  const days = Number(process.argv[2] ?? 90);
  const all = await db.select().from(clients);

  for (const c of all) {
    const tz = c.timezone;
    const today = todayKey(tz);
    const start = shiftDateKey(today, -(days - 1));

    for (const platform of ["meta", "google"] as const) {
      const range = windowFromKeys(start, today, tz);
      const extended = windowFromKeys(
        shiftDateKey(start, -BASELINE_DAYS),
        today,
        tz,
      );

      const [series, adDataDays] = await Promise.all([
        getDailySeries(
          c.id,
          extended,
          tz,
          eachDateKey(extended, tz),
          undefined,
          { mode: c.paidLeadFilter, tag: c.paidLeadTag },
          platform,
        ),
        getAdDataDays(c.id, extended, platform),
      ]);

      if (adDataDays.size === 0) continue; // platform not in use for this client

      const r = detectAnomalies({
        series,
        testFrom: range.startKey,
        testTo: range.endKey,
        todayKey: today,
        adDataDays,
        currency: c.metaCurrency ?? "USD",
      });

      const rate = r.judgedDays ? ((r.findings.length / r.judgedDays) * 100).toFixed(1) : "–";
      console.log(
        `\n=== ${c.name} · ${platform} · last ${days}d ` +
          `(${r.judgedDays}/${r.testedDays} days judgeable, ${adDataDays.size} with ad rows) ` +
          `→ ${r.findings.length} findings, ${rate}% of judged days`,
      );
      for (const a of r.findings) {
        console.log(
          `  [${a.kind}] ${a.tone.padEnd(7)} σ=${a.score === Number.MAX_SAFE_INTEGER ? "gap" : a.score.toFixed(1).padStart(5)}  ${a.text}`,
        );
      }
      if (r.findings.length === 0) console.log("  (nothing)");
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
