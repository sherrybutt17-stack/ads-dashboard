import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS, SECTION_BY_ID, REPORT_SECTIONS } from "./registry";

/**
 * What may appear on a report — the one surface reachable without a login.
 *
 * A share link is a bearer URL. It is emailed, forwarded, quoted in replies and
 * possibly logged along the way, and it cannot be recalled. So the question
 * "what does an unauthenticated stranger see?" has to have an answer that
 * survives future changes by people who are not thinking about share links at
 * the time — which means a test, not a comment.
 *
 * The failure being prevented is concrete and quiet: someone adds a section
 * that lists leads by name, the report picks it up, and forty people's contact
 * details are now on a URL sitting in a forwarded email thread. Nothing errors.
 */

describe("report section allowlist", () => {
  it("🔴 contains no section that renders individual people", () => {
    const leaking = REPORT_SECTIONS.filter(
      (id) => SECTION_BY_ID[id]?.containsLeadPii,
    );
    expect(
      leaking,
      `These sections render lead names, emails or phone numbers and must not appear on a share link:\n  ${leaking.join("\n  ")}`,
    ).toEqual([]);
  });

  it("names only sections that exist", () => {
    // A stale id renders nothing and fails silently — the report would simply
    // be missing a block, which is the failure mode this whole project replaces.
    const unknown = REPORT_SECTIONS.filter((id) => !SECTION_BY_ID[id]);
    expect(unknown).toEqual([]);
  });

  it("keeps the lead-source note, which tells the reader WHICH leads these are", () => {
    /*
     * Not decoration. The dashboard counts only leads matching the client's
     * paid-lead filter, and a report that omits that note is a report whose
     * numbers cannot be interpreted — the reader has no way to know whether
     * "142 leads" means all enquiries or only the paid ones.
     */
    expect(REPORT_SECTIONS).toContain("lead_filter_note");
    expect(REPORT_SECTIONS[0]).toBe("lead_filter_note");
  });

  it("is an allowlist — most dashboard sections are absent", () => {
    // Guards the guard. If REPORT_SECTIONS ever became "all sections", every
    // assertion above would still pass while the meaning had inverted.
    expect(REPORT_SECTIONS.length).toBeLessThan(SECTIONS.length);
  });

  it("at least one section IS flagged, so the PII check is not vacuous", () => {
    // Without this, deleting every `containsLeadPii` flag would turn the first
    // test into an assertion that passes by having nothing to check.
    expect(SECTIONS.some((s) => s.containsLeadPii)).toBe(true);
  });

  it("the report component renders from the registry list, not its own copy", () => {
    /*
     * The allowlist is only load-bearing if the renderer actually reads it. A
     * local `const REPORT_SECTIONS = [...]` in the component would leave this
     * whole file testing a constant nobody uses.
     */
    const src = readFileSync(
      join(process.cwd(), "src/components/report/ReportDocument.tsx"),
      "utf8",
    );
    expect(src).toMatch(
      /import\s*\{[^}]*REPORT_SECTIONS[^}]*\}\s*from\s*"@\/lib\/dashboard\/registry"/,
    );
    expect(src).not.toMatch(/const\s+REPORT_SECTIONS\s*[:=]/);
  });
});
