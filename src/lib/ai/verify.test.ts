import { describe, it, expect } from "vitest";
import { verifyFigures, figureMatches, describeIssues } from "./verify";
import type { AllowedFigure } from "./brief";

/**
 * The check that stands between a language model and a client's inbox.
 *
 * Tested harder than anything else in this feature, because it is the only
 * mechanism here that does not depend on a prompt being obeyed.
 */

const ALLOWED: AllowedFigure[] = [
  { value: 2847.32, kind: "money", label: "Ad spend" },
  { value: 61.9, kind: "money", label: "Cost per lead" },
  { value: 46, kind: "count", label: "Leads" },
  { value: 12, kind: "count", label: "Appointments" },
  { value: 26.1, kind: "percent", label: "Booking rate" },
  { value: 40, kind: "percent", label: "Show rate" },
  { value: 3.4, kind: "multiple", label: "Return on ad spend" },
];

const flagged = (text: string) =>
  verifyFigures(text, ALLOWED).issues.map((i) => i.token);

/* ------------------------------------------------------------------ *
 * The failure it exists to catch
 * ------------------------------------------------------------------ */

describe("catches invented figures", () => {
  it("🔴 flags a plausible number that appears nowhere in the data", () => {
    /*
     * The exact shape of the failure: fluent, specific, confident, wrong. The
     * real cost per lead is $61.90.
     */
    const draft = "Cost per lead improved to $38.40 this week, a strong result.";
    expect(flagged(draft)).toEqual(["$38.40"]);
  });

  it("names the closest figure we do hold, so a typo reads as a typo", () => {
    const r = verifyFigures("Spend was $2,487.32 across the period.", ALLOWED);
    expect(r.ok).toBe(false);
    expect(r.issues[0].nearest).toEqual({ value: 2847.32, label: "Ad spend" });
  });

  it("does not offer a nearest figure when nothing is remotely close", () => {
    // "$95,000" against a $2,847 account is not a transcription slip, and
    // presenting one as the likely intent would be misleading.
    const r = verifyFigures("The campaign generated $95,000 in pipeline.", ALLOWED);
    expect(r.issues[0].nearest).toBeNull();
  });

  it("flags every invented figure, not just the first", () => {
    const draft = "We saw 71 leads at $38.40 each, booking 19 appointments.";
    expect(flagged(draft)).toEqual(["71", "$38.40", "19"]);
  });
});

/* ------------------------------------------------------------------ *
 * Rule 1 — the marker narrows
 * ------------------------------------------------------------------ */

describe("currency and percent markers narrow what a token may match", () => {
  it("🔴 rejects a percentage that matches only a count", () => {
    /*
     * 12 is a real figure — the appointment count. Without the narrowing,
     * "conversion was 12%" passes for an account whose booking rate is 26.1%,
     * because the bare number exists somewhere in the data. This is the subtle
     * failure: every number is individually "in the data", and the sentence is
     * still false.
     */
    expect(flagged("Booking conversion sat at 12% for the period.")).toEqual(["12%"]);
  });

  it("rejects a money figure that matches only a percentage", () => {
    expect(flagged("We spent $40 per appointment.")).toEqual(["$40"]);
  });

  it("accepts a bare number against a figure of any kind", () => {
    // Prose legitimately writes "46 leads" and "spend was 2847".
    expect(verifyFigures("46 leads came in; spend was 2847.32.", ALLOWED).ok).toBe(true);
  });

  it("accepts each marker against its own kind", () => {
    const draft = "Spend $2,847.32, cost per lead $61.90, booking 26.1%, ROAS 3.4×.";
    expect(verifyFigures(draft, ALLOWED).ok).toBe(true);
  });

  it("treats a multiple written with 'x' the same as '×'", () => {
    expect(verifyFigures("Return on ad spend was 3.4x.", ALLOWED).ok).toBe(true);
    expect(flagged("Return on ad spend was 5.2x.")).toEqual(["5.2x"]);
  });
});

/* ------------------------------------------------------------------ *
 * Rule 2 — rounding yes, re-scaling no
 * ------------------------------------------------------------------ */

