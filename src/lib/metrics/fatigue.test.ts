import { describe, it, expect } from "vitest";
import {
  assessFatigue,
  robustDispersion,
  humanChange,
  humanMarketChange,
  RECENT_DAYS,
  MIN_BASELINE_DAYS,
  type CreativeDay,
  type CreativeFatigue,
  type FatigueInput,
  type SignalFinding,
} from "./fatigue";

/**
 * The tests are about what this engine REFUSES to say.
 *
 * Firing on a genuine collapse is the easy half and one assertion covers it.
 * The hard half — and the reason a threshold rule would be worse than nothing
 * here — is everything below: not calling the market's move the creative's
 * fault, not calling an erratic creative's ordinary week a decline, not calling
 * a rising CPM fatigue, and not inventing a frequency figure Meta's daily rows
 * cannot support.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const key = (i: number) =>
  new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10);

const day = (i: number, o: Partial<CreativeDay> = {}): CreativeDay => ({
  dateKey: key(i),
  impressions: 3000,
  linkClicks: 45, // 1.50% CTR
  video3sViews: 900,
  spend: 30, // $10.00 CPM
  leads: 3,
  reach: 2500,
  adCount: 1,
  ...o,
});

/** `n` identical days starting at index `from`. */
const run = (from: number, n: number, o: Partial<CreativeDay> = {}) =>
  Array.from({ length: n }, (_, i) => day(from + i, o));

const creative = (days: CreativeDay[], o: Partial<FatigueInput> = {}): FatigueInput => ({
  creativeKey: "a",
  name: "Video A",
  type: "image",
  active: true,
  learning: false,
  thumbnailUrl: null,
  days,
  ...o,
});

/** 22 ordinary days, then 7 at whatever the test is about. */
const withTail = (tail: Partial<CreativeDay>, baseline: Partial<CreativeDay> = {}) => [
  ...run(0, 22, baseline),
  ...run(22, 7, tail),
];

const only = (report: ReturnType<typeof assessFatigue>): CreativeFatigue => {
  expect(report.findings).toHaveLength(1);
  return report.findings[0];
};

const signal = (f: CreativeFatigue, id: string): SignalFinding => {
  const s = f.signals.find((x) => x.id === id);
  expect(s, `expected a ${id} signal, got ${f.signals.map((x) => x.id).join(",")}`).toBeTruthy();
  return s!;
};

/* ------------------------------------------------------------------ *
 * What it fires on
 * ------------------------------------------------------------------ */

