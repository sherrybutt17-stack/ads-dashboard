import * as fs from "node:fs";
// Load .env.local (shell can't source it — DATABASE_URL contains &).
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

import { db } from "../src/db";
import { clients, pipelineStages, contacts, opportunities, stageTransitions } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";

async function main() {
  const cs = await db.select().from(clients);
  console.log("CLIENTS:");
  for (const c of cs) {
    console.log(`  ${c.slug} (${c.id})`);
    console.log(`     status=${c.status} tz=${c.timezone}`);
    console.log(`     ghlLocationId=${c.ghlLocationId ?? "(none)"}`);
    console.log(`     metaAdAccountId=${c.metaAdAccountId ?? "(none)"}`);
    console.log(`     paidLeadFilter=${c.paidLeadFilter} tag=${(c as Record<string, unknown>).paidLeadTag ?? "?"}`);
    const ps = await db.select().from(pipelineStages).where(eq(pipelineStages.clientId, c.id));
    console.log(`     pipeline_stages: ${ps.length}`);
    for (const s of ps) console.log(`        ${s.ghlStageName} -> ${s.canonicalStage} (${s.ghlStageId})`);
    const [cc] = await db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(eq(contacts.clientId, c.id));
    const [oc] = await db.select({ n: sql<number>`count(*)::int` }).from(opportunities).where(eq(opportunities.clientId, c.id));
    const [tc] = await db.select({ n: sql<number>`count(*)::int` }).from(stageTransitions).where(eq(stageTransitions.clientId, c.id));
    console.log(`     contacts=${cc.n} opportunities=${oc.n} stage_transitions=${tc.n}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