describe("rounding", () => {
  it("accepts a figure rounded the way a person reads it off a screen", () => {
    expect(verifyFigures("Spend reached $2,847.", ALLOWED).ok).toBe(true);
    expect(verifyFigures("Booking rate was 26%.", ALLOWED).ok).toBe(true);
    expect(verifyFigures("Cost per lead was $62.", ALLOWED).ok).toBe(true);
  });

  it("🔴 rejects a number rounded far enough to be wrong", () => {
    /*
     * "About $2,800" is $47 adrift. It reads well and it does not reconcile
     * against Ads Manager, which is where the conversation ends up.
     */
    expect(flagged("We spent about $2,800 this week.")).toEqual(["$2,800"]);
    expect(flagged("Cost per lead was roughly $65.")).toEqual(["$65"]);
  });

  it("holds the tolerance boundary exactly where it is documented", () => {
    // 0.5% of 2847.32 is $14.24 — inside passes, outside does not.
    expect(figureMatches(2847.32 + 14, 2847.32)).toBe(true);
    expect(figureMatches(2847.32 + 15, 2847.32)).toBe(false);
    expect(figureMatches(2900, 2847.32)).toBe(false);
    // Zero has no relative tolerance to give, so it is compared absolutely.
    expect(figureMatches(0, 0)).toBe(true);
    expect(figureMatches(1, 0)).toBe(false);
  });

  it("🔴 accepts integer rounding of a small figure, which tolerance alone cannot", () => {
    /*
     * The two acceptance rules cover different magnitudes and BOTH are needed.
     *
     * For a large figure the 0.5% tolerance does the work: $2,847.32 written as
     * $2,847 is 0.01% adrift. For a small one it cannot — rounding 3.4 to 3 is
     * 12% adrift, and 26.6% to 27% is 1.5%, both far outside the tolerance —
     * yet writing "27%" for 26.6% is simply how percentages are written.
     *
     * Every fixture above happens to have a small fractional part, so the
     * tolerance alone satisfied them and dropping the rounding rule changed
     * nothing. These are the cases where it is the only rule that applies.
     */
    const small: AllowedFigure[] = [
      { value: 3.4, kind: "multiple", label: "Return on ad spend" },
      { value: 26.6, kind: "percent", label: "Booking rate" },
    ];
    expect(figureMatches(27, 26.6)).toBe(true);
    expect(Math.abs(27 - 26.6) / 26.6).toBeGreaterThan(0.005); // tolerance says no
    expect(verifyFigures("Booking sat at 27% and ROAS at 3×.", small).ok).toBe(true);
    // Still bounded: rounding to the nearest ten is not rounding.
    expect(verifyFigures("Booking sat at 30%.", small).ok).toBe(false);
  });

  it("counts must be exact — one extra lead is a different fact", () => {
    expect(flagged("47 leads arrived.")).toEqual(["47"]);
    expect(verifyFigures("46 leads arrived.", ALLOWED).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Rule 3 — dates are not figures
 * ------------------------------------------------------------------ */

describe("dates and other non-figures", () => {
  it("🔴 ignores dates, which would otherwise flag every correct summary", () => {
    const draft =
      "Over Jul 14 – Aug 12, spend reached $2,847.32. The 10 Aug spike was the largest.";
    expect(verifyFigures(draft, ALLOWED).ok).toBe(true);
  });

  it("ignores years, ISO dates and clock times", () => {
    const draft =
      "Since 2026 the account has run steadily; the 2026-08-10 row and the 9:30 am call are both fine.";
    expect(verifyFigures(draft, ALLOWED).ok).toBe(true);
  });

  it("ignores markdown list numbering", () => {
    const draft = "1. Spend was $2,847.32\n2. Leads were 46\n3. Booking 26.1%";
    expect(verifyFigures(draft, ALLOWED).ok).toBe(true);
  });

  it("🔴 still checks a real figure that sits next to a date", () => {
    // Blanking must not swallow the number after it — that would be a hole
    // anything could be written through.
    const draft = "On Aug 10 spend hit $9,999.";
    expect(flagged(draft)).toEqual(["$9,999"]);
  });
});

/* ------------------------------------------------------------------ *
 * Shape of the result
 * ------------------------------------------------------------------ */

describe("result", () => {
  it("reports how many tokens it examined, so silence is distinguishable", () => {
    // A draft with no numbers at all is not "verified" in any useful sense, and
    // the caller needs to be able to tell.
    const none = verifyFigures("Performance held steady across the period.", ALLOWED);
    expect(none.ok).toBe(true);
    expect(none.checked).toBe(0);

    const some = verifyFigures("Spend was $2,847.32.", ALLOWED);
    expect(some.checked).toBe(1);
  });

  it("passes trivially when there is nothing to check against", () => {
    // An empty allow-list would otherwise flag every number in the draft, which
    // is technically correct and useless. The caller must not call it that way;
    // this pins the behaviour so it is at least predictable.
    const r = verifyFigures("Spend was $2,847.32.", []);
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
  });

  it("writes an operator-facing message, not a developer one", () => {
    const r = verifyFigures("Cost per lead was $38.40 and we saw 71 leads.", ALLOWED);
    const msg = describeIssues(r)!;
    expect(msg).toContain("$38.40");
    expect(msg).toContain("71");
    expect(msg).toContain("Check each before sending");
    expect(describeIssues(verifyFigures("All steady.", ALLOWED))).toBeNull();
  });

  it("truncates a long list rather than printing forty tokens", () => {
    const draft = [11, 13, 17, 19, 23, 29, 31].map((n) => `${n} things`).join(", ");
    const msg = describeIssues(verifyFigures(draft, ALLOWED))!;
    expect(msg).toContain("and 2 more");
  });
});