describe("a creative that stopped working", () => {
  it("reports the decline, with the two rates it is between", () => {
    const f = only(assessFatigue([creative(withTail({ linkClicks: 27 }))]));
    const ctr = signal(f, "ctr");

    expect(ctr.baseline).toBeCloseTo(0.015, 6);
    expect(ctr.recent).toBeCloseTo(0.009, 6);
    expect(ctr.change).toBeCloseTo(-0.4, 6);
    expect(ctr.confidence).toBeGreaterThan(0.99);
    expect(f.recentDays).toBe(RECENT_DAYS);
    expect(f.baselineDays).toBe(22);
  });

  it("says nothing about a creative holding steady", () => {
    const report = assessFatigue([creative(withTail({}))]);
    expect(report.findings).toEqual([]);
    expect(report.judged).toBe(1);
  });

  it("🔴 ignores a decline too small to be worth a reshoot", () => {
    // −15% in the rate, under the 20% floor. Statistically flawless, and not a
    // reason to spend a day filming.
    const report = assessFatigue([creative(withTail({ linkClicks: 38 }))]);
    expect(report.findings).toEqual([]);
  });

  it("🔴 draws the line at the effect-size floor, not near it", () => {
    // 45 → 36 is exactly −20%: at the floor, excluded by `>`.
    expect(assessFatigue([creative(withTail({ linkClicks: 36 }))]).findings).toEqual([]);
    // 45 → 35 is −22.2%: over it.
    expect(assessFatigue([creative(withTail({ linkClicks: 35 }))]).findings).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Noise discipline — the whole reason this is not a threshold
 * ------------------------------------------------------------------ */

describe("how much movement counts as movement", () => {
  /*
   * Two creatives, the SAME −26.7% decline. One has delivered like clockwork;
   * the other swings between 0.83% and 2.17% CTR day to day. A binomial test
   * cannot tell them apart — 63,000 impressions is 63,000 impressions — and
   * would call both a certainty. The second one's ordinary week routinely
   * contains a move that size.
   */
  const erratic = Array.from({ length: 22 }, (_, i) =>
    day(i, { linkClicks: i % 2 ? 65 : 25 }),
  );

  it("fires on a steady creative", () => {
    const f = only(assessFatigue([creative(withTail({ linkClicks: 33 }))]));
    expect(signal(f, "ctr").dispersion).toBe(1);
  });

  it("🔴 stays quiet on an erratic one that moved exactly as far", () => {
    const report = assessFatigue([creative([...erratic, ...run(22, 7, { linkClicks: 33 })])]);
    expect(report.findings).toEqual([]);
    expect(report.judged).toBe(1); // tested, not skipped
  });

  it("is not simply mute — the erratic creative fires on a bigger move", () => {
    const f = only(
      assessFatigue([creative([...erratic, ...run(22, 7, { linkClicks: 22 })])]),
    );
    const ctr = signal(f, "ctr");
    expect(ctr.dispersion).toBeGreaterThan(15);
    expect(ctr.confidence).toBeGreaterThan(0.9);
  });

  it("🔴 never claims MORE certainty than counting noise allows", () => {
    // Real delivery is never less variable than a coin flip. A factor below 1
    // would tighten the posteriors past what the data supports — the one
    // direction of error that costs somebody a working creative.
    // Dead on the expectation: residuals of zero.
    expect(robustDispersion([{ k: 45, n: 3000 }, { k: 45, n: 3000 }, { k: 45, n: 3000 }], 0.015)).toBe(1);
    // Genuinely UNDER-dispersed — steadier than chance would allow. The raw
    // estimate here is 0.049, and returning it would shrink every posterior.
    expect(robustDispersion([{ k: 44, n: 3000 }, { k: 45, n: 3000 }, { k: 46, n: 3000 }], 0.015)).toBe(1);
  });

  it("recovers the dispersion of a known over-dispersed series", () => {
    // Residual ±15 on an expectation of 45 → each squared Pearson residual is
    // 225/45 = 5, and 5 / median(χ²₁) = 10.99.
    const days = Array.from({ length: 9 }, (_, i) => ({ k: i % 2 ? 60 : 30, n: 3000 }));
    expect(robustDispersion(days, 0.015)).toBeCloseTo(5 / 0.4549364, 3);
  });

  it("assumes counting noise below three days rather than guessing", () => {
    expect(robustDispersion([{ k: 90, n: 3000 }, { k: 0, n: 3000 }], 0.015)).toBe(1);
  });

  it("🔴 treats the baseline as an estimate too, not a known quantity", () => {
    /*
     * Seven erratic baseline days against seven steady recent ones, a −36% move.
     * Widening only the recent posterior — leaving the baseline at its raw
     * counting precision — reads 0.946 and reports it. Widening both, which is
     * what an over-dispersed process actually implies, reads 0.891 and does not.
     *
     * The asymmetry only bites on a SHORT baseline: with twenty-odd days the
     * baseline is tight enough that its own uncertainty is a rounding error, so
     * a fixture built on a long history would pass either way and prove nothing.
     */
    const erraticShort = Array.from({ length: 7 }, (_, i) =>
      day(i, { linkClicks: i % 2 ? 65 : 25 }),
    );
    const report = assessFatigue([
      creative([...erraticShort, ...run(7, 7, { linkClicks: 27 })]),
    ]);
    expect(report.judged).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it("still fires on the same short erratic baseline when the fall is bigger", () => {
    const erraticShort = Array.from({ length: 7 }, (_, i) =>
      day(i, { linkClicks: i % 2 ? 65 : 25 }),
    );
    const f = only(
      assessFatigue([creative([...erraticShort, ...run(7, 7, { linkClicks: 18 })])]),
    );
    expect(signal(f, "ctr").confidence).toBeGreaterThan(0.9);
  });

  it("🔴 measures dispersion on the baseline alone", () => {
    /*
     * The recent window is a genuine collapse AND wildly erratic. Pooling the
     * two windows would let that collapse enlarge the yardstick it is being
     * measured against, and the creative would talk its way out of its own
     * finding — the self-masking that rules out mean-and-stddev in anomaly.ts.
     *
     * A short baseline is used deliberately: with 22 steady days against 7 wild
     * ones the median is a baseline value either way and the two are
     * indistinguishable. At 7 against 7 the pooled median straddles the groups.
     */
    const steadyShort = run(0, 7);
    const wildRecent = [
      day(7, { linkClicks: 2 }),
      day(8, { linkClicks: 64 }),
      day(9, { linkClicks: 2 }),
      day(10, { linkClicks: 64 }),
      day(11, { linkClicks: 2 }),
      day(12, { linkClicks: 64 }),
      day(13, { linkClicks: 33 }),
    ];
    const f = only(assessFatigue([creative([...steadyShort, ...wildRecent])]));
    expect(signal(f, "ctr").dispersion).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * The market
 * ------------------------------------------------------------------ */

describe("what the rest of the account was doing", () => {
  const other = (days: CreativeDay[]) =>
    creative(days, { creativeKey: "b", name: "Video B" });

  it("🔴 does not blame the creative for a decline the whole account had", () => {
    // Both halved. Nothing here is about either creative.
    const report = assessFatigue([
      creative(withTail({ linkClicks: 27 })),
      other(withTail({ linkClicks: 27 })),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.judged).toBe(2);
  });

  it("fires when one creative fell and its neighbours did not", () => {
    const report = assessFatigue([
      creative(withTail({ linkClicks: 27 })),
      other(withTail({})),
    ]);
    const f = only(report);
    expect(f.creativeKey).toBe("a");
    expect(signal(f, "ctr").market).toBeCloseTo(0, 6);
  });

  it("counts a market moving the OTHER way against the creative", () => {
    // Everyone else improved 20%; this one fell 27%. The gap is the finding.
    const report = assessFatigue([
      creative(withTail({ linkClicks: 33 })),
      other(withTail({ linkClicks: 54 })),
    ]);
    const ctr = signal(only(report), "ctr");
    expect(ctr.market).toBeCloseTo(0.2, 6);
    expect(ctr.excess).toBeCloseTo(-0.4667, 3);
    expect(ctr.excess).toBeLessThan(ctr.change);
  });

  it("🔴 leaves the creative out of its own benchmark", () => {
    /*
     * The lesson keep/kill learned: a creative carrying nearly all the spend,
     * compared against an average it dominates, is compared against itself and
     * can never look bad. Here `a` is 10× `b`, so a naive account-wide average
     * would move almost exactly with `a` and cancel its own decline.
     */
    const big = creative([
      ...run(0, 22, { impressions: 30000, linkClicks: 450, spend: 300 }),
      ...run(22, 7, { impressions: 30000, linkClicks: 270, spend: 300 }),
    ]);
    const small = other(withTail({}));
    const ctr = signal(only(assessFatigue([big, small])), "ctr");
    expect(ctr.market).toBeCloseTo(0, 6);
    expect(ctr.excess).toBeCloseTo(-0.4, 6);
  });

  it("🔴 records the absence of a comparison, rather than assuming a flat market", () => {
    /*
     * `null`, not `0`. Zero would claim "the rest of the account was flat over
     * the same days", which is a statement about data nobody has, and the panel
     * would print it beside every signal as though it were a measurement.
     */
    const f = only(assessFatigue([creative(withTail({ linkClicks: 27 }))]));
    expect(signal(f, "ctr").market).toBeNull();
  });

  it("🔴 does not manufacture a finding out of a booming market", () => {
    /*
     * The mirror image of the seasonality problem, and the one that is easy to
     * miss because the market adjustment is usually what SUPPRESSES findings.
     *
     * This creative slipped 9% — nothing, on a real account — while everything
     * around it rose 50%. Its market-adjusted excess is −59%, comfortably past
     * the floor, and the decline itself clears 90% confidence on 66,000
     * impressions. So an engine that only checks the excess reports a fatigued
     * creative, and the card has to print "CTR fell 9%" under the heading.
     *
     * Nobody reshoots over nine percent. Being outrun by the rest of the
     * account is a real observation and it is keep/kill's question.
     */
    const boomed = other([...run(0, 22, { impressions: 100_000, linkClicks: 1500, spend: 1000 }), ...run(22, 7, { impressions: 100_000, linkClicks: 2250, spend: 1000 })]);
    const report = assessFatigue([creative(withTail({ linkClicks: 41 })), boomed]);
    expect(report.findings).toEqual([]);
    expect(report.judged).toBe(2);
  });

  it("ignores a neighbour too small to be a benchmark", () => {
    // 40 impressions a day is under the 2,000-per-window floor; a rate computed
    // from it would be noise dressed as a market reference.
    const tiny = other([...run(0, 22, { impressions: 40, linkClicks: 4, spend: 1 }), ...run(22, 7, { impressions: 40, linkClicks: 4, spend: 1 })]);
    const ctr = signal(only(assessFatigue([creative(withTail({ linkClicks: 27 })), tiny])), "ctr");
    expect(ctr.market).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Classification — response vs cost
 * ------------------------------------------------------------------ */

describe("what counts as fatigue at all", () => {
  it("🔴 does not call a rising CPM fatigue when engagement held", () => {
    /*
     * Impressions bought per dollar fell 25% — CPM up a third — while CTR is
     * unchanged. That is the auction, or a budget change, or November. No new
     * creative fixes it, and calling it fatigue sends someone to a shoot.
     */
    const report = assessFatigue([
      creative([...run(0, 22), ...run(22, 7, { impressions: 2250, linkClicks: 34 })]),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.costOnly).toBe(1);
  });

  it("a response signal on its own is something to watch", () => {
    const f = only(assessFatigue([creative(withTail({ linkClicks: 27 }))]));
    expect(f.severity).toBe("watch");
    expect(f.signals.map((s) => s.id)).toEqual(["ctr"]);
  });

  it("a response signal confirmed by cost is something to act on", () => {
    // CTR down and CPM up together: the classic signature.
    const f = only(
      assessFatigue([
        creative([...run(0, 22), ...run(22, 7, { impressions: 2308, linkClicks: 26 })]),
      ]),
    );
    expect(f.severity).toBe("fatigued");
    expect(f.signals.map((s) => s.id).sort()).toEqual(["cpm", "ctr"]);
  });

  it("🔴 will not call anything still in learning settled", () => {
    // The collapse is real; the claim that recent delivery represents this
    // creative's steady state is not, and that is the difference between
    // "act now" and "keep an eye on it".
    const f = only(
      assessFatigue([
        creative([...run(0, 22), ...run(22, 7, { impressions: 2308, linkClicks: 26 })], {
          learning: true,
        }),
      ]),
    );
    expect(f.severity).toBe("watch");
    expect(f.learning).toBe(true);
  });

  it("orders a card's signals with the largest move first", () => {
    const f = only(
      assessFatigue([
        creative([...run(0, 22), ...run(22, 7, { impressions: 2308, linkClicks: 26 })]),
      ]),
    );
    const excesses = f.signals.map((s) => Math.abs(s.excess));
    expect(excesses).toEqual([...excesses].sort((a, b) => b - a));
  });
});

describe("hook rate", () => {
  const collapsed = [...run(0, 22), ...run(22, 7, { video3sViews: 450 })];

  it("is judged for a video", () => {
    const f = only(assessFatigue([creative(collapsed, { type: "video" })]));
    expect(signal(f, "hook").baseline).toBeCloseTo(0.3, 6);
    expect(signal(f, "hook").recent).toBeCloseTo(0.15, 6);
  });

  it("🔴 is not judged for an image, whatever the column says", () => {
    // An image has no hook rate. Grading one puts every image below every video
    // on a metric that does not apply to it.
    const report = assessFatigue([creative(collapsed, { type: "image" })]);
    expect(report.findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

describe("which days are compared", () => {
  it("🔴 counts delivery days, not calendar days", () => {
    /*
     * Thirteen days switched off are not thirteen days of evidence. A calendar
     * window would make this creative's recent performance mostly absence and
     * read the zeros as collapse.
     */
    const days = [
      ...run(0, 22),
      ...run(22, 13, { impressions: 0, linkClicks: 0, spend: 0, video3sViews: 0, leads: 0, reach: 0 }),
      ...run(35, 7, { linkClicks: 27 }),
    ];
    const f = only(assessFatigue([creative(days)]));
    expect(f.recentDays).toBe(7);
    expect(f.baselineDays).toBe(22);
    expect(signal(f, "ctr").recent).toBeCloseTo(0.009, 6);
  });

  it("says when the creative was off in between, because saturation resets", () => {
    const days = [
      ...run(0, 22),
      ...run(22, 13, { impressions: 0, linkClicks: 0, spend: 0, video3sViews: 0, leads: 0, reach: 0 }),
      ...run(35, 7, { linkClicks: 27 }),
    ];
    const f = only(assessFatigue([creative(days)]));
    expect(f.gapDays).toBe(13);
  });

  it("reports no gap for a creative that ran continuously", () => {
    const f = only(assessFatigue([creative(withTail({ linkClicks: 27 }))]));
    expect(f.gapDays).toBe(0);
  });

  it("reports the two date ranges it compared", () => {
    const f = only(assessFatigue([creative(withTail({ linkClicks: 27 }))]));
    expect(f.baselineRange).toEqual([key(0), key(21)]);
    expect(f.recentRange).toEqual([key(22), key(28)]);
  });
});

describe("what it declines to judge", () => {
  it("skips a creative nothing is running", () => {
    const report = assessFatigue([
      creative(withTail({ linkClicks: 27 }), { active: false }),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.skipped.inactive).toBe(1);
    expect(report.judged).toBe(0);
  });

  it("🔴 skips a creative without a 'before' yet", () => {
    const shortRun = RECENT_DAYS + MIN_BASELINE_DAYS - 1;
    const report = assessFatigue([
      creative([...run(0, shortRun - 7), ...run(shortRun - 7, 7, { linkClicks: 5 })]),
    ]);
    expect(report.skipped.tooNew).toBe(1);
    expect(report.findings).toEqual([]);

    // One more day of history and the same creative is judged.
    const enough = assessFatigue([
      creative([...run(0, shortRun + 1 - 7), ...run(shortRun + 1 - 7, 7, { linkClicks: 5 })]),
    ]);
    expect(enough.skipped.tooNew).toBe(0);
    expect(enough.judged).toBe(1);
  });

  it("🔴 will not judge a signal off a sliver of delivery", () => {
    /*
     * 980 impressions in the recent week, and clicks that went from two a day
     * to none. The posterior comparison is happy — it will call that a
     * near-certain collapse — but the dispersion factor the comparison is
     * calibrated on was estimated from days averaging two clicks, and at that
     * size it is a guess. The money is real ($140 in the week, past the spend
     * floor), so nothing else stops this.
     */
    const thin = [
      ...run(0, 22, { impressions: 140, linkClicks: 2, spend: 20, leads: 0, video3sViews: 0 }),
      ...run(22, 7, { impressions: 140, linkClicks: 0, spend: 20, leads: 0, video3sViews: 0 }),
    ];
    const report = assessFatigue([creative(thin)]);
    expect(report.judged).toBe(1); // not skipped as a creative — just not judged on CTR
    expect(report.findings).toEqual([]);
  });

  it("🔴 skips a creative with nothing at stake this week", () => {
    // The output of this engine is "make another one", which costs a day. $7 of
    // recent spend does not buy that decision however certain the arithmetic is.
    const report = assessFatigue([
      creative([...run(0, 22, { spend: 1 }), ...run(22, 7, { spend: 1, linkClicks: 27 })]),
    ]);
    expect(report.skipped.tooSmall).toBe(1);
    expect(report.judged).toBe(0);
    expect(report.findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Frequency
 * ------------------------------------------------------------------ */

describe("daily frequency", () => {
  it("is reported when the asset ran as a single ad", () => {
    const f = only(
      assessFatigue([
        creative([...run(0, 22), ...run(22, 7, { linkClicks: 27, reach: 1500 })]),
      ]),
    );
    expect(f.frequency.available).toBe(true);
    expect(f.frequency.baseline).toBeCloseTo(1.2, 6); // 3000 / 2500
    expect(f.frequency.recent).toBeCloseTo(2, 6); // 3000 / 1500
  });

  it("🔴 refuses to compute one when several ads carried the asset", () => {
    /*
     * Reach is deduplicated PEOPLE. Four ads running the same asset reach four
     * overlapping groups, and their sum is not the number of people who saw it
     * — it is larger. Dividing impressions by that sum understates frequency,
     * so the wrong answer here does not merely mislead, it hides saturation in
     * the direction that looks reassuring.
     */
    const f = only(
      assessFatigue([
        creative([
          ...run(0, 22, { adCount: 4 }),
          ...run(22, 7, { adCount: 4, linkClicks: 27 }),
        ]),
      ]),
    );
    expect(f.frequency.available).toBe(false);
    expect(f.frequency.baseline).toBeNull();
    expect(f.frequency.days).toBe(0);
  });

  it("🔴 always says why it is only a daily figure", () => {
    // The ≥3 rule of thumb everybody quotes is a 7-day figure. Printing a daily
    // number without that sentence invites the reader to apply the wrong rule.
    const f = only(assessFatigue([creative(withTail({ linkClicks: 27 }))]));
    expect(f.frequency.note).toContain("cannot be summed");
    expect(f.frequency.note).toContain("7-day");
  });

  it("needs three usable days on each side before it will quote a median", () => {
    const days = [
      ...run(0, 20, { adCount: 2 }),
      ...run(20, 2), // only two single-ad baseline days
      ...run(22, 7, { linkClicks: 27 }),
    ];
    const f = only(assessFatigue([creative(days)]));
    expect(f.frequency.available).toBe(false);
    expect(f.frequency.days).toBe(9); // counted, just not enough on one side
  });
});

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

describe("the numbers as the reader sees them", () => {
  it("🔴 quotes a rising CPM as rising", () => {
    /*
     * Internally every signal is a rate that FALLS on decay, so CPM is stored
     * as impressions-per-dollar. A −23.1% rate move is a +30% CPM, and printing
     * the first number beside a pair of dollar figures showing the second is
     * how a report loses an argument in a meeting.
     */
    const f = only(
      assessFatigue([
        creative([...run(0, 22), ...run(22, 7, { impressions: 2308, linkClicks: 26 })]),
      ]),
    );
    const cpm = signal(f, "cpm");
    expect(cpm.inverted).toBe(true);
    expect(cpm.baseline).toBeCloseTo(10, 2);
    expect(cpm.recent).toBeCloseTo(13, 2);
    expect(cpm.change).toBeLessThan(0);
    expect(humanChange(cpm)).toBeCloseTo(0.3, 2);
  });

  it("converts the market's move for an inverted metric too", () => {
    const f: SignalFinding = {
      id: "cpm",
      label: "CPM",
      baseline: 10,
      recent: 13,
      change: -0.2,
      market: -0.2,
      excess: 0,
      confidence: 0.95,
      dispersion: 1,
      kind: "money",
      inverted: true,
      response: false,
    };
    // A rate 20% lower is a cost 25% higher.
    expect(humanMarketChange(f)).toBeCloseTo(0.25, 6);
    expect(humanMarketChange({ ...f, market: null })).toBeNull();
    expect(humanMarketChange({ ...f, inverted: false })).toBeCloseTo(-0.2, 6);
  });

  it("quotes a falling CTR as falling", () => {
    const f = only(assessFatigue([creative(withTail({ linkClicks: 27 }))]));
    expect(humanChange(signal(f, "ctr"))).toBeCloseTo(-0.4, 6);
  });
});

describe("the order of the list", () => {
  const collapse = (k: string, spend: number) =>
    creative(
      [
        ...run(0, 22, { spend }),
        ...run(22, 7, { spend, linkClicks: 27 }),
      ],
      { creativeKey: k, name: k },
    );

  /*
   * A large, steady creative so the account-wide reference is roughly flat.
   * Without it the collapsing creatives ARE the market, every excess is zero
   * and nothing fires — which is the engine behaving correctly and would make
   * these two assertions vacuous.
   */
  const anchor = creative(
    [
      ...run(0, 22, { impressions: 100_000, linkClicks: 1500, spend: 1000 }),
      ...run(22, 7, { impressions: 100_000, linkClicks: 1500, spend: 1000 }),
    ],
    { creativeKey: "anchor", name: "Anchor" },
  );

  it("puts the most money at risk first", () => {
    const report = assessFatigue([
      collapse("small", 20),
      collapse("big", 400),
      collapse("mid", 90),
      anchor,
    ]);
    expect(report.findings.map((f) => f.creativeKey)).toEqual(["big", "mid", "small"]);
  });

  it("🔴 says how many findings it is not showing", () => {
    // A capped list that does not admit it was capped reads as "that is all of
    // them", which is the failure this whole product exists to replace.
    const many = Array.from({ length: 8 }, (_, i) => collapse(`c${i}`, 50 + i));
    const report = assessFatigue([...many, anchor]);
    expect(report.findings).toHaveLength(5);
    expect(report.hidden).toBe(3);
    expect(report.judged).toBe(9);
  });
});

/* ------------------------------------------------------------------ *
 * Degenerate input
 * ------------------------------------------------------------------ */

describe("input that would divide by zero", () => {
  it("returns an empty report for no creatives", () => {
    const report = assessFatigue([]);
    expect(report.findings).toEqual([]);
    expect(report.judged).toBe(0);
  });

  it("does not report a decline from a baseline of zero", () => {
    // No clicks ever, then no clicks. There is no percentage between them.
    const report = assessFatigue([
      creative([...run(0, 22, { linkClicks: 0 }), ...run(22, 7, { linkClicks: 0 })]),
    ]);
    expect(report.judged).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it("does not report an improvement as fatigue", () => {
    const report = assessFatigue([creative(withTail({ linkClicks: 90 }))]);
    expect(report.findings).toEqual([]);
  });

  it("survives a creative whose spend is zero throughout", () => {
    const report = assessFatigue([
      creative([...run(0, 22, { spend: 0 }), ...run(22, 7, { spend: 0, linkClicks: 27 })]),
    ]);
    expect(report.skipped.tooSmall).toBe(1);
    expect(report.findings).toEqual([]);
  });
});
