/**
 * Paid against the rest of the pipeline, on live data. Read-only.
 *
 * The number to watch is the trust level. If the platform reports leads the CRM
 * cannot find, everything below it is misinformation, and the point of running
 * this is to see that before a client does.
 *
 *   npx tsx --env-file=.env.local scripts/check-channels.ts [slug]
 */
import { db } from "@/db";
import { clients } from "@/db/schema";
import { getChannelMix } from "@/lib/metrics/queries";
import { buildChannelMix } from "@/lib/metrics/channels";
import { trailingMonths } from "@/lib/dates";

const pct = (v: number | null) => (v === null ? "  -  " : `${(v * 100).toFixed(0).padStart(3)}%`);

async function main() {
  const slug = process.argv[2];
  const all = (await db.select().from(clients)).filter(
    (c) => c.status !== "archived" && (!slug || c.slug === slug),
  );

  for (const c of all) {
    const months = trailingMonths(12, c.timezone);
    const input = await getChannelMix(
      c.id,
      months,
      c.timezone,
      { mode: c.paidLeadFilter, tag: c.paidLeadTag },
      "meta",
    );

    console.log(`\n=== ${c.name} (${c.slug}) — lead filter: ${c.paidLeadFilter}`);
    if (!input.splitDefinable) {
      console.log("    no split possible: every lead counts as paid");
      continue;
    }

    const label = new Map(months.map((m) => [m.monthKey, m.label]));
    const r = buildChannelMix(
      input.rows.map((x) => ({ ...x, label: label.get(x.month) ?? x.month })),
    );

    console.log(
      `    TRUST: ${r.trust.level.toUpperCase()} — platform reported ${r.trust.platformLeads}, ` +
        `CRM matched ${r.trust.matchedLeads}` +
        (r.trust.gapMonths.length ? `  (gaps: ${r.trust.gapMonths.join(", ")})` : ""),
    );
    console.log(
      `    paid  ${String(r.paid.leads).padStart(4)} leads  ${String(r.paid.appointments).padStart(3)} appts ${pct(r.paid.bookRate)}  ${String(r.paid.won).padStart(3)} won`,
    );
    console.log(
      `    other ${String(r.other.leads).padStart(4)} leads  ${String(r.other.appointments).padStart(3)} appts ${pct(r.other.bookRate)}  ${String(r.other.won).padStart(3)} won`,
    );
    console.log(
      `    spend ${r.spend.toFixed(0)}  cost per paid lead ${r.costPerPaidLead === null ? "-" : r.costPerPaidLead.toFixed(2)}`,
    );
    console.log(
      `    cannibalisation: ${r.cannibalisation.verdict}` +
        (r.cannibalisation.rho !== null
          ? ` (rho=${r.cannibalisation.rho.toFixed(2)}, p=${r.cannibalisation.p?.toFixed(3)}, ${r.cannibalisation.months} months)`
          : ` (${r.cannibalisation.months} months with ad data)`),
    );
    console.log(
      `    baseline: ${
        r.baseline
          ? `${r.baseline.months} months before ad data, median ${r.baseline.medianLeads} leads/mo → ${r.baseline.medianSince} since`
          : "not available"
      }`,
    );

    console.log("\n    month      spend  platform  paid  other");
    for (const row of [...r.rows].reverse()) {
      console.log(
        `      ${row.label.padEnd(9)} ${(row.spend === null ? "   n/a" : row.spend.toFixed(0)).padStart(6)} ` +
          `${String(row.platformLeads ?? "n/a").padStart(9)} ${String(row.paidLeads).padStart(5)} ${String(row.otherLeads).padStart(6)}`,
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
