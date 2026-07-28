import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { clients } from "../src/db/schema";
import { loadDashboard } from "../src/lib/metrics/dashboard";
import { formatCurrency } from "../src/lib/metrics/compute";

async function main() {
  const [client] = await db.select().from(clients).where(eq(clients.slug, "gg-ads"));
  if (!client) throw new Error("gg-ads not found");

  // Wide window so all imported FB leads fall inside it.
  const data = await loadDashboard(client, {
    startKey: "2025-01-01",
    endKey: "2026-07-25",
  });

  console.log(`Range: ${data.range.label}`);
  console.log(`\n--- HEADLINE (selected range) ---`);
  console.log(`Spend:        ${formatCurrency(data.current.ads.spend, "USD")}`);
  console.log(`Leads:        ${data.current.funnel.new_lead}`);
  console.log(`CP-Lead:      ${formatCurrency(data.current.derived.cpLead, "USD")}`);
  console.log(`Appointments: ${data.current.funnel.appointment_booked}`);
  console.log(`No-show:      ${data.current.funnel.no_show}`);
  console.log(`Closed/won:   ${data.current.funnel.closed_won}`);
  console.log(`Lost:         ${data.current.funnel.lost}`);

  console.log(`\n--- LEAD FILTER (paid attribution) ---`);
  console.log(JSON.stringify(data.leadFilter));

  console.log(`\n--- PIPELINE DISTRIBUTION (current, exact) ---  total=${data.pipelineDistribution.total}`);
  for (const s of data.pipelineDistribution.stages) {
    console.log(
      `  ${String(s.count).padStart(4)}  ${s.ghlStageName ?? "(unmapped)"}  [${s.canonicalStage ?? "-"}]`,
    );
  }

  console.log(`\n--- CAMPAIGN BREAKDOWN ---`);
  for (const c of data.campaigns) {
    console.log(
      `  ${c.campaignName}\n     spend=${formatCurrency(c.spend, "USD")} leads=${c.leads} cpLead=${formatCurrency(c.cpLead, "USD")}`,
    );
  }
  console.log(`\nattributionGap=${data.attributionGap}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
