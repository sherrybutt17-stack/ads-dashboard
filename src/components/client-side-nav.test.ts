import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The client sidebar's items. Report is hidden on request (27 Oct 2026) —
 * commented out, not deleted, so it can come back — while the report page
 * itself stays, because emailed and shared report links open it.
 */

const NAV = readFileSync(join(__dirname, "ClientSideNav.tsx"), "utf8");
const LIVE = NAV.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the client sidebar", () => {
  it("🔴 shows no Report item", () => {
    expect(LIVE).not.toContain('label: "Report"');
    expect(LIVE).not.toContain("match: `/c/${slug}/report`");
  });

  it("keeps everything else", () => {
    for (const label of ["Overview", "Board", "Present", "Connections", "Branding", "All clients"]) {
      expect(LIVE, label).toContain(`label: "${label}"`);
    }
  });

  it("leaves the report page reachable for the links that open it", () => {
    expect(readFileSync(join(__dirname, "..", "app", "c", "[slug]", "report", "page.tsx"), "utf8")).toContain(
      "export default",
    );
  });
});
