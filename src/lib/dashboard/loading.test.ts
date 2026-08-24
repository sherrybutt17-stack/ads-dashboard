import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS, type SectionId } from "./registry";
import { SKIPPABLE, wants } from "./loading";

const DASHBOARD_SRC = readFileSync(
  join(process.cwd(), "src/lib/metrics/dashboard.ts"),
  "utf8",
);

describe("wants", () => {
  it("🔴 loads everything client-facing when no set is supplied", () => {
    /*
     * The important case, not a convenience default. The report route, the
     * share link, the present deck and the PDF renderer all build their own
     * section lists — a client who hid the funnel on their own screen has not
     * removed it from the board pack the agency sends.
     *
     * Staff-only sections are excluded here and asserted separately below. The
     * protection this test exists for is unaffected by that: what it guards
     * against is a client's PREFERENCES reaching an agency deliverable, and a
     * staff-only section cannot appear in one — `REPORT_SECTIONS` and the deck
     * both render from fixed lists that contain none.
     */
    for (const s of SECTIONS) {
      if (s.staffOnly) continue;
      expect(wants(undefined, s.id), s.id).toBe(true);
    }
  });

  it("loads a skippable section when it is visible", () => {
    expect(wants(new Set<SectionId>(["heatmap"]), "heatmap")).toBe(true);
  });

  it("skips a skippable section when it is hidden", () => {
    expect(wants(new Set<SectionId>(["kpis"]), "heatmap")).toBe(false);
  });

  it("🔴 loads a NON-skippable section even when hidden", () => {
    /*
     * The trap this design exists to avoid. `campaigns` is hidden here, and its
     * query must still run: `page.tsx` builds its campaign colour map from the
     * union of `data.campaigns` and `data.leads` and hands it to the pipeline
     * explorer too. Skip it and a client who hid the campaign table gets an
     * explorer where every campaign is a raw 17-digit id — and nobody would
     * connect those two events.
     */
    const onlyKpis = new Set<SectionId>(["kpis"]);
    expect(wants(onlyKpis, "campaigns")).toBe(true);
    expect(wants(onlyKpis, "pipeline")).toBe(true);
    expect(wants(onlyKpis, "trend")).toBe(true);
    expect(wants(onlyKpis, "keep_kill")).toBe(true);
  });

  it("treats an empty set as 'everything hidden', not as 'no preference'", () => {
    // The distinction between an empty Set and undefined is load-bearing: one
    // means a client hid every optional panel, the other means a surface that
    // does not use layouts at all.
    expect(wants(new Set(), "heatmap")).toBe(false);
    expect(wants(undefined, "heatmap")).toBe(true);
  });
});

describe("the skip table", () => {
  it("names only sections that exist", () => {
    const ids = new Set(SECTIONS.map((s) => s.id));
    for (const id of Object.keys(SKIPPABLE)) {
      expect(ids.has(id as SectionId), `${id} is not a real section`).toBe(true);
    }
  });

  it("🔴 every skippable section is actually gated in loadDashboard", () => {
    /*
     * Without this, adding a row to `SKIPPABLE` looks like it saves a query and
     * saves nothing — the entry is inert and the only symptom is a bill that
     * never goes down. Matches the `show("id")` call the loader uses.
     */
    const ungated = Object.keys(SKIPPABLE).filter(
      (id) => !DASHBOARD_SRC.includes(`show("${id}")`),
    );
    expect(
      ungated,
      "These sections are listed as skippable but no query is gated on them:",
    ).toEqual([]);
  });

  it("🔴 every gate in loadDashboard is declared skippable", () => {
    /*
     * The dangerous direction. A `show(...)` on a section that is NOT in the
     * table would skip a query while `wants` returns true for it — or worse,
     * skip one that another visible section reads. The table is the only place
     * that decision is reviewed, so nothing may gate without appearing in it.
     */
    const gated = [...DASHBOARD_SRC.matchAll(/\bshow\("([a-z_]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(gated.length).toBeGreaterThan(0);
    const undeclared = [...new Set(gated)].filter((id) => !(id in SKIPPABLE));
    expect(
      undeclared,
      "These queries are skipped but the section is not in SKIPPABLE:",
    ).toEqual([]);
  });

  it("does not claim a required section can be skipped", () => {
    // A `required: true` section cannot be hidden, so gating it would be dead
    // code that reads as a live saving.
    const required = SECTIONS.filter((s) => s.required).map((s) => s.id);
    for (const id of required) expect(id in SKIPPABLE).toBe(false);
  });

  it("saves something worth the extra round trip", () => {
    // The layout is now fetched serially before the dashboard. That only pays
    // for itself if a meaningful number of queries can come off.
    expect(Object.keys(SKIPPABLE).length).toBeGreaterThanOrEqual(8);
  });
});

describe("staff-only sections and the anonymous caller", () => {
  /*
   * 🔴 `wants(undefined, …)` is how the share link, the PDF renderer, the CSV
   * export and the summary route ask for data — they pass no section set so a
   * client's hidden funnel cannot remove the funnel from a board pack.
   *
   * Each of them also renders from a fixed list that contains no staff-only
   * section, so loading one's queries for them is work whose result is thrown
   * away. Budget pacing alone is five queries on every share view.
   */
  const staffOnly = SECTIONS.filter((s) => s.staffOnly).map((s) => s.id);

  it("has staff-only sections to reason about", () => {
    // Guards the assertions below from silently passing on an empty list.
    expect(staffOnly.length).toBeGreaterThan(0);
  });

  it("🔴 does not load a skippable staff-only section for a caller that named none", () => {
    for (const id of staffOnly) {
      if (!(id in SKIPPABLE)) continue;
      expect(wants(undefined, id), `${id} should not load unasked`).toBe(false);
    }
  });

  it("still loads it when the dashboard explicitly asks", () => {
    for (const id of staffOnly) {
      expect(wants(new Set([id]), id), `${id} should load when asked`).toBe(true);
    }
  });

  it("leaves every non-staff section loading exactly as before", () => {
    // The rule must not narrow anything else: a report with no section set
    // still gets the whole dashboard.
    for (const s of SECTIONS) {
      if (s.staffOnly) continue;
      expect(wants(undefined, s.id), `${s.id} must still load`).toBe(true);
    }
  });

  it("never withholds a non-skippable section, staff-only or not", () => {
    // The skippable check comes first deliberately — a section outside
    // SKIPPABLE has no separate query to save, so gating it would only risk
    // starving a consumer that reads it indirectly.
    for (const s of SECTIONS) {
      if (s.id in SKIPPABLE) continue;
      expect(wants(undefined, s.id)).toBe(true);
      expect(wants(new Set<SectionId>(), s.id)).toBe(true);
    }
  });
});
