import { describe, it, expect } from "vitest";
import {
  detectAnomalies,
  median,
  mad,
  BASELINE_DAYS,
  type Anomaly,
} from "./anomaly";
import { EMPTY_FUNNEL, EMPTY_ADS, derive } from "./compute";
import type { DailyPoint } from "./queries";

/**
 * The behaviour worth protecting here is mostly what this DOESN'T fire on.
 *
 * An anomaly panel earns its place by being right often enough that people keep
 * reading it. Every false alarm is a withdrawal from that account, and the four
 * cheapest ways to produce one — a fixed daily budget, a small lead count,
 * today's half-finished row, and a failed nightly sync — are all things this
 * product's real clients do every day. Those get the most tests.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function key(dayIndex: number): string {
  // 2026-06-01 + n, kept inside one month so the arithmetic stays obvious.
  const d = new Date(Date.UTC(2026, 5, 1 + dayIndex));
  return d.toISOString().slice(0, 10);
}

function point(
  dayIndex: number,
  o: { spend?: number; leads?: number; appts?: number } = {},
): DailyPoint {
  const funnel = {
    ...EMPTY_FUNNEL,
    new_lead: o.leads ?? 0,
    appointment_booked: o.appts ?? 0,
  };
  const ads = { ...EMPTY_ADS, spend: o.spend ?? 0 };
  return { dateKey: key(dayIndex), funnel, ads, derived: derive(funnel, ads) };
}

/** `n` days of identical activity, then whatever `tail` describes. */
function series(
  n: number,
  base: { spend?: number; leads?: number; appts?: number },
  tail: Array<{ spend?: number; leads?: number; appts?: number }> = [],
): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (let i = 0; i < n; i++) out.push(point(i, base));
  tail.forEach((t, i) => out.push(point(n + i, t)));
  return out;
}

/** Test every day from the start; `today` is the day after the last row. */
function report(
  s: DailyPoint[],
  over: Partial<Parameters<typeof detectAnomalies>[0]> = {},
) {
  return detectAnomalies({
    series: s,
    testFrom: s[0].dateKey,
    testTo: s[s.length - 1].dateKey,
    todayKey: key(s.length),
    ...over,
  });
}

const run = (
  s: DailyPoint[],
  over: Partial<Parameters<typeof detectAnomalies>[0]> = {},
): Anomaly[] => report(s, over).findings;

const ids = (a: Anomaly[]) => a.map((x) => `${x.metric}:${x.direction}`);

/* ------------------------------------------------------------------ *
 * Robust statistics
 * ------------------------------------------------------------------ */

