import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 A response header must be Latin-1.
 *
 * `new Response` (and so `NextResponse`) converts header values to a
 * ByteString and THROWS on any character past U+00FF. In a route handler that
 * throw lands after the work is done, outside any try block, as a bare 500 with
 * no body — which the UI can only report as "Render failed (500)".
 *
 * Both PDF downloads shipped exactly that: they sent `X-Report-Range:
 * rangeLabel(start, end)`, and `rangeLabel` prints "1–31 Jul 2026" with an en
 * dash. Every download failed after the PDF had rendered and been paid for.
 * Display labels belong in bodies; headers carry date keys and ASCII.
 */

const API = join(process.cwd(), "src", "app", "api");

function routes(dir = API, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) routes(p, out);
    else if (entry === "route.ts") out.push(p);
  }
  return out;
}

const files = routes().map((p) => ({ rel: p.slice(API.length + 1), src: readFileSync(p, "utf8") }));

describe("response headers", () => {
  it("finds the routes it is checking", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("is a real platform rule, not a style preference", () => {
    expect(() => new Response("x", { headers: { "X-Range": "1–31 Jul 2026" } })).toThrow(/ByteString/);
    expect(() => new Response("x", { headers: { "X-Range": "2026-07-01..2026-07-31" } })).not.toThrow();
  });

  it("🔴 never puts a display label into a header", () => {
    const offenders = files.filter(({ src }) => /["'][A-Za-z][\w-]*["']\s*:\s*rangeLabel\(/.test(src));
    expect(offenders.map((f) => f.rel), "a display label contains characters a header cannot carry").toEqual([]);
  });

  it("🔴 writes header literals in ASCII", () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      for (const m of src.matchAll(/["']((?:X|Content|Cache|Retry)-[\w-]*)["']\s*:\s*(["'`])([^"'`]*)\2/g)) {
        if (!/^[\x20-\x7e]*$/.test(m[3])) offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
