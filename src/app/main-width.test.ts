import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 A centred <main> must be told its width.
 *
 * Every page sits in `.app-frame`, a flex column. `mx-auto` on a flex item
 * turns off stretch, so a <main> with only a max-width sizes itself to its
 * widest content instead of to the frame. The client dashboard did exactly
 * that: on the Reports tab the moving-averages table is ~1400px wide, the
 * column grew to match, and the frame clipped the right-hand KPI cards — while
 * the table's own scroll box, built for precisely this, never engaged.
 *
 * Nothing errors when this regresses; the page just quietly loses its right
 * edge at laptop widths. So every centred <main> must carry `w-full`.
 */

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("centred <main> width", () => {
  const files = walk(SRC);

  it("finds the pages it is checking", () => {
    // Without this the assertion below passes vacuously if the walk breaks.
    expect(files.filter((f) => readFileSync(f, "utf8").includes("<main")).length).toBeGreaterThan(8);
  });

  it("🔴 every <main> centred with mx-auto also takes the full width", () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = line.match(/<main[^>]*className="([^"]*)"/);
          if (m && /(?:^|\s)mx-auto(?:\s|$)/.test(m[1]) && !/(?:^|\s)w-full(?:\s|$)/.test(m[1])) {
            offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
          }
        });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
