import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_STAGES,
  REQUIRED_CANONICAL_STAGES,
  STAGE_LABELS,
  FUNNEL_PATH,
  suggestCanonicalStage,
  type CanonicalStage,
} from "./stages";
import { canonicalStageEnum } from "@/db/schema";

/**
 * The canonical stage list — the thing that makes one metrics engine serve
 * every tenant.
 *
 * Each client names and orders their GHL stages differently; `pipeline_stages`
 * maps theirs onto these eight. So this list is not a display detail, it is the
 * vocabulary every funnel query, every conversion rate and every cost-per-stage
 * is expressed in.
 *
 * These are constants, so the tests are consistency rules rather than
 * behaviour. That is the point: the failure mode here is one of the four
 * exports drifting from the other three, which nothing else can see. A stage
 * added to `CANONICAL_STAGES` and forgotten in `STAGE_LABELS` renders as
 * `undefined` in the funnel; forgotten in the database enum, it throws on
 * write.
 */

describe("CANONICAL_STAGES", () => {
  it("🔴 is the single source of the database enum", () => {
    /*
     * `schema.ts` declares `pgEnum("canonical_stage", CANONICAL_STAGES)`, so
     * these cannot drift by construction — asserted anyway because the
     * direction of that dependency is the whole reason this module exists, and
     * someone reversing it (declaring the enum literally and importing it here)
     * would reintroduce the client-bundle leak with no other symptom.
     */
    expect([...canonicalStageEnum.enumValues]).toEqual([...CANONICAL_STAGES]);
  });

  it("has no duplicates", () => {
    expect(new Set(CANONICAL_STAGES).size).toBe(CANONICAL_STAGES.length);
  });

  it("uses snake_case throughout, matching the enum's stored form", () => {
    for (const s of CANONICAL_STAGES) expect(s).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });
});

describe("STAGE_LABELS", () => {
  it("🔴 labels every canonical stage, and only those", () => {
    // A missing label renders as `undefined` in the funnel and the mapping
    // dropdown — visible, but only to whoever opens that client's page.
    expect(Object.keys(STAGE_LABELS).sort()).toEqual([...CANONICAL_STAGES].sort());
    for (const s of CANONICAL_STAGES) {
      expect(STAGE_LABELS[s]).toBeTruthy();
    }
  });
});

describe("REQUIRED_CANONICAL_STAGES", () => {
  it("🔴 is every stage except `disqualified`", () => {
    /*
     * Plenty of pipelines have no junk stage, and not having one is a
     * legitimate way to run a CRM rather than a misconfiguration. Requiring it
     * would turn every existing client's health check amber the moment it
     * shipped, for a stage they never had and may never want.
     */
    expect(REQUIRED_CANONICAL_STAGES).not.toContain("disqualified");
    expect(REQUIRED_CANONICAL_STAGES).toHaveLength(CANONICAL_STAGES.length - 1);
    for (const s of REQUIRED_CANONICAL_STAGES) {
      expect(CANONICAL_STAGES).toContain(s);
    }
  });
});

describe("FUNNEL_PATH", () => {
  it("🔴 contains only steps, never exits", () => {
    /*
     * `no_show`, `lost` and `disqualified` are ways OUT of the funnel, not
     * stages leads flow through. Including one would imply progression through
     * it and make the drop-off between the surrounding pair meaningless.
     */
    for (const exit of ["no_show", "lost", "disqualified"] as CanonicalStage[]) {
      expect(FUNNEL_PATH).not.toContain(exit);
    }
  });

  it("is a subset of the canonical stages, in the order leads move", () => {
    expect(FUNNEL_PATH).toEqual([
      "new_lead",
      "contacted",
      "appointment_booked",
      "showed",
      "closed_won",
    ]);
    for (const s of FUNNEL_PATH) expect(CANONICAL_STAGES).toContain(s);
  });

  it("has no duplicates — each pair is one drop-off measurement", () => {
    expect(new Set(FUNNEL_PATH).size).toBe(FUNNEL_PATH.length);
  });

  it("🔴 keeps `disqualified` out of the close-rate denominator", () => {
    /*
     * The distinction this list encodes: `lost` means "a genuine prospect we
     * could not close" and belongs in the denominator — failing to close real
     * prospects is a sales problem worth measuring. A wrong number was never
     * winnable, so counting it as lost makes close rate look worse than reality
     * and buries the actual signal, that the ads are attracting the wrong
     * people — a targeting problem with a completely different fix.
     */
    expect(CANONICAL_STAGES).toContain("disqualified");
    expect(CANONICAL_STAGES).toContain("lost");
    expect(FUNNEL_PATH).not.toContain("disqualified");
    expect(FUNNEL_PATH).not.toContain("lost");
  });
});

