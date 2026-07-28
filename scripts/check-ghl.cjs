const { Pool } = require("@neondatabase/serverless");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const show = (label, rows) => {
    console.log(`\n=== ${label} ===`);
    if (!rows.length) return console.log("(none)");
    console.table(rows);
  };

  show(
    "GHL installations",
    await q(
      "select location_id, location_name, (client_id is not null) as bound, installed_at, uninstalled_at from ghl_installations order by installed_at desc nulls last limit 5",
    ),
  );
  show(
    "GG ads client",
    await q(
      "select slug, ghl_location_id, ghl_location_name, first_webhook_at from clients where slug='gg-ads'",
    ),
  );
  show(
    "Pipeline stages (gg-ads)",
    await q(
      "select ps.ghl_stage_name, ps.canonical_stage, ps.discovered_from_webhook from pipeline_stages ps join clients c on c.id=ps.client_id where c.slug='gg-ads' order by ps.display_order",
    ),
  );
  show(
    "Webhook events by status",
    await q(
      "select status, count(*)::int as count from webhook_events group by status order by count desc",
    ),
  );
  show(
    "Recent webhook events",
    await q(
      "select left(coalesce(client_id::text,'—'),8) as client, status, received_at from webhook_events order by received_at desc limit 5",
    ),
  );
  show(
    "Stage transitions by source",
    await q("select source, count(*)::int as count from stage_transitions group by source"),
  );

  await pool.end();
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