describe("median / MAD", () => {
  it("takes the middle of an odd sample and the mean of two for an even one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("is unmoved by an outlier that would drag a mean", () => {
    const ordinary = [10, 10, 11, 9, 10];
    const withSpike = [...ordinary, 1000];
    // The mean goes from 10 to ~175. The median barely moves.
    expect(median(ordinary)).toBe(10);
    expect(median(withSpike)).toBe(10);
  });

  it("MAD is the median distance from the centre, and is zero for a constant", () => {
    expect(mad([5, 5, 5, 5])).toBe(0);
    expect(mad([1, 2, 3, 4, 5])).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * The false alarms that would kill the feature
 * ------------------------------------------------------------------ */

describe("does not fire on ordinary operation", () => {
  it("🔴 a client on a fixed daily budget produces nothing", () => {
    /*
     * The single most likely false alarm in the product. A client on $80/day
     * spends $80 every day, so MAD is 0 and an unfloored modified z-score is
     * infinite for ANY variation at all — including the cent of rounding Meta
     * introduces. Without the floor this fires on every client every day.
     */
    const s = series(40, { spend: 80, leads: 6 });
    expect(run(s)).toEqual([]);

    // Even with a real, ordinary daily wobble on top of a flat budget.
    const wobbly = s.map((p, i) =>
      point(i, { spend: 80 + (i % 3) - 1, leads: 6 }),
    );
    expect(run(wobbly)).toEqual([]);
  });

  it("🔴 tolerates the ±20% delivery swing Meta produces at a steady budget", () => {
    // Real accounts oscillate around their budget without anything happening.
    const s = Array.from({ length: 40 }, (_, i) =>
      point(i, { spend: 100 + (i % 5) * 10 - 20, leads: 8 }),
    );
    expect(run(s).filter((a) => a.metric === "spend")).toEqual([]);
  });

  it("🔴 does not call 2 leads → 6 leads an anomaly", () => {
    /*
     * The lesson `insights.ts` already learned, in a different disguise. At a
     * baseline of 2 leads a day the count's own standard deviation is √2 ≈ 1.4,
     * so 6 is a bit over 2σ — unremarkable. But the MEDIAN of a 2-lead-a-day
     * client is often exactly 2 with a MAD of 0, so without the Poisson floor
     * this scores infinity and gets announced as news.
     */
    const s = series(30, { leads: 2 }, [{ leads: 6 }]);
    expect(run(s)).toEqual([]);
  });

  it("does not judge a client with too little history", () => {
    // Thirteen days of baseline, then a tenfold spike. Nothing to compare to.
    const s = series(13, { spend: 100, leads: 10 }, [{ spend: 1000, leads: 10 }]);
    expect(run(s)).toEqual([]);
  });

  it("🔴 never judges today, whose row is only as complete as the hours so far", () => {
    /*
     * Testing today would report "spend fell to $6" every morning, for every
     * client, forever — and a panel that is wrong every morning is one nobody
     * reads by Friday.
     */
    const s = series(30, { spend: 100, leads: 10 }, [{ spend: 4, leads: 0 }]);
    const last = s[s.length - 1].dateKey;

    // Judged as today → silent.
    expect(run(s, { todayKey: last })).toEqual([]);
    // The same row, once the day has closed → reported.
    expect(ids(run(s, { todayKey: key(s.length) }))).toContain("spend:below");
  });

  it("🔴 ignores a mathematically extreme move that is too small to matter", () => {
    /*
     * A $9/day account, dead flat, is a 0-MAD series: on the statistics alone
     * any change at all is infinitely unusual. The absolute floor is the only
     * thing standing between that client and a daily anomaly about five
     * dollars.
     */
    const s = series(30, { spend: 9, leads: 4 }, [{ spend: 14, leads: 4 }]);
    expect(run(s).filter((a) => a.metric === "spend")).toEqual([]);
  });

  it("🔴 holds the absolute floor exactly where it is documented", () => {
    /*
     * The floor is expressed as a scale (`minDeviation / THRESHOLD`) rather
     * than as a separate check, so it is worth pinning the boundary it claims:
     * on a flat baseline, a spend deviation below $50 can never be flagged and
     * one comfortably above it can. Written as a second `if` this guarantee was
     * unreachable dead code; written as a floor it is the only thing enforcing
     * it, and a regression here would be silent.
     */
    const flat = (delta: number) =>
      run(series(30, { spend: 5, leads: 4 }, [{ spend: 5 + delta, leads: 4 }])).filter(
        (a) => a.metric === "spend",
      );

    expect(flat(49)).toEqual([]);
    expect(flat(60)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * The things it exists to catch
 * ------------------------------------------------------------------ */

describe("catches real events", () => {
  it("flags a spend spike, naming the day, the value and the usual", () => {
    const s = series(30, { spend: 100, leads: 10 }, [{ spend: 600, leads: 12 }]);
    const found = run(s).filter((a) => a.metric === "spend");

    expect(found).toHaveLength(1);
    expect(found[0].direction).toBe("above");
    expect(found[0].value).toBe(600);
    expect(found[0].baseline).toBe(100);
    expect(found[0].days).toBe(1);
    expect(found[0].text).toContain("$600.00");
    expect(found[0].text).toContain("6.0×");
    expect(found[0].text).toContain("Jul 1"); // day 30 from 2026-06-01
  });

  it("flags spend collapsing to zero on a day we DO have a row for", () => {
    const s = series(30, { spend: 200, leads: 15 }, [{ spend: 0, leads: 15 }]);
    const found = run(s, { adDataDays: new Set(s.map((p) => p.dateKey)) });
    const spend = found.filter((a) => a.metric === "spend");

    expect(spend).toHaveLength(1);
    expect(spend[0].direction).toBe("below");
    expect(spend[0].text).toContain("fell to");
    // No gap finding — the row exists, it just says zero.
    expect(found.some((a) => a.kind === "gap")).toBe(false);
  });

  it("flags a lead collapse at a volume where it means something", () => {
    const s = series(30, { spend: 300, leads: 40 }, [{ spend: 300, leads: 4 }]);
    const found = run(s).filter((a) => a.metric === "new_lead");
    expect(found).toHaveLength(1);
    expect(found[0].direction).toBe("below");
    expect(found[0].tone).toBe("bad");
  });

  it("flags a lead surge at the same volume, with the opposite tone", () => {
    const s = series(30, { spend: 300, leads: 40 }, [{ spend: 300, leads: 90 }]);
    const found = run(s).filter((a) => a.metric === "new_lead");
    expect(found).toHaveLength(1);
    expect(found[0].tone).toBe("good");
  });
});

/* ------------------------------------------------------------------ *
 * Polarity — shared with the tiles, so the page cannot contradict itself
 * ------------------------------------------------------------------ */

describe("tone honours metric polarity", () => {
  it("a cost-per-lead spike is bad and a collapse is good", () => {
    const up = series(30, { spend: 200, leads: 20 }, [{ spend: 200, leads: 3 }]);
    const cpl = run(up).filter((a) => a.metric === "cpLead");
    expect(cpl).toHaveLength(1);
    expect(cpl[0].direction).toBe("above"); // $10 → $66
    expect(cpl[0].tone).toBe("bad");

    const down = series(30, { spend: 200, leads: 5 }, [{ spend: 200, leads: 40 }]);
    const cheaper = run(down).filter((a) => a.metric === "cpLead");
    expect(cheaper).toHaveLength(1);
    expect(cheaper[0].direction).toBe("below"); // $40 → $5
    expect(cheaper[0].tone).toBe("good");
  });

  it("🔴 still carries a tone when the baseline is zero", () => {
    /*
     * Found on live data. Tone was derived by running the relative change
     * through `changeSentiment`, which applies a ±5% dead band — right for a KPI
     * tile, wrong here. A baseline of 0 has no computable percentage, so the
     * fallback of 0 landed inside the dead band and every such finding rendered
     * as a grey shrug: "Leads reached 4 on Jul 8" with no indication that four
     * leads on a day this account usually records none is good news.
     */
    const s = series(30, { leads: 30, appts: 0 }, [{ leads: 30, appts: 9 }]);
    const [appts] = run(s).filter((a) => a.metric === "appointment_booked");
    expect(appts.baseline).toBe(0);
    expect(appts.tone).toBe("good");
  });

  it("a spend move is neutral in either direction", () => {
    // Spending more is not by itself good or bad, and colouring it would be a
    // judgement the number cannot support.
    const up = series(30, { spend: 100, leads: 10 }, [{ spend: 900, leads: 10 }]);
    const down = series(30, { spend: 400, leads: 10 }, [{ spend: 20, leads: 10 }]);
    expect(run(up).find((a) => a.metric === "spend")?.tone).toBe("neutral");
    expect(run(down).find((a) => a.metric === "spend")?.tone).toBe("neutral");
  });
});

/* ------------------------------------------------------------------ *
 * Window discipline
 * ------------------------------------------------------------------ */

describe("baseline window", () => {
  it("🔴 excludes the day under test from its own baseline", () => {
    /*
     * If the tested day is inside its own window it pulls the median toward
     * itself and inflates the scale it is judged by — self-masking, which is
     * the very thing median-and-MAD is chosen to prevent, reintroduced through
     * the window definition instead of the estimator.
     *
     * Detectable because a run of identical spikes must all be flagged: under a
     * self-including window the later ones dilute their own evidence.
     */
    const s = series(
      30,
      { spend: 100, leads: 10 },
      [{ spend: 700, leads: 10 }, { spend: 700, leads: 10 }],
    );
    const found = run(s).filter((a) => a.metric === "spend");
    expect(found).toHaveLength(1);
    expect(found[0].days).toBe(2); // both days flagged, then merged
  });

  it("uses days before the tested range as baseline without reporting them", () => {
    // The spike is on day 5 — inside the series, outside the tested range.
    const s = series(40, { spend: 100, leads: 10 });
    s[5] = point(5, { spend: 900, leads: 10 });

    const found = detectAnomalies({
      series: s,
      testFrom: key(30),
      testTo: key(39),
      todayKey: key(40),
    });
    expect(found.findings).toEqual([]);
  });

  it("🔴 reads the baseline from at most the trailing window", () => {
    /*
     * A level that changed a month ago is the new normal, not an anomaly. With
     * an unbounded baseline the old level stays in the median for as long as
     * there is more of it than of the new one, and a client who doubled their
     * budget gets told about it every day for two months.
     *
     * The bound gives a hard guarantee the unbounded version cannot: once half
     * the window sits at the new level the median moves there, so a sustained
     * change can never be flagged for more than BASELINE_DAYS / 2 days —
     * regardless of how much history precedes it. Here there are 40 prior days,
     * so an unbounded baseline would run for 40.
     */
    const before = 40;
    const s: DailyPoint[] = [];
    for (let i = 0; i < before; i++) s.push(point(i, { spend: 50, leads: 5 }));
    for (let i = before; i < before + BASELINE_DAYS + 10; i++) {
      s.push(point(i, { spend: 400, leads: 5 }));
    }
    const found = run(s).filter((a) => a.metric === "spend");

    expect(found).toHaveLength(1);
    expect(found[0].startKey).toBe(key(before));
    expect(found[0].days).toBeLessThanOrEqual(BASELINE_DAYS / 2);
  });
});

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

describe("consecutive days collapse into one finding", () => {
  it("reports a sustained level change once, described by its peak", () => {
    const s = series(
      30,
      { spend: 100, leads: 10 },
      [
        { spend: 500, leads: 10 },
        { spend: 800, leads: 10 },
        { spend: 500, leads: 10 },
      ],
    );
    const found = run(s).filter((a) => a.metric === "spend");

    expect(found).toHaveLength(1);
    expect(found[0].days).toBe(3);
    expect(found[0].value).toBe(800); // the peak, not the first or the last
    expect(found[0].startKey).toBe(key(30));
    expect(found[0].endKey).toBe(key(32));
    expect(found[0].text).toContain("for 3 days");
  });

  it("does not merge across an ordinary day in between", () => {
    const s = series(
      30,
      { spend: 100, leads: 10 },
      [{ spend: 700, leads: 10 }, { spend: 100, leads: 10 }, { spend: 700, leads: 10 }],
    );
    expect(run(s).filter((a) => a.metric === "spend")).toHaveLength(2);
  });

  it("🔴 does not merge two ADJACENT days that point opposite ways", () => {
    /*
     * A budget that blew out on Monday and was switched off on Tuesday is two
     * events with two different explanations. Merged, they become one finding
     * described by whichever day scored higher — and the other one, which is
     * the one that is still true today, disappears entirely.
     *
     * Adjacency alone is not the test: the run above breaks on a normal day in
     * between, so it passes whether or not direction is checked.
     */
    const s = series(
      30,
      { spend: 200, leads: 10 },
      [{ spend: 900, leads: 10 }, { spend: 0, leads: 10 }],
    );
    const found = run(s).filter((a) => a.metric === "spend");

    expect(found).toHaveLength(2);
    expect(found.map((a) => a.direction).sort()).toEqual(["above", "below"]);
    for (const a of found) expect(a.days).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Missing data ≠ zero
 * ------------------------------------------------------------------ */

describe("days with no ad row", () => {
  const withGap = () => {
    const s = series(40, { spend: 200, leads: 12 });
    // Days 31–33 have no ad row at all: `getDailySeries` emits zeroes for them.
    for (const i of [31, 32, 33]) s[i] = point(i, { spend: 0, leads: 12 });
    const adDataDays = new Set(
      s.map((p) => p.dateKey).filter((k) => ![31, 32, 33].map(key).includes(k)),
    );
    return { s, adDataDays };
  };

  it("🔴 reports a gap rather than a spend collapse", () => {
    const { s, adDataDays } = withGap();
    const found = run(s, { adDataDays });

    const gap = found.filter((a) => a.kind === "gap");
    expect(gap).toHaveLength(1);
    expect(gap[0].days).toBe(3);
    expect(gap[0].startKey).toBe(key(31));
    expect(gap[0].endKey).toBe(key(33));

    // And emphatically NOT a confident claim that spending stopped.
    expect(found.some((a) => a.metric === "spend")).toBe(false);
  });

  it("does not guess whether it was a pause or a failed sync", () => {
    const { s, adDataDays } = withGap();
    const [gap] = run(s, { adDataDays }).filter((a) => a.kind === "gap");
    expect(gap.text).toMatch(/paused/);
    expect(gap.text).toMatch(/sync/);
    expect(gap.text).toMatch(/health/);
    // It must say the surrounding figures are affected — that is the actionable
    // half, and the part a reader would otherwise not think to check.
    expect(gap.text).toMatch(/understated/);
  });

  it("produces no statistical finding for the gap days themselves", () => {
    const { s, adDataDays } = withGap();
    expect(run(s, { adDataDays }).filter((a) => a.kind === "outlier")).toEqual([]);
  });

  it("🔴 does not let a long gap become the new normal", () => {
    /*
     * The reason gap days are excluded from BASELINES, not merely from testing.
     *
     * Worth being precise about when it matters: a median is unmoved by up to
     * half its sample, so three zeroes in a 28-day window change nothing at all.
     * The exclusion bites once the gap passes half the window — a fortnight
     * paused, or a fortnight of failed syncs. Then the zeroes become the median,
     * "usual" reads $0, and the day the account comes back is announced as a
     * 14σ spike. Which lands, of course, exactly when someone is already dealing
     * with the real problem.
     *
     * Excluded, there simply aren't 14 real days left in the window to judge
     * against, so nothing is claimed — the honest answer, and a different one
     * from "your spending is normal".
     */
    const gapLen = 16;
    const s: DailyPoint[] = [];
    for (let i = 0; i < 30 + gapLen + 12; i++) {
      s.push(point(i, { spend: i >= 30 && i < 30 + gapLen ? 0 : 200, leads: 12 }));
    }
    const adDataDays = new Set(
      s.map((p) => p.dateKey).filter((_, i) => i < 30 || i >= 30 + gapLen),
    );

    const found = run(s, { adDataDays });
    expect(found.filter((a) => a.kind === "outlier")).toEqual([]);
    // The gap itself is still reported — silence about the metrics is not
    // silence about the hole.
    expect(found.filter((a) => a.kind === "gap")).toHaveLength(1);
  });

  it("does not call a client's start date a gap", () => {
    // No ad data for the first ten days because nothing was connected yet.
    const s = series(40, { spend: 200, leads: 12 });
    const adDataDays = new Set(s.slice(10).map((p) => p.dateKey));
    expect(run(s, { adDataDays }).filter((a) => a.kind === "gap")).toEqual([]);
  });

  it("reports a gap that runs up to today — the most urgent shape", () => {
    const s = series(40, { spend: 200, leads: 12 });
    const adDataDays = new Set(s.slice(0, 37).map((p) => p.dateKey));
    const [gap] = run(s, { adDataDays }).filter((a) => a.kind === "gap");
    expect(gap.days).toBe(3);
    expect(gap.endKey).toBe(key(39));
  });

  it("fabricates nothing when ad-data days are unknown", () => {
    // Omitting the set means "we cannot tell", which must not become "gap".
    const { s } = withGap();
    expect(run(s).some((a) => a.kind === "gap")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Ranking and volume
 * ------------------------------------------------------------------ */

describe("ranking", () => {
  it("puts a data gap above every statistical finding", () => {
    const s = series(40, { spend: 200, leads: 12 });
    s[35] = point(35, { spend: 4000, leads: 12 }); // a 20× spike
    for (const i of [31, 32]) s[i] = point(i, { spend: 0, leads: 12 });
    const adDataDays = new Set(
      s.map((p) => p.dateKey).filter((k) => ![31, 32].map(key).includes(k)),
    );

    const found = run(s, { adDataDays });
    expect(found[0].kind).toBe("gap");
    expect(found.some((a) => a.metric === "spend")).toBe(true);
  });

  it("caps the list rather than burying the reader", () => {
    const s = series(30, { spend: 200, leads: 20 });
    for (let i = 30; i < 40; i++) {
      // Alternating extremes on separate days, across several metrics.
      s.push(point(i, i % 2 ? { spend: 4000, leads: 90 } : { spend: 200, leads: 20 }));
    }
    const found = run(s);
    expect(found.length).toBeLessThanOrEqual(4);
    expect(found.length).toBeGreaterThan(0);
  });

  it("returns nothing for an empty series", () => {
    expect(
      detectAnomalies({
        series: [],
        testFrom: key(0),
        testTo: key(1),
        todayKey: key(2),
      }),
    ).toEqual({ findings: [], judgedDays: 0, testedDays: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * "Nothing unusual" and "we cannot tell" are different answers
 * ------------------------------------------------------------------ */

describe("coverage", () => {
  it("🔴 reports zero judged days for a client with too little history", () => {
    /*
     * Both cases return an empty findings list, and the panel must not render
     * the same sentence for them. Telling a two-week-old client that nothing
     * unusual happened is a reassurance we have no basis for — the same shape
     * of quiet, confident emptiness as a spreadsheet reporting SHOWN = 0
     * forever.
     */
    const young = report(series(10, { spend: 100, leads: 8 }));
    expect(young.findings).toEqual([]);
    expect(young.judgedDays).toBe(0);
    expect(young.testedDays).toBe(10);

    const established = report(series(40, { spend: 100, leads: 8 }));
    expect(established.findings).toEqual([]);
    expect(established.judgedDays).toBeGreaterThan(20);
  });

  it("counts finished days only", () => {
    const s = series(40, { spend: 100, leads: 8 });
    // Judged as though the last three rows are today and the future.
    const r = report(s, { todayKey: key(37) });
    expect(r.testedDays).toBe(37);
  });
});

/* ------------------------------------------------------------------ *
 * Phrasing
 * ------------------------------------------------------------------ */

describe("phrasing", () => {
  it("🔴 uses words, not a figure, when the baseline is zero", () => {
    /*
     * 0 → 12 appointments cannot be "infinity times the usual", and the earlier
     * fallback of "— usually 0" was true, unreadable, and looked like a bug the
     * first time it appeared on a live account.
     */
    const s = series(30, { leads: 30, appts: 0 }, [{ leads: 30, appts: 12 }]);
    const found = run(s).filter((a) => a.metric === "appointment_booked");
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain("normally records none");
    expect(found[0].text).not.toMatch(/×/);
    expect(found[0].text).not.toMatch(/usually 0|Infinity|NaN/);
  });

  it("formats money as money and counts as counts", () => {
    const s = series(30, { spend: 100, leads: 10 }, [{ spend: 900, leads: 60 }]);
    const found = run(s);
    const spend = found.find((a) => a.metric === "spend")!;
    const leads = found.find((a) => a.metric === "new_lead")!;
    expect(spend.text).toContain("$900.00");
    expect(leads.text).toContain("60");
    expect(leads.text).not.toContain("$");
  });

  it("honours a non-USD currency", () => {
    const s = series(30, { spend: 100, leads: 10 }, [{ spend: 900, leads: 10 }]);
    const [spend] = run(s, { currency: "GBP" }).filter((a) => a.metric === "spend");
    expect(spend.text).toContain("£");
  });

  it("never emits a non-finite score", () => {
    const s = series(30, { spend: 0, leads: 0 }, [{ spend: 0, leads: 0 }]);
    for (const a of run(s)) expect(Number.isFinite(a.score)).toBe(true);
  });
});
