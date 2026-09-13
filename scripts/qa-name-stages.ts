/** Ask GHL what our unmapped stage ids actually are. */
import { neon } from "@neondatabase/serverless";
import { decrypt } from "../src/lib/crypto";

const sql = neon(process.env.DATABASE_URL!);
const q = async (t: string, p: unknown[] = []) => {
  for (let i = 0; i < 6; i++) {
    try { return (await sql.query(t, p as any[])) as any[]; }
    catch { await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw new Error("db unavailable");
};

async function main() {
  const [c] = await q(`SELECT id, ghl_location_id, ghl_token_encrypted FROM clients WHERE slug='gg-ads'`);
  const token = decrypt(c.ghl_token_encrypted);
  const res = await fetch(
    `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${c.ghl_location_id}`,
    { headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" } },
  );
  const body: any = await res.json();
  if (!res.ok) throw new Error(`GHL ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);

  const byStage = new Map<string, { pipeline: string; stage: string }>();
  for (const p of body.pipelines ?? []) {
    for (const s of p.stages ?? []) byStage.set(s.id, { pipeline: p.name, stage: s.name });
  }
  console.log(`GHL returned ${(body.pipelines ?? []).length} pipelines, ${byStage.size} stages\n`);

  const unmapped = await q(`
    SELECT ps.ghl_stage_id, ps.ghl_pipeline_id,
           (SELECT COUNT(*)::int FROM stage_transitions st WHERE st.to_stage_id=ps.id) n
      FROM pipeline_stages ps
     WHERE ps.client_id=$1 AND ps.canonical_stage IS NULL
     ORDER BY n DESC`, [c.id]);

  console.log("UNMAPPED STAGES — what GHL calls them:");
  console.log("transitions  pipeline                        stage");
  for (const r of unmapped) {
    const hit = byStage.get(r.ghl_stage_id);
    console.log(
      `${String(r.n).padStart(10)}   ${(hit?.pipeline ?? "— not in GHL any more —").padEnd(32)}${hit?.stage ?? r.ghl_stage_id}`,
    );
  }
}
main();