/**
 * ── suggestCanonicalStage ─────────────────────────────────────────────
 *
 * A suggester is normally low-stakes: guess wrong and someone corrects the
 * dropdown. It was not low-stakes here, because `importPipelineStages` wrote
 * its answer straight into `pipeline_stages.canonical_stage` — the column the
 * funnel queries and the health check reads. Nothing records whether a mapping
 * was guessed or confirmed, so the guess WAS the mapping.
 *
 * These tests therefore treat it as funnel logic, not as a convenience. The
 * failure they exist to catch is not "an odd suggestion" but "junk counted as a
 * lost prospect", which reads as a sales problem forever after.
 */
describe("suggestCanonicalStage", () => {
  /*
   * 🔴 The regression this function was consolidated to fix.
   *
   * Both previous copies predated `disqualified` and neither could return it —
   * there was no branch for it in either. So the stage added specifically to
   * keep junk OUT of the close-rate denominator was unreachable from the only
   * two paths that fill a mapping, and the names that most obviously belong to
   * it were steered into `lost` instead.
   */
  const junk = [
    "Disqualified",
    "DQ",
    "DQ'd",
    "Unqualified",
    "Wrong Number",
    "Spam",
    "Junk Leads",
    "Test Lead",
    "Out of Area",
    "Out of the Area",
  ];

  it.each(junk)("🔴 suggests disqualified, never lost, for %j", (name) => {
    expect(suggestCanonicalStage(name)).toBe("disqualified");
  });

  it("🔴 keeps junk out of the close-rate denominator", () => {
    /*
     * Stated as its own assertion because this is the consequence, and it is
     * the reason the stage exists. `lost` means "a genuine prospect we could
     * not close" and belongs in close rate; a wrong number was never winnable.
     * Folding the two makes the sales team look worse than they are and hides
     * the real signal — that the ads are reaching the wrong people, which has a
     * completely different fix.
     */
    for (const name of junk) {
      expect(suggestCanonicalStage(name)).not.toBe("lost");
    }
  });

  it("still recognises a genuine lost prospect", () => {
    // The other half of the same distinction: narrowing `lost` to make room for
    // `disqualified` must not empty it out.
    expect(suggestCanonicalStage("Closed Lost")).toBe("lost");
    expect(suggestCanonicalStage("Lost")).toBe("lost");
    expect(suggestCanonicalStage("Not Interested")).toBe("lost");
    expect(suggestCanonicalStage("Dead Lead")).toBe("lost");
    expect(suggestCanonicalStage("Dead")).toBe("lost");
  });

  describe("rule order", () => {
    /*
     * Every one of these is a substring collision, and each would be silently
     * mis-bucketed by the same rules in a different order. They are the reason
     * the function is a sequence of tests rather than a lookup table.
     */
    it('reads "No Show" as no_show, not as a show', () => {
      expect(suggestCanonicalStage("No Show")).toBe("no_show");
      expect(suggestCanonicalStage("No-Show")).toBe("no_show");
      expect(suggestCanonicalStage("Noshow")).toBe("no_show");
      expect(suggestCanonicalStage("Didn't Show")).toBe("no_show");
      expect(suggestCanonicalStage("Missed Appointment")).toBe("no_show");
    });

    it('reads "Showed - Attended Appt" as showed, not as a booking', () => {
      /*
       * The two old copies disagreed here — the server tested `showed` first
       * and the wizard tested `appointment`. The attendance is the later,
       * more informative event, so it wins; a stage that says someone attended
       * is not a stage that says someone booked.
       */
      expect(suggestCanonicalStage("Showed - Attended Appt")).toBe("showed");
      expect(suggestCanonicalStage("Attended Consultation")).toBe("showed");
      expect(suggestCanonicalStage("Consultation Complete")).toBe("showed");
    });

    it("still reads a plain booking as a booking", () => {
      expect(suggestCanonicalStage("Appointment Booked")).toBe("appointment_booked");
      expect(suggestCanonicalStage("Consultation Booked")).toBe("appointment_booked");
      expect(suggestCanonicalStage("Consult Scheduled")).toBe("appointment_booked");
    });

    it("tests junk before lost and lost before the funnel steps", () => {
      // "Disqualified — Not Interested" hits both the junk rule and the lost
      // rule. Junk is the more specific claim about the lead, so it wins.
      expect(suggestCanonicalStage("Disqualified — Not Interested")).toBe(
        "disqualified",
      );
    });
  });

  describe("refusing to guess", () => {
    /*
     * The half of the contract that keeps this safe to offer. A null costs an
     * operator one dropdown; a confident wrong answer costs a funnel nobody
     * can see is wrong.
     */
    it.each([
      ["Closed", "won or lost is not stated"],
      ["Cancelled", "a cancelled appointment and a cancelled deal differ"],
      ["Customer", "could be a won deal or an existing-client stage"],
      ["Stage 4", "carries no meaning at all"],
      ["Review", "ambiguous between an internal review and a client one"],
    ])("returns null for %j — %s", (name) => {
      expect(suggestCanonicalStage(name)).toBeNull();
    });

    it("returns null for absent or blank names", () => {
      // `ghl_stage_name` is nullable — the element shape of GHL's `stages[]` is
      // unpublished, so a stage with no name is a real possibility.
      expect(suggestCanonicalStage(null)).toBeNull();
      expect(suggestCanonicalStage("")).toBeNull();
      expect(suggestCanonicalStage("   ")).toBeNull();
    });
  });

  it("ignores case and surrounding whitespace", () => {
    expect(suggestCanonicalStage("  APPOINTMENT BOOKED  ")).toBe(
      "appointment_booked",
    );
    expect(suggestCanonicalStage("nO sHoW")).toBe("no_show");
  });

  it("🔴 only ever returns a real canonical stage", () => {
    /*
     * A typo in a returned literal typechecks nowhere near here and fails at
     * the database as `invalid input value for enum canonical_stage`, on write,
     * in production. Sweep a broad name list rather than trusting the type.
     */
    const names = [
      ...junk,
      "New Lead", "Lead In", "Opt-In", "FB Lead", "New Opportunity",
      "Contacted", "Follow Up", "Nurture", "Call 2", "Texted", "Call Back",
      "Appointment Booked", "Showed", "No Show", "Closed Won", "Sold",
      "Deal Won", "Purchased", "Closed Lost", "Random Stage Name",
    ];
    for (const name of names) {
      const got = suggestCanonicalStage(name);
      if (got !== null) expect(CANONICAL_STAGES).toContain(got);
    }
  });

  it("🔴 is the only suggester in the codebase", () => {
    /*
     * The defect that motivated all of the above was not a bad rule, it was TWO
     * copies of the rules: one on the server, one in the wizard, disagreeing on
     * seven of sixteen real stage names. The server's ran first and persisted,
     * so the wizard's — the better of the two — was unreachable, because its
     * fill button skips any row that already has a value.
     *
     * Duplication is the actual failure mode, and it is invisible while both
     * copies happen to agree. So assert the wizard imports this one rather than
     * carrying its own.
     */
    const wizard = readFileSync(
      join(process.cwd(), "src/components/SetupWizard.tsx"),
      "utf8",
    );
    expect(wizard).toContain("suggestCanonicalStage");
    expect(wizard).not.toMatch(/function\s+suggest\w*Canonical/);
  });
});
