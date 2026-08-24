/**
 * Reconcile the book against each client's OWN dashboard, against live data.
 *
 * The roll-up folds three queries per client into three queries total. That is
 * only worth doing if it produces the same numbers the per-client path does —
 * two screens disagreeing about one month is worse than either being wrong,
 * because both look authoritative and nobody can tell which to believe.
 *
 * Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/check-rollup.ts [days]
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { loadBook } from "@/lib/metrics/book";
import { loadDashboard } from "@/lib/metrics/dashboard";
import { trailingWindowInclusive } from "@/lib/dates";

async function main() {
  const days = Number(process.argv[2] ?? 30);
  const all = (await db.select().from(clients)).filter((c) => c.status !== "archived");

  const opts = (() => {
    if (days === 30) return {};
    return undefined;
  })();

  const book = await loadBook(all, opts ?? {});
  console.log(`book: ${book.rollup.rows.length} clients, ${book.days} days`);
  if (book.error) console.log(`  ERROR: ${book.error}`);

  for (const t of book.rollup.byCurrency) {
    console.log(
      `  TOTAL ${t.currency}: spend=${t.spend.toFixed(2)} leads=${t.leads} ` +
        `cpLead=${t.cpLead === null ? "-" : t.cpLead.toFixed(2)} appts=${t.appointments} ` +
        `won=${t.closedWon} roas=${t.roas === null ? "-" : t.roas.toFixed(2)}` +
        (t.excluded.length
          ? `  (excluded from ratios: ${t.excluded.map((e) => e.name).join(", ")})`
          : ""),
    );
  }
  console.log(`  lead bases: ${JSON.stringify(book.rollup.leadBases)}`);

  console.log("\nreconciling each client against its own dashboard (Meta view):");
  for (const c of all) {
    const row = book.rollup.rows.find((r) => r.clientId === c.id);
    if (!row) continue;
    const w = trailingWindowInclusive(30, c.timezone);
    const d = await loadDashboard(c, { startKey: w.startKey, endKey: w.endKey }, "meta");

    const spendDelta = row.spend - d.current.ads.spend;
    const leadDelta = row.leads - d.current.funnel.new_lead;
    const apptDelta = row.appointments - d.current.funnel.appointment_booked;
    const ok = Math.abs(spendDelta) < 0.005 && leadDelta === 0 && apptDelta === 0;

    console.log(
      `  ${ok ? "OK  " : "DIFF"} ${c.name.padEnd(22)} ` +
        `book spend=${row.spend.toFixed(2)} dash=${d.current.ads.spend.toFixed(2)} | ` +
        `book leads=${row.leads} dash=${d.current.funnel.new_lead} | ` +
        `book appts=${row.appointments} dash=${d.current.funnel.appointment_booked}`,
    );
    if (!ok) {
      console.log(
        `        deltas: spend=${spendDelta.toFixed(4)} leads=${leadDelta} appts=${apptDelta}` +
          `  (the book blends Google in; the dashboard's Meta view does not)`,
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
