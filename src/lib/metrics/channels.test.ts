import { describe, it, expect } from "vitest";
import {
  buildChannelMix,
  assessTrust,
  assessCannibalisation,
  assessBaseline,
  type MonthChannel,
} from "./channels";

/**
 * The retainer question, and the ways answering it carelessly gets a working
 * campaign cancelled.
 *
 * The attribution-break fixtures are constructed, not transcribed — the live
 * accounts on this deployment currently match well. They model a failure this
 * codebase documents in two other places: Instant Form leads carry no UTMs at
 * all, and the ad URL parameters that populate a campaign id are a setup step
 * that can simply not have been applied. Either drops paid leads into the
 * "everything else" bucket, where they read as the rest of the pipeline surging
 * while paid collapses.
 */

let n = 0;
const month = (o: Partial<MonthChannel> = {}): MonthChannel => {
  const key = `2026-${String((n % 12) + 1).padStart(2, "0")}`;
  n++;
  return {
    month: key,
    label: key,
    spend: 1000,
    platformLeads: 10,
    paidLeads: 10,
    otherLeads: 5,
    paidAppointments: 0,
    otherAppointments: 0,
    paidWon: 0,
    otherWon: 0,
    ...o,
  };
};

/** Twelve months at a fixed key sequence, so ordering assertions are stable. */
const series = (specs: Partial<MonthChannel>[]): MonthChannel[] =>
  specs.map((s, i) => {
    const key = `2026-${String(i + 1).padStart(2, "0")}`;
    return { ...month({ ...s }), month: key, label: key };
  });

/* ------------------------------------------------------------------ *
 * 1 · Can the split be believed at all?
 * ------------------------------------------------------------------ */

describe("whether the split can be trusted", () => {
  it("🔴 calls it broken when the platform reports leads the CRM cannot find", () => {
    /*
     * A month where the ad URL parameters stopped populating: spend continues,
     * the platform still reports leads, and almost none of them can be matched
     * in the CRM. Read at face value the panel would report that the non-paid
     * pipeline tripled while paid collapsed, and the advice that follows is
     * "cancel the ads". The gap between the two counts is directly measurable
     * rather than inferred, which is what makes the guard possible at all.
     */
    const t = assessTrust([
      { ...month(), month: "2026-07", spend: 2151, platformLeads: 16, paidLeads: 12, otherLeads: 28 },
      { ...month(), month: "2026-08", spend: 1328, platformLeads: 7, paidLeads: 1, otherLeads: 32 },
    ]);
    expect(t.level).toBe("broken");
    expect(t.platformLeads).toBe(23);
    expect(t.matchedLeads).toBe(13);
  });

  it("🔴 grades on the latest month, not an average that buries it", () => {
    /*
     * The same two months, and the reason the aggregate alone is not enough:
     * July matched 12 of 16 and reads fine; August matched 1 of 7 and is
     * broken. Averaged they are 13 of 23 — 57%, merely "degraded" — which
     * understates a break that is distorting the numbers on screen right now.
     * A period average is where a single catastrophic month goes to hide.
     */
    const rows = [
      { ...month(), month: "2026-07", platformLeads: 16, paidLeads: 12 },
      { ...month(), month: "2026-08", platformLeads: 7, paidLeads: 1 },
    ];
    expect(assessTrust(rows).matchedLeads / assessTrust(rows).platformLeads).toBeGreaterThan(0.34);
    expect(assessTrust(rows).level).toBe("broken");

    // And the order rows arrive in must not change the verdict.
    expect(assessTrust([...rows].reverse()).level).toBe("broken");
  });

  it("🔴 keeps warning about a fixed break, because the totals still carry it", () => {
    /*
     * July matched 1 of 16 and August 19 of 20 — the pipe has been repaired.
     * The banner must NOT clear, because the totals on this panel cover the
     * whole window and July's leads are still misfiled inside them. Recency can
     * only escalate the verdict, never absolve it; the named month tells the
     * reader the damage is historical rather than live.
     */
    const t = assessTrust([
      { ...month(), month: "2026-07", platformLeads: 16, paidLeads: 1 },
      { ...month(), month: "2026-08", platformLeads: 20, paidLeads: 19 },
    ]);
    expect(t.gapMonths).toEqual(["2026-07"]);
    expect(t.level).toBe("degraded");
  });

  it("names the months where the gap opened", () => {
    const t = assessTrust([
      month({ month: "2026-06", platformLeads: 10, paidLeads: 10 }),
      month({ month: "2026-07", platformLeads: 16, paidLeads: 2 }),
    ]);
    expect(t.gapMonths).toEqual(["2026-07"]);
  });

  it("tolerates the ordinary difference between two counting systems", () => {
    // Meta and the CRM count different things over different windows, so some
    // gap is normal. A panel that cried "broken" at a 10% difference would be
    // ignored by the time it mattered.
    const t = assessTrust([
      month({ platformLeads: 20, paidLeads: 18 }),
      month({ platformLeads: 20, paidLeads: 17 }),
    ]);
    expect(t.level).toBe("usable");
  });

  it("🔴 does not call it usable merely because nothing contradicted it", () => {
    /*
     * With no platform figures there is nothing to check against. Reporting
     * that as a pass is the reassuring-silence failure the whole product exists
     * to replace — the absence of a contradiction is not evidence.
     */
    const t = assessTrust([
      month({ spend: null, platformLeads: null, paidLeads: 0, otherLeads: 6 }),
      month({ spend: null, platformLeads: null, paidLeads: 0, otherLeads: 7 }),
    ]);
    expect(t.level).toBe("degraded");
    expect(t.platformLeads).toBe(0);
  });

  it("ignores a month too small for the ratio to mean anything", () => {
    // 0 of 2 is a bad ratio and no evidence at all.
    const t = assessTrust([
      month({ platformLeads: 2, paidLeads: 0 }),
      month({ platformLeads: 30, paidLeads: 29 }),
    ]);
    expect(t.gapMonths).toEqual([]);
    expect(t.level).toBe("usable");
  });
});

