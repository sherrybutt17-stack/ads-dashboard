import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessCandidates } from "@/lib/metrics/keepkill";
import { verifyFigures } from "./verify";

/**
 * The structural guarantee, tested structurally.
 *
 * The plan's rule for this feature is exact: *"the LLM writes prose only and its
 * schema has no verdict field; a validator rejects any number the engine didn't
 * produce."* Both halves are checkable without a model call, and both are worth
 * checking, because both are the kind of thing that gets loosened later by
 * somebody adding "just one field".
 */

const SRC = readFileSync(join(process.cwd(), "src/lib/ai/keepkill-prose.ts"), "utf8");

describe("the model's output schema", () => {
  it("🔴 has no verdict field, and no field but prose", () => {
    /*
     * Read off the source rather than inferred, because the guarantee is about
     * what CANNOT be expressed. Instructing a model not to change a verdict is
     * a request; giving it nowhere to put one is a property.
     */
    const schema = SRC.slice(SRC.indexOf("const ProseSchema"), SRC.indexOf("const SYSTEM"));
    const fields = [...schema.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

    expect(fields).toEqual(["text"]);

    /*
     * A second pass over the DECLARATION with the human-readable `.describe()`
     * strings stripped. Those are instructions to the model, not structure, and
     * scanning them produced a false positive on the word "recommendations" —
     * which is what this paragraph is legitimately about.
     *
     * The value it adds over the field list above is catching a nested object
     * or an unusual declaration style the line-anchored regex would miss.
     */
    const declaration = schema.replace(/\.describe\([\s\S]*?\)/g, "");
    for (const forbidden of ["verdict", "confidence", "pWorse", "score"]) {
      expect(declaration).not.toContain(forbidden);
    }
  });

  it("🔴 does not let the model see a channel for changing a decision", () => {
    // The verdicts go IN; nothing about them comes back out.
    expect(SRC).toMatch(/already been made|ALREADY BEEN MADE/i);
    expect(SRC).toMatch(/is final|not yours to change/i);
  });
});

/* ------------------------------------------------------------------ *
 * The allow-list, built from a real engine run
 * ------------------------------------------------------------------ */

describe("the figures the prose may use", () => {
  /*
   * `renderBrief` is private, so the allow-list is exercised the way it
   * matters: through the same `verifyFigures` the module calls, against an
   * allow-list assembled from a genuine `assessCandidates` result. Anything the
   * engine did not produce must be flagged.
   */
  const report = assessCandidates([
    { id: "a", name: "Alpha", spend: 2000, conversions: { new_lead: 20 } },
    { id: "b", name: "Beta", spend: 1000, conversions: { new_lead: 40 } },
  ]);

  const allowed = report.assessments.flatMap((a) => [
    { value: a.spend, kind: "money" as const, label: `${a.name} spend` },
    ...(a.costPer != null
      ? [{ value: a.costPer, kind: "money" as const, label: `${a.name} cost` }]
      : []),
    ...(a.benchmarkCostPer != null
      ? [{ value: a.benchmarkCostPer, kind: "money" as const, label: "benchmark" }]
      : []),
    { value: a.conversions, kind: "count" as const, label: `${a.name} leads` },
    {
      value: Math.round(a.pWorse * 100),
      kind: "percent" as const,
      label: `${a.name} confidence`,
    },
  ]);

  it("produces figures the engine actually computed", () => {
    const alpha = report.assessments.find((a) => a.id === "a")!;
    expect(alpha.costPer).toBeCloseTo(100, 5); // $2000 / 20
    expect(alpha.benchmarkCostPer).toBeCloseTo(25, 5); // $1000 / 40
  });

  it("accepts prose built only from them", () => {
    const text =
      "Alpha is costing $100.00 a lead against $25.00 for Beta, on $2,000 of spend.";
    expect(verifyFigures(text, allowed).ok).toBe(true);
  });

  it("🔴 flags a confidence the engine never produced", () => {
    // The most dangerous fabrication in this feature: a model rounding "83%
    // confident it is worse" up to "we're 95% sure", which reads as certainty
    // and is a different recommendation.
    const text = "We are 95% confident Alpha is the weaker campaign.";
    expect(verifyFigures(text, allowed).issues.map((i) => i.token)).toEqual(["95%"]);
  });

  it("🔴 flags an invented cost per lead", () => {
    const text = "Alpha is running at $140.00 a lead.";
    expect(verifyFigures(text, allowed).ok).toBe(false);
  });

  it("flags a projected saving, which is the tempting sentence to write", () => {
    // "Stopping Alpha would free up $1,500 a month" is exactly what a model
    // reaches for, and it is arithmetic nobody asked it to do.
    const text = "Stopping Alpha would free up $1,500 a month for Beta.";
    expect(verifyFigures(text, allowed).ok).toBe(false);
  });
});
