import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SECTIONS,
  SECTION_BY_ID,
  REPORT_SECTIONS,
  SECTION_GROUPS,
  CADENCE_LABEL,
  CADENCE_HINT,
  isSectionGroup,
  parseSectionGroup,
  type SectionId,
} from "./registry";

/**
 * The dashboard's sections, as data.
 *
 * These are constants, so the tests are consistency rules rather than
 * behaviour — which is the point. `SectionId` is a hand-written union and
 * `SECTIONS` is a separate array; nothing makes them agree, and the compiler
 * cannot help because `SECTION_BY_ID` is built with `Object.fromEntries` and
 * CAST to `Record<SectionId, SectionDef>`.
 *
 * 🔴 That cast is the whole risk. An id in the union with no entry in the array
 * reads back as `undefined` from a lookup the type insists is a `SectionDef`,
 * so the failure is a property access on undefined at render time — in
 * production, on one client's dashboard, for whoever happens to have that
 * section in their stored layout.
 */

const SRC = readFileSync(join(__dirname, "registry.ts"), "utf8");

/** The union members, read from the source — there is no runtime list of them. */
const UNION_IDS = (() => {
  const block = SRC.slice(
    SRC.indexOf("export type SectionId ="),
    SRC.indexOf("export const SECTIONS"),
  );
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
})();

describe("🔴 SectionId and SECTIONS cannot drift apart", () => {
  it("parses the union it is checking", () => {
    // Guards the test itself: a refactor that renames the type would otherwise
    // leave this comparing two empty lists and passing forever.
    expect(UNION_IDS.length).toBeGreaterThan(20);
  });

  it("has an entry in SECTIONS for every id in the union", () => {
    const defined = SECTIONS.map((s) => s.id as string);
    const missing = UNION_IDS.filter((id) => !defined.includes(id));
    expect(
      missing,
      `These are valid \`SectionId\`s with no entry in SECTIONS. ` +
        `\`SECTION_BY_ID[id]\` returns undefined for them while typed as a ` +
        `SectionDef:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has a union member for every entry in SECTIONS", () => {
    // The other direction is milder — a section nothing can reference — but it
    // is dead weight in every list the settings drawer maps over.
    const orphans = SECTIONS.map((s) => s.id as string).filter(
      (id) => !UNION_IDS.includes(id),
    );
    expect(orphans).toEqual([]);
  });

  it("🔴 resolves every id through SECTION_BY_ID", () => {
    /*
     * The assertion the cast defeats. Stated against the actual lookup rather
     * than inferred from the two lists agreeing, because that lookup is what
     * every caller uses.
     */
    for (const id of UNION_IDS) {
      expect(
        SECTION_BY_ID[id as SectionId],
        `SECTION_BY_ID["${id}"] is undefined`,
      ).toBeDefined();
    }
  });

  it("has no duplicate ids", () => {
    // A duplicate silently wins in `Object.fromEntries` — the last one — so the
    // section a caller gets is decided by array order rather than by intent.
    const ids = SECTIONS.map((s) => s.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

describe("REPORT_SECTIONS", () => {
  it("🔴 references only sections that exist", () => {
    /*
     * This drives the share-link document — an unauthenticated bearer URL that
     * gets forwarded through mail servers and cannot be recalled. An id here
     * with no definition is a render failure on a page the recipient cannot
     * refresh their way out of, and which nobody on the agency side will see.
     */
    const defined = SECTIONS.map((s) => s.id as string);
    const missing = REPORT_SECTIONS.filter((id) => !defined.includes(id));
    expect(missing).toEqual([]);
  });

  it("stays an allowlist, not everything", () => {
    // The default for a share link must be exclusion. If this ever equals the
    // full section list, the allowlist has stopped being one.
    expect(REPORT_SECTIONS.length).toBeLessThan(SECTIONS.length);
  });

  it("has no duplicates, which would render a section twice", () => {
    expect([...REPORT_SECTIONS]).toEqual([...new Set(REPORT_SECTIONS)]);
  });
});

describe("groups", () => {
  it("every section belongs to a declared group", () => {
    // The nav maps over SECTION_GROUPS; a section in an unlisted group is
    // unreachable from the UI while looking perfectly configured here.
    const groups = new Set(SECTION_GROUPS.map((g) => g.id as string));
    const strays = SECTIONS.filter((s) => !groups.has(s.group as string)).map(
      (s) => `${s.id} → ${s.group}`,
    );
    expect(strays).toEqual([]);
  });

  it("every declared group contains at least one section", () => {
    // An empty group renders a nav heading over nothing.
    const used = new Set(SECTIONS.map((s) => s.group as string));
    const empty = SECTION_GROUPS.map((g) => g.id as string).filter(
      (g) => !used.has(g),
    );
    expect(empty).toEqual([]);
  });

  it("accepts a known group and rejects anything else", () => {
    expect(isSectionGroup("overview")).toBe(true);
    expect(isSectionGroup("nope")).toBe(false);
    expect(isSectionGroup(undefined)).toBe(false);
    expect(isSectionGroup(null)).toBe(false);
    expect(isSectionGroup(123)).toBe(false);
  });

  it("🔴 falls back rather than throwing on an unknown group", () => {
    // The group arrives from a query string. A throw here is a 500 on the
    // dashboard for a typo'd URL somebody bookmarked.
    expect(parseSectionGroup("nonsense")).toBe(parseSectionGroup(undefined));
    expect(isSectionGroup(parseSectionGroup("nonsense"))).toBe(true);
  });
});

describe("cadence labels", () => {
  it("every cadence a section declares has a label and a hint", () => {
    /*
     * The load-bearing field: it tells the reader which window a section
     * actually describes, because the date picker at the top of the page does
     * nothing for the fixed trailing-window tables below it. A cadence with no
     * label renders `undefined` — or nothing — exactly where that warning
     * should be.
     */
    for (const s of SECTIONS) {
      expect(Object.hasOwn(CADENCE_LABEL, s.cadence)).toBe(true);
      expect(Object.hasOwn(CADENCE_HINT, s.cadence)).toBe(true);
    }
  });
});
