import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * 🔴 No Server Component may hand a FUNCTION to a component it renders.
 *
 * This is the quietest failure mode in the whole app, and it has already
 * shipped twice.
 *
 * Props crossing from a Server Component into a Client Component are
 * serialized. A function cannot be serialized, so React throws at RENDER time:
 *
 *   Functions cannot be passed directly to Client Components unless you
 *   explicitly expose it by marking it with "use server".
 *
 * Every layer above that says the code is fine. `tsc` is happy — the prop types
 * match. `next build` is happy — nothing is wrong with the module graph. The
 * request is happy: React catches the throw at the nearest error boundary and
 * the route still answers **HTTP 200**. What the reader gets is a page with a
 * hole in it — the tab bar missing, or a panel's chart missing — with no error
 * anywhere except a line in the server log nobody is reading.
 *
 * The two that got through:
 *
 *   `DashboardTabs` took `hrefForGroup: (g) => string`. When it became a client
 *   component for the active-tab styling, the whole dashboard body vanished
 *   from every tab — 110KB of HTML where 187KB was expected — and still
 *   returned 200.
 *
 *   `CategoryChart` took `format: (n: number) => string`. Four of its callers
 *   are Server Components, so the recommendations, creatives and leads tabs
 *   rendered without the panels that mount it.
 *
 * Both fixes were the same shape, and it is the shape this test exists to keep:
 * pass DATA, and let the client component derive the function. `NavGroup.href`
 * is a resolved string; `CategoryFormat` is `{ kind: "money", currency }`. A
 * descriptor cannot be passed wrongly because there is no function to pass.
 *
 * The check is deliberately coarse — it flags any function-valued JSX prop in a
 * file without the `"use client"` directive, without working out whether the
 * receiving component happens to be a Server Component too. Server-to-server is
 * legal React, and there is currently not one instance of it in this codebase.
 * If a real one ever arrives, add it to ALLOWED below with a note saying which
 * component receives it and why that component can never become a client one —
 * which is the question worth being forced to answer, because the day it does
 * become one is the day the page silently loses a section.
 */

/** Files that legitimately pass a function server-side. See the note above. */
const ALLOWED: ReadonlySet<string> = new Set<string>([]);

const SRC = join(__dirname, "..");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * A JSX prop whose value opens with a function: `p={(a) => …}`, `p={a => …}`,
 * `p={function …}`. Anchored to a newline so it only matches a prop on its own
 * line, which is how the formatter writes every multi-prop element here.
 */
const INLINE_FN = /\n\s*([a-zA-Z_$][\w$]*)=\{\s*(?:\([^)]*\)\s*=>|function\b|[a-zA-Z_$][\w$]*\s*=>)/g;

/** A JSX prop given a bare identifier: `p={formatNumber}`, `p={chart.format}`. */
const IDENT_PROP = /\n\s*([a-zA-Z_$][\w$]*)=\{([a-zA-Z_$][\w$.]*)\}/g;

interface Offence {
  file: string;
  line: number;
  prop: string;
  detail: string;
}

function scan(file: string, source: string): Offence[] {
  const found: Offence[] = [];
  const at = (index: number) => source.slice(0, index).split("\n").length + 1;

  for (const m of source.matchAll(INLINE_FN)) {
    found.push({ file, line: at(m.index), prop: m[1], detail: "an inline function" });
  }

  for (const m of source.matchAll(IDENT_PROP)) {
    const root = m[2].split(".")[0];
    /*
     * The identifier is only a function if the file calls it somewhere. A prop
     * given a plain value — `height={CHART_HEIGHT}`, `data={rows}` — is fine,
     * and most identifier props are exactly that.
     */
    if (!new RegExp(`\\b${root}\\s*\\(`).test(source)) continue;
    found.push({ file, line: at(m.index), prop: m[1], detail: `\`${m[2]}\`, which is called in this file` });
  }

  return found;
}

describe("the server/client boundary", () => {
  const files = tsxFiles(SRC)
    .map((f) => ({ path: relative(SRC, f), source: readFileSync(f, "utf8") }))
    .filter((f) => !f.source.trimStart().startsWith('"use client"'))
    .filter((f) => !ALLOWED.has(f.path));

  it("finds components to check", () => {
    // A rename or a moved directory must not turn this suite into a no-op.
    expect(files.length).toBeGreaterThan(10);
  });

  it("never passes a function as a prop from a Server Component", () => {
    const offences = files.flatMap((f) => scan(f.path, f.source));

    const report = offences
      .map(
        (o) =>
          `${o.file}:${o.line} passes ${o.detail} as \`${o.prop}\`.\n` +
          `    If it reaches a Client Component this throws at render and the ` +
          `section disappears from a page that still answers 200. Pass data ` +
          `instead and derive the function inside the client component.`,
      )
      .join("\n");

    expect(report, report).toBe("");
  });
});
