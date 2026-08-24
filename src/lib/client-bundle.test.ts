import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * 🔴 The database schema must never reach the browser.
 *
 * `db/schema.ts` names every table and column, including `ghl_token_encrypted`,
 * `password_hash`, `token_hash` and `webhook_token`. Importing it from a
 * `"use client"` component bundles all of that — plus ~80K of
 * `drizzle-orm/pg-core` metadata — into a chunk any visitor can read. No values
 * leak, only structure; but this application has client-role logins, so the
 * people reading it include the agency's own clients, and a map of where the
 * credentials live is a needless gift.
 *
 * It shipped that way once. `STAGE_LABELS` and `CANONICAL_STAGES` were declared
 * in `db/schema.ts`, and the funnel and the setup wizard imported them for their
 * display labels. The fix was `@/lib/stages` — the same constants in a module
 * with no dependencies, which `db/schema.ts` now builds its pgEnum from.
 *
 * ── Why a graph walk and not a grep ───────────────────────────────────
 *
 * Repointing the three obvious components did NOT fix it. The leak survived
 * through `@/lib/metrics/compute`, which six client components import for
 * `formatCurrency`, and which imported a type from `@/db/schema`. A one-level
 * check would have passed while the bundle still carried the schema. So this
 * walks the transitive VALUE-import graph from every client entry point, and
 * reports the chain it found rather than just the fact of a failure.
 *
 * Type-only imports are followed by neither TypeScript nor the bundler — they
 * are erased before a module ever reaches the graph — so they are skipped here
 * too. That distinction is the whole reason `import type { CanonicalStage }`
 * remains legal from a client component.
 */

const SRC = resolve(__dirname, "..");

/** Modules that must never be reachable by value from the browser. */
const FORBIDDEN = ["@/db/schema", "@/db"];

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__testdb__") continue;
      walkFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so a `"use client"` mentioned in prose is not read as one. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * A real `"use client"` directive: the first statement in the file.
 *
 * `ExportMenu.tsx` documents at length why it is deliberately NOT a client
 * component, quoting the directive to do so. Matching the raw text would file it
 * as a client entry point and chase imports that never reach a browser.
 */
function isClientEntry(src: string): boolean {
  const first = stripComments(src)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first === '"use client";' || first === "'use client';";
}

interface Import {
  spec: string;
  typeOnly: boolean;
}

function parseImports(src: string): Import[] {
  const out: Import[] = [];
  const re = /import\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const clause = m[1].trim();
    const spec = m[2];

    // `import type { X } from` — erased wholesale.
    if (/^type\b/.test(clause)) {
      out.push({ spec, typeOnly: true });
      continue;
    }

    /*
     * `import { type A, type B }` is also fully erased, while
     * `import { type A, b }` is not. Only a brace clause whose every binding
     * carries the `type` modifier counts as erased; a default or namespace
     * binding alongside it makes the import real.
     */
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (braces) {
      const bindings = braces[1]
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean);
      const allType = bindings.length > 0 && bindings.every((b) => /^type\s/.test(b));
      out.push({ spec, typeOnly: allType });
      continue;
    }

    out.push({ spec, typeOnly: false });
  }
  return out;
}

/** `@/lib/x` → absolute path, trying the extensions Next resolves. */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // bare package — not ours to police

  for (const cand of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Depth-first search for a forbidden module, returning the chain that reached it. */
function findForbidden(entry: string): string[] | null {
  const seen = new Set<string>();

  function visit(file: string, chain: string[]): string[] | null {
    if (seen.has(file)) return null;
    seen.add(file);

    const src = readFileSync(file, "utf8");
    for (const imp of parseImports(src)) {
      if (imp.typeOnly) continue;
      if (FORBIDDEN.includes(imp.spec)) return [...chain, imp.spec];

      const next = resolveSpec(imp.spec, file);
      if (!next) continue;
      const found = visit(next, [...chain, next.replace(`${SRC}/`, "")]);
      if (found) return found;
    }
    return null;
  }

  return visit(entry, [entry.replace(`${SRC}/`, "")]);
}

describe("🔴 the database schema must not reach the browser", () => {
  const clientEntries = walkFiles(SRC).filter((f) =>
    isClientEntry(readFileSync(f, "utf8")),
  );

  it("finds the client components to check", () => {
    // Guards the guard: a broken directive check would vacuously pass everything.
    expect(clientEntries.length).toBeGreaterThan(20);
  });

  it("no client component reaches @/db/schema through value imports", () => {
    const leaks: string[] = [];
    for (const entry of clientEntries) {
      const chain = findForbidden(entry);
      if (chain) leaks.push(chain.join("\n    → "));
    }

    expect(
      leaks,
      leaks.length
        ? `The database schema is reachable from the browser:\n\n  ${leaks.join(
            "\n\n  ",
          )}\n\nImport display constants from "@/lib/stages" instead, or make the ` +
            `import type-only if only a type is needed.`
        : "",
    ).toEqual([]);
  });
});
