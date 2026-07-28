import { Pool } from "@neondatabase/serverless";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(
    `SELECT to_char(at, 'HH24:MI:SS') AS t, action, ip, target_type, target_id, metadata
     FROM audit_log ORDER BY at DESC LIMIT 12`,
  );
  console.log(`audit_log rows: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `  ${r.t}  ${String(r.action).padEnd(22)} ip=${r.ip ?? "-"}  ${r.target_type ?? ""}${
        r.metadata ? " " + JSON.stringify(r.metadata) : ""
      }`,
    );
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
