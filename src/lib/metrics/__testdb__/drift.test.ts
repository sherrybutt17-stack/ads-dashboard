import { describe, it, expect } from "vitest";
import { sql, getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { createTestDb } from "./harness";

/**
 * Every table the harness declares must carry every column `schema.ts` does.
 *
 * ── Why this is a test and not a comment ──────────────────────────────
 *
 * The harness header has always PROMISED that drift from `schema.ts` "shows up
 * as a failing test". It did not. A column added to production and missed here
 * surfaced as `column "alerted_at" does not exist` thrown from whichever
 * unrelated test happened to run a `SELECT *` through Drizzle — a failure that
 * names a column nobody was working on, in a file that has nothing to do with
 * the change. And a column missed on a table that nothing SELECTs *-wise did
 * not surface at all: the query simply never ran here, which is precisely the
 * class of never-executed code this project has already shipped twice.
 *
 * So the promise is now enforced, once, in the one place that can see the whole
 * picture — and it fails by NAMING the missing columns rather than by throwing
 * somewhere downstream.
 *
 * ── What it deliberately does not require ─────────────────────────────
 *
 * Not every table: the harness declares only what the tests touch, and adding
 * `agencies`, `users` or `sessions` to satisfy a completeness rule would be
 * DDL nobody reads maintained for its own sake. The rule is one-directional —
 * a table the harness claims to model, it must model fully. Types, defaults and
 * nullability are out of scope too; those the queries themselves exercise.
 */

describe("the test harness matches the real schema", () => {
  it("🔴 declares every column of every table it models", async () => {
    const h = await createTestDb();
    try {
      const found = (await h.db.execute(
        sql.raw(
          `SELECT table_name, column_name FROM information_schema.columns
             WHERE table_schema = 'public'`,
        ),
      )) as unknown as { rows: { table_name: string; column_name: string }[] };

      const harnessTables = new Map<string, Set<string>>();
      for (const r of found.rows) {
        if (!harnessTables.has(r.table_name)) harnessTables.set(r.table_name, new Set());
        harnessTables.get(r.table_name)!.add(r.column_name);
      }

      const drift: string[] = [];
      let modelled = 0;

      for (const value of Object.values(schema)) {
        let table: string;
        try {
          table = getTableName(value as never);
        } catch {
          continue; // enums, relations, types — not tables
        }
        const have = harnessTables.get(table);
        if (!have) continue; // not modelled here, by choice
        modelled++;

        const missing = Object.values(getTableColumns(value as never))
          .map((c) => (c as unknown as { name: string }).name)
          .filter((c) => !have.has(c));
        if (missing.length) drift.push(`${table}: ${missing.join(", ")}`);
      }

      expect(drift).toEqual([]);
      // Guards against the whole check passing because nothing matched — a
      // renamed export or a changed Drizzle internal would otherwise make this
      // test green by measuring nothing.
      expect(modelled).toBeGreaterThan(10);
    } finally {
      await h.close();
    }
  });

  /**
   * 🔴 Unique constraints, without which no upsert in the codebase can run.
   *
   * `onConflictDoUpdate` names a target column list, and Postgres rejects a
   * target with no matching unique constraint — the WHOLE statement, at parse
   * time, whether or not a conflict would have occurred. So a table modelled
   * here without its unique index does not merely test less: any test touching
   * an upsert on it fails with "no unique or exclusion constraint matching the
   * ON CONFLICT specification", which reads as a bug in the code under test.
   *
   * Found the hard way four times — `meta_ad_accounts`, `google_ad_accounts`,
   * `fb_daily_metrics`, then `google_daily_metrics` and `tiktok_daily_metrics`
   * together — each discovered only when someone happened to write a test that
   * needed it. This turns that into an automatic answer.
   *
   * Matched by COLUMN SET rather than by index name, because that is what
   * Postgres actually matches an ON CONFLICT target against; the harness is
   * free to name its constraint whatever it likes.
   */
  it("🔴 declares every unique constraint of every table it models", async () => {
    const h = await createTestDb();
    try {
      const found = (await h.db.execute(
        sql.raw(
          `SELECT t.relname AS table_name, i.relname AS index_name, a.attname AS column_name,
                  (x.indpred IS NOT NULL) AS partial
             FROM pg_index x
             JOIN pg_class i ON i.oid = x.indexrelid
             JOIN pg_class t ON t.oid = x.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(x.indkey)
            WHERE n.nspname = 'public' AND x.indisunique`,
        ),
      )) as unknown as {
        rows: {
          table_name: string;
          index_name: string;
          column_name: string;
          partial: boolean;
        }[];
      };

      // table -> "col,col,col" (sorted) -> whether that index carries a predicate
      const harnessUniques = new Map<string, Map<string, boolean>>();
      const byIndex = new Map<string, { table: string; cols: string[]; partial: boolean }>();
      for (const r of found.rows) {
        const entry =
          byIndex.get(r.index_name) ??
          { table: r.table_name, cols: [], partial: r.partial };
        entry.cols.push(r.column_name);
        byIndex.set(r.index_name, entry);
      }
      for (const { table, cols, partial } of byIndex.values()) {
        if (!harnessUniques.has(table)) harnessUniques.set(table, new Map());
        harnessUniques.get(table)!.set([...cols].sort().join(","), partial);
      }

      const drift: string[] = [];
      let modelled = 0;

      for (const value of Object.values(schema)) {
        let cfg;
        try {
          cfg = getTableConfig(value as never);
        } catch {
          continue;
        }
        if (!harnessUniques.has(cfg.name)) continue; // not modelled here, by choice
        modelled++;

        for (const idx of cfg.indexes ?? []) {
          const c = (idx as unknown as {
            config: {
              unique: boolean;
              name: string;
              columns: { name?: string }[];
              where?: unknown;
            };
          }).config;
          if (!c.unique) continue;
          const cols = c.columns.map((x) => x?.name).filter(Boolean) as string[];
          if (cols.length === 0) continue;
          const key = [...cols].sort().join(",");
          const harnessPartial = harnessUniques.get(cfg.name)!.get(key);
          if (harnessPartial === undefined) {
            drift.push(`${cfg.name}: ${c.name} (${cols.join(", ")})`);
            continue;
          }
          /*
           * 🔴 A partial index modelled as a plain one passes a column-set
           * check and behaves the OPPOSITE way.
           *
           * `report_sends_period_key` is `WHERE status <> 'failed'`, and that
           * predicate is the entire retry story: a claim blocks a duplicate
           * send, but a FAILED row stops blocking so the next run can try the
           * period again. Drop the predicate in the harness and a test would
           * "prove" that one provider blip loses that period forever.
           */
          const schemaPartial =
            (idx as unknown as { config: { where?: unknown } }).config.where !== undefined;
          if (schemaPartial && !harnessPartial) {
            drift.push(
              `${cfg.name}: ${c.name} is PARTIAL in schema.ts but not in the harness`,
            );
          }
        }
      }

      expect(drift).toEqual([]);
      expect(modelled).toBeGreaterThan(5);
    } finally {
      await h.close();
    }
  });

  /**
   * 🔴 The other half of the same promise, which the column check does not cover.
   *
   * The harness spells its enums out as literal DDL, so a value added to a
   * `pgEnum` in `schema.ts` does not reach it. Nothing fails at that moment —
   * it fails later, as `invalid input value for enum <name>: "<value>"` thrown
   * from whichever test first tries to insert the new value, naming an enum
   * nobody was working on.
   *
   * That is not hypothetical. Adding `disqualified` to `canonical_stage`
   * produced exactly that error against a database that had not been updated,
   * and the workaround (casting the column to text at one call site) is still
   * in the query layer.
   *
   * One-directional, like the column rule: an enum the harness declares, it
   * must declare fully. Enums it does not model at all are not its business —
   * `agency_status`, `user_role` and the rest belong to tables the harness has
   * no reason to carry.
   */
  it("🔴 declares every VALUE of every enum it models", async () => {
    const h = await createTestDb();
    try {
      const found = (await h.db.execute(
        sql.raw(
          `SELECT t.typname AS enum_name, e.enumlabel AS value
             FROM pg_type t
             JOIN pg_enum e ON e.enumtypid = t.oid
             JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public'`,
        ),
      )) as unknown as { rows: { enum_name: string; value: string }[] };

      const harnessEnums = new Map<string, Set<string>>();
      for (const r of found.rows) {
        if (!harnessEnums.has(r.enum_name)) harnessEnums.set(r.enum_name, new Set());
        harnessEnums.get(r.enum_name)!.add(r.value);
      }

      const drift: string[] = [];
      let modelled = 0;

      for (const value of Object.values(schema)) {
        const e = value as { enumName?: unknown; enumValues?: unknown };
        if (typeof e?.enumName !== "string" || !Array.isArray(e.enumValues)) continue;
        const have = harnessEnums.get(e.enumName);
        if (!have) continue; // not modelled here, by choice
        modelled++;

        const missing = (e.enumValues as string[]).filter((v) => !have.has(v));
        if (missing.length) drift.push(`${e.enumName}: ${missing.join(", ")}`);
      }

      expect(drift).toEqual([]);
      expect(modelled).toBeGreaterThan(3);
    } finally {
      await h.close();
    }
  });
});
