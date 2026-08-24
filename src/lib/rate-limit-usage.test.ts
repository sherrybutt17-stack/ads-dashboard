import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * That every `rateLimit` call actually gates something.
 *
 * ── 🔴 The bug this exists to prevent, which shipped three times ───────
 *
 * `rateLimit` returns `{ ok, retryAfterMs }`. An object is always truthy, so
 *
 *     if (!rateLimit(key, limit, window)) return tooMany()
 *
 * reads exactly like a working guard, typechecks, lints, and **can never
 * fire**. It shipped on the commentary save route, the AI summary generate
 * route and the summary edit route — and on the generate route it was the only
 * thing bounding paid model calls, so an unbounded loop would have been billed
 * rather than refused.
 *
 * Nothing catches this. TypeScript is satisfied because `!` accepts any type;
 * a unit test of `rateLimit` itself passes because the function is correct; and
 * the failure is invisible at runtime because the happy path is identical.
 * The only thing that catches it is reading the call sites, so that is what
 * this does.
 *
 * The check is deliberately syntactic and slightly over-broad: every call must
 * bind its result, and every binding must be read for `.ok` somewhere in the
 * same file. A future call shape that is genuinely fine but does not match will
 * fail here, and the fix is to look at it and then widen this test — which is
 * the correct amount of friction for this particular mistake.
 */

const ROOT = join(process.cwd(), "src");

function sources(dir = ROOT, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...sources(join(dir, entry.name), rel));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      // The limiter's own definition names `rateLimit` and is not a call site.
      if (rel !== "lib/rate-limit.ts") out.push(rel);
    }
  }
  return out;
}

/**
 * Comments out, so the walker reads code.
 *
 * Not fussiness: the fix for this bug documents itself by quoting the broken
 * form — `if (!rateLimit(...))` appears verbatim in the comment above each
 * corrected guard, so a scanner over raw text flags the very files that were
 * repaired and reports the repair as the defect.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("rateLimit call sites", () => {
  const files = sources()
    .map((rel) => ({ rel, src: code(readFileSync(join(ROOT, rel), "utf8")) }))
    .filter(({ src }) => /\brateLimit\s*\(/.test(src));

  it("finds the call sites it is checking", () => {
    // If this drops to zero the walker has stopped walking and every assertion
    // below would pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it("🔴 never negates the call directly — the result is an object", () => {
    const offenders = files.filter(({ src }) => /!\s*rateLimit\s*\(/.test(src));
    expect(
      offenders.map((f) => f.rel),
      "`rateLimit` returns { ok, retryAfterMs }. `!rateLimit(...)` is always false, so this guard never fires. Bind the result and test `.ok`.",
    ).toEqual([]);
  });

  it("🔴 reads `.ok` in every file that calls it", () => {
    const offenders = files.filter(({ src }) => !/\.ok\b/.test(src));
    expect(
      offenders.map((f) => f.rel),
      "This file calls rateLimit and never reads `.ok`, so whatever it computed is discarded.",
    ).toEqual([]);
  });

  it("binds the result rather than using it inline as a condition", () => {
    /*
     * `if (rateLimit(...))` is the other half of the same mistake: also always
     * truthy, also silently wrong, and it fails open in the opposite direction —
     * every request is treated as rate-limited.
     */
    const offenders = files.filter(({ src }) =>
      /if\s*\(\s*!?\s*rateLimit\s*\(/.test(src),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });
});
