/**
 * What the live database is missing, compared to `src/db/schema.ts`.
 *
 * READ ONLY. Touches nothing but `information_schema` and `pg_enum`, creates no
 * temp tables (they leak across reused sessions on the Neon pooler), and writes
 * nothing at all. Safe to run against production.
 *
 *   npx tsx --env-file=.env.local scripts/schema-gap.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import * as schema from "../src/db/schema";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

async function main() {
  const live = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);
  const rows = (Array.isArray(live) ? live : (live as { rows?: unknown[] }).rows ?? []) as Array<{
    table_name: string;
    column_name: string;
  }>;

  const liveTables = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = liveTables.get(r.table_name) ?? new Set<string>();
    set.add(r.column_name);
    liveTables.set(r.table_name, set);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];

  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const cfg = getTableConfig(value);
    const liveCols = liveTables.get(cfg.name);
    if (!liveCols) {
      missingTables.push(cfg.name);
      continue;
    }
    for (const col of cfg.columns) {
      if (!liveCols.has(col.name)) missingColumns.push(`${cfg.name}.${col.name}`);
    }
  }

  /*
   * The dangerous direction: anything live that the code no longer declares.
   * `db:push` reconciles both ways, so this is what decides whether a push is
   * purely additive or destructive. Computed from the SAME map as above rather
   * than a second pass, because a separate scan that silently built an empty
   * map would report "nothing at risk" for the worst possible reason.
   */
  const codeTables = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const cfg = getTableConfig(value);
    codeTables.set(cfg.name, new Set(cfg.columns.map((c) => c.name)));
  }
  if (codeTables.size === 0) {
    throw new Error(
      "Read zero tables out of the schema module — the check below would report a false all-clear.",
    );
  }

  const droppableTables: string[] = [];
  const droppableColumns: string[] = [];
  for (const [table, cols] of liveTables) {
    const codeCols = codeTables.get(table);
    if (!codeCols) {
      // Drizzle's own bookkeeping table is not ours and is never dropped.
      if (table !== "__drizzle_migrations") droppableTables.push(table);
      continue;
    }
    for (const c of cols) {
      if (!codeCols.has(c)) droppableColumns.push(`${table}.${c}`);
    }
  }

  const enums = await db.execute<{ enum_name: string; value: string }>(sql`
    SELECT t.typname AS enum_name, e.enumlabel AS value
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    ORDER BY t.typname, e.enumsortorder
  `);
  const enumRows = (Array.isArray(enums) ? enums : (enums as { rows?: unknown[] }).rows ?? []) as Array<{
    enum_name: string;
    value: string;
  }>;
  const liveEnums = new Map<string, Set<string>>();
  for (const r of enumRows) {
    const set = liveEnums.get(r.enum_name) ?? new Set<string>();
    set.add(r.value);
    liveEnums.set(r.enum_name, set);
  }

  console.log(`\nLive tables: ${liveTables.size}`);

  console.log(`\n── Missing TABLES (${missingTables.length}) ──`);
  for (const t of missingTables.sort()) console.log(`  ${t}`);

  console.log(`\n── Missing COLUMNS (${missingColumns.length}) ──`);
  for (const c of missingColumns.sort()) console.log(`  ${c}`);

  console.log(
    `\n── 🔴 Live but NOT in the code — a push would DROP these (${droppableTables.length} tables, ${droppableColumns.length} columns) ──`,
  );
  for (const t of droppableTables.sort()) console.log(`  TABLE ${t}`);
  for (const c of droppableColumns.sort()) console.log(`  COLUMN ${c}`);
  if (droppableTables.length + droppableColumns.length === 0) {
    console.log("  none — the push is purely additive");
  }

  console.log(`\n── Enums, live values ──`);
  for (const [name, vals] of [...liveEnums].sort()) {
    console.log(`  ${name}: ${[...vals].join(", ")}`);
  }

  console.log(
    `\n${missingTables.length + missingColumns.length === 0 ? "Schema is up to date." : "`npm run db:push` would add the above."}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