/* ------------------------------------------------------------------ *
 * 2 · Is paid displacing the rest of the pipeline?
 * ------------------------------------------------------------------ */

describe("cannibalisation", () => {
  it("🔴 refuses to reassure on too few months", () => {
    /*
     * A rank correlation over five points detects nothing. Printing "no sign of
     * cannibalisation" from it would be a guarantee manufactured out of
     * silence, which is worse than saying nothing.
     */
    const c = assessCannibalisation(series(Array(5).fill({})));
    expect(c.verdict).toBe("not_enough_months");
    expect(c.rho).toBeNull();
  });

  it("raises it when the rest of the pipeline shrinks as spend grows", () => {
    const c = assessCannibalisation(
      series(
        [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000].map((spend, i) => ({
          spend,
          otherLeads: 30 - i * 3,
        })),
      ),
    );
    expect(c.verdict).toBe("possible");
    expect(c.rho).toBeLessThan(0);
    expect(c.p!).toBeLessThan(0.1);
  });

  it("stays quiet when the rest of the pipeline holds up", () => {
    const c = assessCannibalisation(
      series(
        [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000].map((spend, i) => ({
          spend,
          otherLeads: 20 + (i % 3),
        })),
      ),
    );
    expect(c.verdict).toBe("no_sign");
  });

  it("🔴 does not raise it on a downward drift that could be noise", () => {
    /*
     * The rank correlation here is about −0.4 over eight months, which is
     * p ≈ 0.3 — a shape you would see roughly one time in three from a pipeline
     * that is doing nothing at all. Reported as cannibalisation it would have
     * an agency defending itself against a coincidence, and it is the single
     * easiest way to make this panel untrustworthy.
     */
    const c = assessCannibalisation(
      series(
        [200, 400, 600, 800, 1000, 1200, 1400, 1600].map((spend, i) => ({
          spend,
          otherLeads: [20, 25, 18, 22, 16, 24, 15, 19][i],
        })),
      ),
    );
    expect(c.rho!).toBeLessThan(0);
    expect(c.rho!).toBeGreaterThan(-0.62);
    expect(c.p!).toBeGreaterThan(0.1);
    expect(c.verdict).toBe("no_sign");
  });

  it("🔴 does not raise it on a POSITIVE correlation", () => {
    // Non-paid leads rising alongside spend is the opposite of cannibalisation.
    // A two-sided test read carelessly would flag it as significant.
    const c = assessCannibalisation(
      series(
        [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000].map((spend, i) => ({
          spend,
          otherLeads: 5 + i * 3,
        })),
      ),
    );
    expect(c.rho!).toBeGreaterThan(0);
    expect(c.verdict).toBe("no_sign");
  });

  it("says so when spend never varied", () => {
    // No variation to correlate against — a different statement from "no
    // relationship", and one the operator can act on by testing a budget.
    const c = assessCannibalisation(
      series(Array.from({ length: 10 }, (_, i) => ({ spend: 1000, otherLeads: i }))),
    );
    expect(c.verdict).toBe("not_measurable");
  });

  it("only counts months that have ad data", () => {
    const c = assessCannibalisation(
      series([
        ...Array(6).fill({ spend: null, platformLeads: null }),
        ...Array(4).fill({ spend: 900 }),
      ]),
    );
    expect(c.months).toBe(4);
    expect(c.verdict).toBe("not_enough_months");
  });
});

