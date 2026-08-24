import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Does the agency's mark actually reach the document?
 *
 * ── 🔴 The bug class this exists to stop ─────────────────────────────────
 *
 * Three fields on `agency_settings` were designed, stored, and never rendered:
 * `agency_name` had no fallback so every footer read "Prepared by " and stopped;
 * `logo_wordmark` had no reader outside a preview; `support_email` had none at
 * all. Each looked finished from every angle except the one that matters — what
 * the client receives — and none of it was visible to a typechecker, because
 * storing a value and printing it are different code paths that both compile.
 *
 * So this file asserts the WIRE: every settable field is traced from the form,
 * through the route, to the component that prints it. A field that gains a
 * control and no renderer fails here rather than at whoever opens the PDF.
 *
 * Source-level, not a render test, deliberately: `ReportDocument` is an async
 * server component that fetches published summaries, pipe status and commentary
 * from Postgres, so rendering it needs a database and would test everything
 * except the thing in question.
 */

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

const DOC = source("src", "components", "report", "ReportDocument.tsx");
const STORE = source("src", "lib", "branding-store.ts");
const FORM = source("src", "components", "AgencySettingsForm.tsx");
const ROUTE = source("src", "app", "api", "agency", "settings", "route.ts");

/** Every field the settings form can change, and where each must come out. */
const WIRED: Array<{ field: string; control: RegExp; rendered: RegExp }> = [
  {
    field: "trading name",
    control: /agencyName: name\.trim\(\)/,
    rendered: /markName/,
  },
  {
    field: "mark mode",
    control: /agencyMarkMode: markMode/,
    rendered: /agency\.agencyMarkMode/,
  },
  {
    field: "support email",
    control: /supportEmail: supportEmail\.trim\(\)/,
    rendered: /agency\.supportEmail/,
  },
  {
    field: "wordmark",
    control: /form\.set\("logo", file\)/,
    rendered: /agencyLogoDataUri/,
  },
];

describe("every agency setting reaches the report", () => {
  for (const { field, control, rendered } of WIRED) {
    it(`${field}: the form can set it`, () => {
      expect(FORM).toMatch(control);
    });

    it(`${field}: the document prints it`, () => {
      expect(DOC).toMatch(rendered);
    });
  }

  it("the route accepts exactly the fields the form sends, and no others", () => {
    // `.strict()` — so a field added to the form without being added here is a
    // 400 at the boundary rather than a value silently dropped on the floor.
    expect(ROUTE).toContain(".strict()");
    for (const key of ["agencyName", "agencyMarkMode", "supportEmail"]) {
      expect(ROUTE).toContain(key);
    }
  });
});

describe("how the mark is printed", () => {
  it("🔴 prints nothing rather than a dangling 'Prepared by'", () => {
    /*
     * The original bug. `agencyMarkMode` defaults to `prepared_by`, so a footer
     * that renders the label independently of the name produces the words
     * "Prepared by " followed by a gap — which reads as a broken renderer on a
     * document going to a client, and did so on every report ever sent.
     */
    expect(DOC).toMatch(/const showMark =/);
    expect(DOC).toMatch(/markName !== null/);
    // The whole footer disappears only when there is genuinely nothing in it.
    expect(DOC).toMatch(/if \(!showMark && !contactLine && !supportEmail\) return null/);
  });

  it("resolves the name against the tenant before deciding it is missing", () => {
    // Otherwise `showMark` would be false for every agency that never set an
    // override — which is all of them, there being no UI for it until now.
    expect(STORE).toMatch(/agencyName: s\.agencyName \?\? row\.tenantName/);
  });

  it("inlines the wordmark rather than linking it", () => {
    /*
     * A share link's reader has no session, so `/api/agency/logo` 401s for
     * exactly the audience the mark exists for. The same trap the client logo
     * was already written around.
     */
    expect(STORE).toContain("getAgencyLogoDataUri");
    expect(DOC).not.toMatch(/src=\{[^}]*\/api\/agency\/logo/);
  });

  it("does not fetch the wordmark when the mark is switched off", () => {
    // `none` is a real choice, and reading bytes out of Postgres to discard
    // them is work done to produce nothing.
    expect(DOC).toMatch(/agency\.hasLogo && agency\.agencyMarkMode !== "none"/);
  });

  it("keeps the name available when the wordmark cannot render", () => {
    // Alt text, so a plain-text client or a blocked image still says who
    // prepared the report.
    expect(DOC).toMatch(/alt=\{markName/);
  });
});
