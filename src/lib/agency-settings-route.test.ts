import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The tenancy contract of the agency settings surface.
 *
 * These routes edit the letterhead that goes on every report an agency sends,
 * and the whole safety argument is one structural property: **the tenant comes
 * from the session and appears nowhere else**. No `:agencyId` segment, no id in
 * the body, nothing to tamper with — so there is no ownership check that can be
 * forgotten, because there is no question to answer.
 *
 * That property is invisible to a typechecker and easy to undo in a refactor
 * that "makes the route more RESTful", which is why it is asserted here against
 * the source. The behaviour underneath (validation, the name fallback) is
 * covered by `agency-name.test.ts` and the shared upload helper's own tests.
 */

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

const SETTINGS = source("src", "app", "api", "agency", "settings", "route.ts");
const LOGO = source("src", "app", "api", "agency", "logo", "route.ts");
const PAGE = source("src", "app", "settings", "page.tsx");
const FORM = source("src", "components", "AgencySettingsForm.tsx");
const PROXY = source("src", "proxy.ts");

describe("agency settings — the tenant is the session's", () => {
  for (const [label, src] of [
    ["settings route", SETTINGS],
    ["logo route", LOGO],
  ] as const) {
    it(`${label} takes the agency from the session`, () => {
      expect(src).toContain("session!.agencyId");
      expect(src).toContain("isAgencyOperator");
    });

    it(`${label} never reads an agency id from the request`, () => {
      /*
       * 🔴 The one that matters. An id in the path or the body would need an
       * ownership check, and forgetting it lets one agency rewrite another's
       * letterhead — the raw material of a convincing invoice.
       */
      expect(src).not.toMatch(/params[^\n]*agencyId/);
      expect(src).not.toMatch(/body[^\n]*agencyId/);
      expect(src).not.toMatch(/agencyId:\s*z\./);
    });
  }

  it("refuses a session that has a role but no tenant", () => {
    // The pre-tenancy shared-password bootstrap. There is no row for it to edit,
    // and inserting one would violate the foreign key.
    expect(SETTINGS).toMatch(/if \(!session!\.agencyId\)/);
    expect(PAGE).toMatch(/if \(!session!\.agencyId\) redirect/);
  });

  it("rate-limits by agency rather than by IP", () => {
    // The resource is this tenant's row; a limit an actor could multiply by
    // changing networks would not protect it.
    expect(SETTINGS).toContain("agency-settings:${agencyId}");
  });

  it("stamps its audit entries with the agency", () => {
    // Otherwise the one event about an agency's own letterhead is the one its
    // audit page cannot show it. See `audit-scope.ts`.
    const entries = SETTINGS.match(/audit\.record\(\{/g) ?? [];
    expect(entries.length).toBeGreaterThan(0);
    expect(SETTINGS.match(/agencyId,/g)?.length ?? 0).toBeGreaterThanOrEqual(
      entries.length,
    );
  });

  it("verifies uploaded bytes through the shared helper", () => {
    // `readLogoUpload` sniffs magic bytes and rejects a file whose content
    // disagrees with its declared type. This route serves those bytes back.
    expect(SETTINGS).toContain("readLogoUpload");
  });
});

describe("agency settings — the form", () => {
  it("🔴 seeds the name field from the override, not the resolved name", () => {
    /*
     * Pre-filling with the resolved name would put the tenant's own name in the
     * box; saving would then write it into the override column, freezing a copy
     * by touching nothing. A later rename would stop reaching reports, and
     * nothing would look wrong at any point.
     */
    expect(FORM).toContain("initial.agencyNameOverride");
    expect(FORM).not.toMatch(/useState\(initial\.agencyName\s*\?\?/);
  });

  it("shows the tenant name as the placeholder", () => {
    // So "leave blank" reads as a choice with a visible result.
    expect(FORM).toContain("placeholder={tenantName}");
  });

  it("sends an empty string rather than omitting the name", () => {
    // Empty means "clear the override"; omitted means "leave unchanged". Those
    // are different instructions and the form needs the first one.
    expect(FORM).toContain("agencyName: name.trim()");
  });
});

describe("the proxy no longer blocks an agency from its audit trail", () => {
  it("has dropped the /audit redirect for the agency role", () => {
    /*
     * The redirect was correct while `audit_log` had no `agency_id`. Since 0024
     * it is not, and leaving it in place would make `auditScope` unreachable —
     * a scoped page nobody can open.
     */
    const agencyBranch = PROXY.slice(PROXY.indexOf('session.role === "agency"'));
    expect(agencyBranch.slice(0, 600)).not.toContain('"/audit"');
  });
});
