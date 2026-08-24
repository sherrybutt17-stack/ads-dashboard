import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Catch server components calling plain functions out of `"use client"` modules.
 *
 * This bug class is invisible to every gate we had. It passes `tsc --noEmit`,
 * it passes `next build`, and it fails only when the page is actually rendered
 * — with "Attempted to call X() from the server but X is on the client."
 *
 * It shipped TWICE in this codebase before anything caught it, and both times
 * the damage was total rather than cosmetic:
 *
 *  - `formatMultiple`, imported from `StatTile.tsx` for the ROAS tile, threw on
 *    every render and dropped the WHOLE dashboard into its error boundary.
 *  - `changesBetween`, imported from `MetricsTable.tsx`, took out the entire
 *    report-tables Suspense boundary, so all four tables sat as a permanent
 *    skeleton and the 7-day change table never rendered a single delta.
 *
 * Both were reported as done on the strength of typecheck + build passing. The
 * rule is simple and this test enforces it: a `"use client"` module may export
 * COMPONENTS and TYPES to the server, never callable values.
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({
  path: p,
  rel: relative(process.cwd(), p),
  src: readFileSync(p, "utf8"),
}));

const isClient = (src: string) => /^\s*["']use client["']/m.test(src.slice(0, 200));

/**
 * Exported names from a client module that are NOT components.
 *
 * A component is recognised by an uppercase first letter — the same convention
 * React itself uses to decide whether JSX resolves to a host element or a
 * component, and the same one the RSC boundary relies on.
 */
function nonComponentExports(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([a-z]\w*)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s+const\s+([a-z]\w*)\s*[:=]/g)) {
    names.add(m[1]);
  }
  /*
   * Re-exports — `export { changesBetween } from "@/lib/..."`.
   *
   * A first version of this test missed these, and a re-export is arguably the
   * WORSE case: the function looks like it lives in a pure module, so nothing
   * about the call site suggests a boundary is being crossed. Excludes
   * `export type { … }`, which is erased.
   */
  for (const m of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*(from\s*["'][^"']+["'])?/g)) {
    if (m[1]) continue; // `export type { ... }`
    for (const raw of m[2].split(",")) {
      const part = raw.trim();
      if (!part || part.startsWith("type ")) continue;
      // `a as b` — the exported name is what matters.
      const name = (part.split(/\s+as\s+/)[1] ?? part).trim();
      if (/^[a-z]\w*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

describe("React server/client boundary", () => {
  const clientModules = files.filter((f) => isClient(f.src));

  it("finds the client modules to check", () => {
    // If this drops to zero the rest of the suite is vacuously green.
    expect(clientModules.length).toBeGreaterThan(5);
  });

  it("no client module exports a callable that a server module imports", () => {
    const violations: string[] = [];

    for (const client of clientModules) {
      const exported = nonComponentExports(client.src);
      if (exported.length === 0) continue;

      // The specifier a server file would import this module by.
      const modName = client.rel
        .replace(/^src\//, "@/")
        .replace(/\.tsx?$/, "")
        .replace(/\/index$/, "");

      for (const other of files) {
        if (other.path === client.path || isClient(other.src)) continue;

        // Grab the import clause for this module, if any.
        const importRe = new RegExp(
          `import\\s+\\{([^}]*)\\}\\s+from\\s+["']${modName.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          )}["']`,
          "g",
        );
        for (const m of other.src.matchAll(importRe)) {
          const clause = m[1];
          for (const name of exported) {
            // `import type { x }` and `{ type x }` are erased at compile time
            // and are safe to cross the boundary.
            const named = new RegExp(`(^|,)\\s*(type\\s+)?${name}\\s*(,|$)`);
            const match = named.exec(clause);
            if (!match) continue;
            if (match[2]) continue; // `type` prefixed — erased, fine
            if (/import\s+type\s+\{/.test(m[0])) continue;
            violations.push(
              `${other.rel} imports non-component "${name}" from client module ${client.rel}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