/* ------------------------------------------------------------------ *
 * 3 · What the pipeline looked like before
 * ------------------------------------------------------------------ */

describe("the pre-advertising baseline", () => {
  it("compares the months before any ad data against the ones after", () => {
    const b = assessBaseline(
      series([
        ...[7, 4, 7, 6, 6].map(() => ({ spend: null, platformLeads: null, paidLeads: 0, otherLeads: 6 })),
        ...Array(4).fill({ spend: 1400, paidLeads: 12, otherLeads: 4 }),
      ]),
    )!;
    expect(b.months).toBe(5);
    expect(b.medianLeads).toBe(6);
    expect(b.medianSince).toBe(16);
  });

  it("🔴 needs several quiet months, not one", () => {
    // Two months is a quiet fortnight, and "your pipeline used to be smaller"
    // drawn from it is a sales line rather than a measurement.
    expect(
      assessBaseline(
        series([
          ...Array(2).fill({ spend: null, platformLeads: null, paidLeads: 0, otherLeads: 6 }),
          ...Array(6).fill({ spend: 1000 }),
        ]),
      ),
    ).toBeNull();
  });

  it("says nothing when ad data covers the whole history", () => {
    expect(assessBaseline(series(Array(8).fill({})))).toBeNull();
  });

  it("says nothing when there is no ad data at all", () => {
    // Every month is "before", and there is no "after" to compare it to.
    expect(
      assessBaseline(series(Array(8).fill({ spend: null, platformLeads: null }))),
    ).toBeNull();
  });

  it("🔴 keys off ad DATA, not spend of zero", () => {
    /*
     * A month with a recorded spend of £0 is a month the account was connected
     * and paused. A month with no row at all is a month we know nothing about.
     * Treating them alike would silently move the "before" boundary.
     */
    const b = assessBaseline(
      series([
        ...Array(3).fill({ spend: null, platformLeads: null, paidLeads: 0, otherLeads: 5 }),
        { spend: 0, platformLeads: 0, paidLeads: 0, otherLeads: 5 },
        ...Array(4).fill({ spend: 1000, paidLeads: 10, otherLeads: 5 }),
      ]),
    )!;
    expect(b.months).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * Totals
 * ------------------------------------------------------------------ */

describe("the two sides", () => {
  const mix = buildChannelMix(
    series([
      { spend: 1000, paidLeads: 40, otherLeads: 10, paidAppointments: 8, otherAppointments: 5, paidWon: 2, otherWon: 3 },
      { spend: 1000, paidLeads: 40, otherLeads: 10, paidAppointments: 8, otherAppointments: 5, paidWon: 2, otherWon: 2 },
    ]),
  );

  it("keeps the sides completely separate", () => {
    expect(mix.paid.leads).toBe(80);
    expect(mix.other.leads).toBe(20);
    expect(mix.paid.won).toBe(4);
    expect(mix.other.won).toBe(5);
  });

  it("🔴 shows the rest of the pipeline converting better, which is expected", () => {
    /*
     * Referrals and repeat customers are the warmest leads a business gets, so
     * this is the normal result and NOT evidence about the advertising. The
     * number is computed and shown; the panel's job is to refuse to read it as
     * a verdict.
     */
    expect(mix.paid.bookRate).toBeCloseTo(16 / 80, 6);
    expect(mix.other.bookRate).toBeCloseTo(10 / 20, 6);
    expect(mix.other.bookRate!).toBeGreaterThan(mix.paid.bookRate!);
  });

  it("closes against appointments, the denominator the funnel uses", () => {
    // Two close rates on one dashboard is how a client stops believing either.
    expect(mix.paid.closeRate).toBeCloseTo(4 / 16, 6);
  });

  it("costs the paid side only", () => {
    expect(mix.spend).toBe(2000);
    expect(mix.costPerPaidLead).toBeCloseTo(25, 6);
  });

  it("returns null rates rather than zero where there is nothing to divide", () => {
    const empty = buildChannelMix(series([{ paidLeads: 0, otherLeads: 0, spend: null, platformLeads: null }]));
    expect(empty.paid.bookRate).toBeNull();
    expect(empty.other.closeRate).toBeNull();
    expect(empty.costPerPaidLead).toBeNull();
  });

  it("🔴 never reports free leads when spend is zero but leads exist", () => {
    const m = buildChannelMix(series([{ spend: 0, paidLeads: 12 }]));
    expect(m.costPerPaidLead).toBeNull();
  });

  it("lists months newest first", () => {
    expect(mix.rows.map((r) => r.month)).toEqual(["2026-02", "2026-01"]);
  });
});
