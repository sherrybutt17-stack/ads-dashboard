/**
 * Churn signals across the book, on live data. Read-only.
 *
 * The thing to watch is how much it says. A panel that flags half the book
 * every week is one nobody reads on the week it matters, so a run that reports
 * mostly "steady" is the panel working rather than the panel broken — and the
 * raw buckets are printed underneath so the two can be told apart.
 *
 *   npx tsx --env-file=.env.local scripts/check-churn.ts
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { loadChurn } from "@/lib/metrics/book";
import { WEEKS } from "@/lib/metrics/churn";
import { getChurnWeeks, type ChurnWeekWindow } from "@/lib/metrics/queries";
import { shiftDateKey, todayKey, windowFromKeys } from "@/lib/dates";

async function main() {
  const all = (await db.select().from(clients)).filter((c) => c.status !== "archived");
  const { report, error } = await loadChurn(all);

  if (error) {
    console.log("FAILED:", error);
    process.exit(1);
  }

  console.log(
    `\n${all.length} clients · ${report.flagged.length} flagged · ` +
      `${report.steady} steady · ${report.unknown} unjudgeable`,
  );
  console.log(`blocks: ${report.blockDays}d vs ${report.blockDays}d, over ${WEEKS} weeks`);

  for (const c of report.flagged) {
    console.log(`\n  ${c.level.toUpperCase()}  ${c.name}`);
    for (const s of c.signals) {
      const pct = s.change === null ? "" : `  ${(s.change * 100).toFixed(0)}%`;
      console.log(
        `      ${s.id.padEnd(16)} ${String(Math.round(s.prior)).padStart(7)} → ` +
          `${String(Math.round(s.recent)).padStart(7)}${pct}` +
          (s.p !== undefined ? `  p=${s.p.toFixed(4)}` : "") +
          (s.everyWeek ? "  (fell every week)" : "") +
          (s.days !== undefined ? `  days=${s.days}` : ""),
      );
    }
  }

  // The buckets the verdicts were drawn from, so a quiet panel can be checked
  // against the numbers rather than taken on trust.
  const windows: ChurnWeekWindow[] = [];
  for (const c of all) {
    const today = todayKey(c.timezone);
    for (let idx = 0; idx < WEEKS; idx++) {
      const end = -1 - 7 * (WEEKS - 1 - idx);
      windows.push({
        clientId: c.id,
        idx,
        window: windowFromKeys(
          shiftDateKey(today, end - 6),
          shiftDateKey(today, end),
          c.timezone,
        ),
        filter: { mode: c.paidLeadFilter, tag: c.paidLeadTag },
      });
    }
  }
  const raw = await getChurnWeeks(windows);
  const byKey = new Map(raw.rows.map((r) => [`${r.clientId}:${r.idx}`, r]));

  console.log("\n  --- weekly buckets, oldest first  (prior block | recent block)");
  for (const c of all) {
    const cells = Array.from({ length: WEEKS }, (_, i) => {
      const r = byKey.get(`${c.id}:${i}`);
      const s = Math.round(r?.spend ?? 0);
      return `${String(s).padStart(5)}/${String(r?.leads ?? 0).padStart(2)}`;
    });
    const flagged = report.flagged.find((f) => f.clientId === c.id);
    console.log(
      `  ${c.slug.padEnd(10)} ${cells.slice(0, 4).join(" ")}  |  ${cells.slice(4).join(" ")}` +
        (flagged ? `   [${flagged.level}]` : ""),
    );
    const first = raw.firstActivity.get(c.id);
    const last = raw.lastWebhook.get(c.id);
    console.log(
      `             first activity ${first?.slice(0, 10) ?? "never"}  ·  last webhook ${last?.slice(0, 10) ?? "never"}`,
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
