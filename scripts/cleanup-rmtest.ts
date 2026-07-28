import { Pool } from "@neondatabase/serverless";

async function main() {
  const [rcid, userid] = process.argv.slice(2);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  if (userid) await pool.query("DELETE FROM users WHERE id = $1", [userid]);
  if (rcid) await pool.query("DELETE FROM clients WHERE id = $1", [rcid]);
  console.log(`cleaned up test client=${rcid} user=${userid}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
