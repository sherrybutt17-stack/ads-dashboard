import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 🔴 The Board says who counted every number — wired, not just written.
 *
 * The rules live in `lib/board/source.ts` and are tested there. These pin the
 * places that use them, because the failure they prevent is silent: a picker
 * that lists the CRM's "Leads" without saying so, or a tile that tags a CRM
 * count "· META", still renders and still passes every other test.
 */

const read = (file: string) =>
  readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const PICKER = read("WidgetPicker.tsx");
const TILE = read("BoardWidget.tsx");

describe("the widget picker", () => {
  it("offers a 'Counted by' filter, and applies it to the presets", () => {
    expect(PICKER).toContain("sourceChoices(draft.platform)");
    expect(PICKER).toMatch(/\.filter\(\(\{ sources \}\) => matchesSource\(sources, counted\)\)/);
    expect(PICKER).toContain("sourceBadge(sources, draft.platform)");
  });

  it("names each stat with its counter, heads each group with it, and explains the chosen one", () => {
    expect(PICKER).toContain("{statName(reg, m, draft.platform)}");
    expect(PICKER).toContain("label={pickerGroup(group, stats, reg, draft.platform)}");
    expect(PICKER).toContain("sourceNote(sourceOf(reg, draft.metric), draft.platform)");
  });

  it("narrows the table's columns the same way, and never leaves the form on a hidden stat", () => {
    expect(PICKER).toContain('(counted === "all" || sourceOf(reg, m) === counted)');
    expect(PICKER).toContain("function chooseCounted(next: SourceFilter)");
  });
});

describe("a Board tile", () => {
  it("🔴 tags its numbers by who counted them, not by platform alone", () => {
    expect(TILE).toContain("sourceTag(widgetSources(query, reg), platform, showPlatform)");
    expect(TILE).not.toMatch(/showPlatform && platform \? PLATFORM_LABEL\[platform\]/);
  });
});
