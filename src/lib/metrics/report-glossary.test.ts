import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  METRIC_DEFINITIONS,
  REPORT_GLOSSARY,
  REPORT_GLOSSARY_LABEL,
} from "./definitions";

/*
 * The report's glossary is a hand-maintained list pointing at two things it
 * does not own: the definitions table, and the tile labels printed on the page.
 * Both drift silently — a renamed tile leaves a glossary entry describing a
 * heading that no longer exists, and a new headline metric simply goes
 * undefined. Neither breaks anything visibly; the report just quietly stops
 * explaining itself, which is the failure it was added to fix.
 */

const SECTIONS = readFileSync(
  join(__dirname, "..", "dashboard", "sections.tsx"),
  "utf8",
);

/**
 * The KPI section's tiles, read from source as (label, metricKey) pairs.
 *
 * Slicing at `case "kpis"` and stopping at the next `case ` keeps this to the
 * headline row — other sections use `StatTile` too, and the glossary is
 * deliberately not a definition of every number in the app.
 */
function headlineTiles(): Array<{ label: string; metricKey: string }> {
  const start = SECTIONS.indexOf('case "kpis":');
  expect(start, 'sections.tsx no longer has a `case "kpis":`').toBeGreaterThan(-1);
  const end = SECTIONS.indexOf("case ", start + 10);
  const block = SECTIONS.slice(start, end === -1 ? undefined : end);

  return [...block.matchAll(/<StatTile\b[\s\S]*?\/>/g)].flatMap((m) => {
    const label = /label="([^"]+)"/.exec(m[0])?.[1];
    const metricKey = /metricKey="([^"]+)"/.exec(m[0])?.[1];
    return label && metricKey ? [{ label, metricKey }] : [];
  });
}

describe("report glossary", () => {
  it("parses the headline tiles it is checking against", () => {
    // Guards the regex itself: if this drops to zero the two tests below pass
    // vacuously and the glossary is unprotected.
    expect(headlineTiles().length).toBeGreaterThanOrEqual(6);
  });

  it("every listed key has a definition", () => {
    const missing = REPORT_GLOSSARY.filter((k) => !METRIC_DEFINITIONS[k]);
    expect(
      missing,
      `Listed in REPORT_GLOSSARY but absent from METRIC_DEFINITIONS, so the report silently omits them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every listed key has a heading", () => {
    const missing = REPORT_GLOSSARY.filter((k) => !REPORT_GLOSSARY_LABEL[k]);
    expect(
      missing,
      `No heading, so the entry would print its raw key: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("🔴 every headline number on the report is defined", () => {
    /*
     * The report leads with six tiles and they are the numbers a client acts
     * on. A seventh added later without a definition is exactly the kind of
     * silent omission this product exists to replace — the figure appears, the
     * glossary does not mention it, and nobody notices because nothing breaks.
     */
    const undefinedTiles = headlineTiles()
      .map((t) => t.metricKey)
      .filter((k) => !REPORT_GLOSSARY.includes(k));

    expect(
      undefinedTiles,
      `These headline tiles print on the report with no definition behind them. ` +
        `Add each to REPORT_GLOSSARY (and REPORT_GLOSSARY_LABEL): ${undefinedTiles.join(", ")}`,
    ).toEqual([]);
  });

  it("🔴 glossary headings match the tile labels word for word", () => {
    /*
     * A reader looking up "Closed / won" and finding "Closed-won deals" has to
     * decide whether they are the same metric. A glossary that provokes that
     * question has failed at its only job, so a rename on either side fails
     * here rather than shipping.
     */
    for (const tile of headlineTiles()) {
      if (!REPORT_GLOSSARY.includes(tile.metricKey)) continue;
      expect(
        REPORT_GLOSSARY_LABEL[tile.metricKey],
        `The report prints this tile as "${tile.label}" but the glossary heads it differently`,
      ).toBe(tile.label);
    }
  });

  it("stays short enough to be read", () => {
    /*
     * Not arbitrary tidiness. The definitions table holds 24 entries and the
     * report shows six numbers; printing all of them would make the block
     * skippable, and it exists for the three or four entries that change how a
     * figure should be understood.
     */
    expect(REPORT_GLOSSARY.length).toBeLessThanOrEqual(10);
    expect(Object.keys(METRIC_DEFINITIONS).length).toBeGreaterThan(
      REPORT_GLOSSARY.length,
    );
  });

  it("🔴 keeps the funnel's between-stage caveat, which is the most misread figure", () => {
    // "62% showed" reads as a share of leads. It is a share of appointments,
    // and the difference is the whole reason `definitions.ts` exists.
    expect(REPORT_GLOSSARY).toContain("funnelStep");
    const caveat = METRIC_DEFINITIONS.funnelStep?.caveat ?? "";
    expect(caveat).toMatch(/not by leads/i);
  });
});
