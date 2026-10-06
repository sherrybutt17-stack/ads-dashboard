import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 `--series-*` names a data entity, not a colour you liked.
 *
 * `--series-1` is "blue — spend". It is the first hue of the categorical ramp,
 * and its whole job is that the same entity wears the same colour everywhere it
 * is drawn. That only works if nothing else wears it.
 *
 * Plenty else did. The Save button on /settings, the role picker and dashboard
 * chips on /users, the audit category filters, the pipeline campaign filters,
 * every selected date in the range calendar, every date preset in the header,
 * and the inline links on /about and /legal were all painted in spend blue —
 * so the primary action on a settings form and a spend line on a chart were the
 * same colour, and the app's own accent appeared almost nowhere outside the
 * dashboard. None of it was a visual bug on any single screen, which is why it
 * spread: each site was only ever "a blue that matches the charts".
 *
 * Selection and primary actions are `--accent`. The ramp belongs to the data.
 *
 * The rule cannot be checked per-property — a chart legend swatch and a chip
 * background are both `background:` — so it is checked per-module: only code
 * that draws data, plus the one wayfinding site below, may name a series colour.
 */

const SRC = join(__dirname, "..");

/** Modules that draw data, and so may name a series colour. */
const DRAWS_DATA = new Set([
  "components/CampaignStageTable.tsx",
  /*
   * The shared bar/line/circle chart. It OWNS the categorical ramp — consumers
   * hand it `{key, label, value}` and never a colour — which is why adding
   * charts to a dozen panels added exactly one name to this list rather than a
   * dozen. Keep it that way: a panel that picks its own series colour is a
   * panel whose legend can disagree with the chart beside it.
   */
  "components/CategoryChart.tsx",
  "components/ChannelMix.tsx",
  "components/Maturation.tsx",
  "components/PipelineExplorer.tsx",
  "components/SpeedOutcome.tsx",
  "components/TrendCharts.tsx",
  "lib/dashboard/sections.tsx",
]);

/**
 * The one site that names the ramp without drawing anything: section wayfinding.
 *
 * Each dashboard section carries a subject-assigned hue (`SectionHue` in
 * lib/dashboard/registry.ts) that paints a 3px rule and the heading beside it,
 * so a reader scrolling a thirty-section page can tell where they are without
 * reading. It reuses the ramp instead of inventing a parallel one because a
 * second set of eight hues is a second set to keep accessible and in tune.
 *
 * This does not reopen the hole the rule was written to close. What made
 * settings-blue a bug was a MARK-shaped thing — a filled chip, a selected date,
 * a button — wearing a data colour, which is unreadable from a legend. The band
 * is never a mark: it is a rule outside the plot frame and the heading above it,
 * and it paints in `--series-N-ink`, the text ramp, not the mark values. Nothing
 * inside a chart's own bounds is affected, so a legend still means what it says.
 *
 * Keep this set at one entry. A second name on it is the rule dissolving.
 */
const WAYFINDING = new Set(["app/c/[slug]/page.tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe("series palette", () => {
  it("is named only by code that draws data", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel === "app/series-palette.test.ts") continue;
      if (DRAWS_DATA.has(rel) || WAYFINDING.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        const m = line.match(/var\(--series-[^)]*\)/);
        if (m) offenders.push(`${rel}:${i + 1}  ${m[0]}`);
      });
    }
    expect(
      offenders,
      "these name a chart series outside a chart — selection and primary " +
        "actions are --accent:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("still has every consumer on the list", () => {
    // The allowlist decays into a rubber stamp if it keeps names that have
    // since stopped drawing anything.
    const live = new Set(
      walk(SRC)
        .filter((f) => /var\(--series-[^)]*\)/.test(readFileSync(f, "utf8")))
        .map((f) => f.slice(SRC.length + 1)),
    );
    const stale = [...DRAWS_DATA, ...WAYFINDING].filter((f) => !live.has(f));
    expect(stale, `no longer names a series colour: ${stale.join(", ")}`).toEqual([]);
  });
});
