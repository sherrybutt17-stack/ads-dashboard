import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * No backticks inside a `sql` template literal.
 *
 * ── The bug this exists to stop, which has now happened five times ─────
 *
 * The SQL in this codebase is heavily commented, and the house style quotes
 * identifiers in prose with backticks. Inside a tagged template literal a
 * backtick ENDS THE STRING:
 *
 *     const q = sql`
 *       SELECT ...
 *       -- `fb_daily_metrics` holds one row per campaign per day
 *     `
 *
 * …closes the template at `fb_`, leaves `daily_metrics` as a stray identifier,
 * and reopens a new template at the next backtick. It has broken the build five
 * separate times on this project — in `getCallTiming`, in `getDuplicateCandidates`,
 * and three times before that.
 *
 * Usually it surfaces as a TypeScript parse error a few lines later, which is
 * survivable but wastes a cycle every time. The reason it is worth a test
 * rather than a habit is the case where it does NOT: if the fragments either
 * side happen to parse, the result is a silently truncated query rather than an
 * error, and the failure moves from the build to production.
 *
 * The scanner is a small state machine rather than a regex because the thing it
 * is looking for is definitionally "inside a string", which regexes cannot see.
 */

const ROOT = join(process.cwd(), "src");

function sources(dir = ROOT, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sources(join(dir, entry.name), rel));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Every place a `sql` template opens, and the character index just past it.
 *
 * `sql.raw(` and `sql.join(` are function calls, not templates, so the match
 * requires the backtick to follow the identifier immediately.
 */
function sqlTemplateStarts(src: string): number[] {
  const starts: number[] = [];
  const re = /\bsql`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) starts.push(m.index + m[0].length);
  return starts;
}

/**
 * Walk from the opening backtick to the matching close, reporting any backtick
 * found inside a comment on the way.
 *
 * Nested `${…}` interpolations are skipped by depth, since a backtick inside one
 * is a nested template and legitimate. In practice this codebase has none, and
 * the depth counter is what makes that assumption safe rather than lucky.
 */
function offendingLines(src: string, from: number): number[] {
  const bad: number[] = [];
  let depth = 0;
  let inBlockComment = false;
  let inLineComment = false;

  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      else if (ch === "`" && depth === 0) bad.push(lineOf(src, i));
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      } else if (ch === "`" && depth === 0) bad.push(lineOf(src, i));
      continue;
    }

    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "$" && next === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth--;
      continue;
    }
    if (depth === 0) {
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i++;
        continue;
      }
      if (ch === "-" && next === "-") {
        inLineComment = true;
        i++;
        continue;
      }
      // The close of the template itself.
      if (ch === "`") return bad;
    }
  }
  return bad;
}

const lineOf = (src: string, index: number) =>
  src.slice(0, index).split("\n").length;

describe("SQL template literals", () => {
  const files = sources()
    .map((rel) => ({ rel, src: readFileSync(join(ROOT, rel), "utf8") }))
    .filter(({ src }) => sqlTemplateStarts(src).length > 0);

  it("finds the files it is checking", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((f) => f.rel === "lib/metrics/queries.ts")).toBe(true);
  });

  it("🔴 contain no backticks inside their comments", () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      for (const start of sqlTemplateStarts(src)) {
        for (const line of offendingLines(src, start)) {
          offenders.push(`${rel}:${line}`);
        }
      }
    }
    expect(
      offenders,
      "A backtick inside a sql`` template ends the string. Write the identifier without backticks:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("detects the bug when it is present", () => {
    // The scanner is only worth having if it fires, so prove it on a fixture
    // rather than trusting an empty result above.
    const broken = ["const q = sql`", "  SELECT 1", "  /* `oops` */", "`"].join("\n");
    expect(offendingLines(broken, sqlTemplateStarts(broken)[0]).length).toBe(2);
  });

  it("does not fire on a backtick outside the template", () => {
    const fine = ["const q = sql`SELECT 1`", "// `this one is fine`"].join("\n");
    expect(offendingLines(fine, sqlTemplateStarts(fine)[0])).toEqual([]);
  });

  it("does not fire on a line comment that carries no backtick", () => {
    const fine = ["const q = sql`", "  -- a plain comment", "  SELECT 1", "`"].join("\n");
    expect(offendingLines(fine, sqlTemplateStarts(fine)[0])).toEqual([]);
  });
});
