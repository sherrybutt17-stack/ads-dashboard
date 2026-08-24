import { describe, it, expect } from "vitest";
import { assessCandidates, type Candidate, type Verdict } from "./keepkill";
import { probRateBelow } from "./stats";

/**
 * The engine that tells an agency to switch off a campaign.
 *
 * The tests that matter most are the ones asserting it stays QUIET. A
 * recommendation engine that fires on three conversions is worse than no
 * engine: it launders sampling noise into a decision, and the money it moves is
 * real.
 */

const c = (
  id: string,
  spend: number,
  leads: number,
  over: Partial<Candidate> = {},
): Candidate => ({ id, name: id, spend, conversions: { new_lead: leads }, ...over });

const verdictOf = (r: ReturnType<typeof assessCandidates>, id: string): Verdict =>
  r.assessments.find((a) => a.id === id)!.verdict;

/** Enough other campaigns to make a benchmark, at a steady $25 per lead. */
const bench = (leads = 20) => [c("bench", leads * 25, leads)];

/* ------------------------------------------------------------------ *
 * The worked example from the plan
 * ------------------------------------------------------------------ */

describe("the small-sample case this exists for", () => {
  it("🔴 pins the plan's worked example at the statistic", () => {
    /*
     * 3 leads on $90 against 5 leads on $110 — $30 per lead versus $22.
     *
     * The plan quoted `pWorse ≈ 0.28`. This formulation gives 0.66: a
     * leave-one-out benchmark, a Jeffreys prior, and BOTH sides treated as
     * uncertain, since the rest of the account is also a finite sample. The
     * figure is pinned here so it is inspectable rather than asserted, and the
     * discrepancy stated rather than quietly reconciled.
     *
     * What the example was demonstrating survives either number, and is the
     * point: 36% worse on a sample of three is not evidence of anything. 0.66
     * is a coin toss wearing a decimal point, and 0.28 is further from a kill
     * still.
     */
    expect(probRateBelow(3 + 0.5, 90, 5 + 0.5, 110)).toBeCloseTo(0.6597, 4);
  });

  it("🔴 does not kill 3 leads on $90 against an account at $22 per lead", () => {
    /*
     * The same candidate, with enough account-wide volume to clear the engine's
     * own ten-conversion gate — at 8 total conversions it declines to judge at
     * all, which is a stronger version of the same refusal.
     *
     * Every "cost per lead above target" rule in this category switches this
     * campaign off. Here it is a keep, and the reason says why in words a
     * client can be shown.
     */
    const r = assessCandidates([c("small", 90, 3), c("rest", 264, 12)]);
    const small = r.assessments.find((a) => a.id === "small")!;

    expect(small.costPer).toBeCloseTo(30, 5);
    expect(small.benchmarkCostPer).toBeCloseTo(22, 5);
    expect(small.pWorse).toBeCloseTo(0.67, 2);
    expect(small.verdict).toBe("keep");
  });

  it("🔴 declines to judge at all below the account-wide conversion floor", () => {
    // The plan's literal fixture: 8 conversions across the whole account.
    const r = assessCandidates([c("small", 90, 3), c("rest", 110, 5)]);
    expect(r.stage).toBeNull();
    expect(r.assessments).toEqual([]);
  });

  it("kills the same ratio once the sample is big enough to mean it", () => {
    // Identical cost per lead, thirty times the evidence. Now it is a finding.
    const r = assessCandidates([c("big", 2700, 90), c("rest", 3300, 150)]);
    expect(verdictOf(r, "big")).toBe("kill");
    expect(r.assessments.find((a) => a.id === "big")!.pWorse).toBeGreaterThan(0.9);
  });
});

/* ------------------------------------------------------------------ *
 * Staying quiet
 * ------------------------------------------------------------------ */

describe("stays quiet when it should", () => {
  it("says nothing at all below ten conversions account-wide", () => {
    const r = assessCandidates([c("a", 200, 4), c("b", 200, 3)]);
    expect(r.stage).toBeNull();
    expect(r.assessments).toEqual([]);
    expect(r.stageReason).toMatch(/too little to tell/);
  });

  it("🔴 refuses to kill on a spend too small for zero to mean anything", () => {
    /*
     * $30 with no leads, on an account whose leads cost $25. Zero conversions
     * on barely more than one lead's worth of budget is an ordinary Tuesday,
     * and a verdict here would be the engine mistaking a small denominator for
     * a signal.
     */
    const r = assessCandidates([c("tiny", 30, 0), ...bench()]);
    expect(verdictOf(r, "tiny")).toBe("too_early");
    expect(r.assessments.find((a) => a.id === "tiny")!.reason).toMatch(
      /Give it \$\d+.* more before deciding/,
    );
  });

  it("does kill once three conversions' worth of budget has produced none", () => {
    const r = assessCandidates([c("dud", 200, 0), ...bench()]);
    expect(verdictOf(r, "dud")).toBe("kill");
    expect(r.assessments.find((a) => a.id === "dud")!.reason).toMatch(/not one lead/);
  });

  it("🔴 never kills something still in Meta's learning phase", () => {
    /*
     * §1d. An ad set that has not exited learning is not delivering at its own
     * steady state, so its current numbers are not the numbers it would settle
     * at. This is the one recommendation that is confidently wrong.
     */
    const learning = assessCandidates([
      c("new", 400, 0, { inLearning: true }),
      ...bench(),
    ]);
    expect(verdictOf(learning, "new")).toBe("too_early");
    expect(learning.assessments.find((a) => a.id === "new")!.reason).toMatch(
      /learning phase/,
    );

    // The control: identical numbers, out of learning, and it is a kill.
    const settled = assessCandidates([c("new", 400, 0), ...bench()]);
    expect(verdictOf(settled, "new")).toBe("kill");
  });

  it("🔴 does not scale on a good ratio backed by no money", () => {
    /*
     * Five leads for $25 against an account at $25 a lead is a spectacular
     * ratio and pWorse comes out at 0.002 — statistically emphatic, and still
     * not a reason to move budget, because the whole campaign is one lead's
     * worth of spend at the account rate. "More budget" is a decision; this is
     * not evidence for one.
     *
     * The earlier fixture here ($20 / 2 leads) passed for the wrong reason —
     * its pWorse was 0.107, just outside the scale threshold, so removing the
     * minimum-spend rule changed nothing and the mutation survived.
     */
    const r = assessCandidates([c("lucky", 25, 5), ...bench()]);
    const lucky = r.assessments.find((a) => a.id === "lucky")!;
    expect(lucky.pWorse).toBeLessThan(0.01);
    expect(lucky.verdict).toBe("keep");

    // The control: the same ratio with real money behind it IS a scale.
    const bigger = assessCandidates([c("lucky", 120, 12), ...bench()]);
    expect(verdictOf(bigger, "lucky")).toBe("scale");
  });
});

/* ------------------------------------------------------------------ *
 * The benchmark
 * ------------------------------------------------------------------ */

describe("the benchmark is leave-one-out", () => {
  it("🔴 judges a dominant campaign against the others, not against itself", () => {
    /*
     * The campaign carrying 90% of spend, compared against an average it
     * dominates, is compared against itself — pWorse pins to 0.5 and the
     * biggest line item in the account becomes permanently unjudgeable.
     */
    const r = assessCandidates([
      c("whale", 9000, 100), // $90 per lead
      c("small", 1000, 100), // $10 per lead
    ]);
    const whale = r.assessments.find((a) => a.id === "whale")!;

    expect(whale.benchmarkCostPer).toBeCloseTo(10, 5);
    expect(whale.pWorse).toBeGreaterThan(0.99);
    expect(whale.verdict).toBe("kill");
  });

  it("declines to judge when there is nothing else to compare against", () => {
    const r = assessCandidates([c("only", 1000, 40)]);
    expect(verdictOf(r, "only")).toBe("no_benchmark");
    expect(r.assessments[0].reason).toMatch(/whole account/);
  });

  it("declines when the rest of the account converted nothing", () => {
    const r = assessCandidates([c("worker", 500, 20), c("dead", 40, 0)]);
    // `dead` has a benchmark; `worker` does not, since removing it leaves zero.
    expect(verdictOf(r, "worker")).toBe("no_benchmark");
    expect(r.assessments.find((a) => a.id === "worker")!.reason).toMatch(/no benchmark/);
  });
});

/* ------------------------------------------------------------------ *
 * Which stage — §6.6's blind spot
 * ------------------------------------------------------------------ */

describe("judges on the deepest stage the account supports", () => {
  const withStages = (
    id: string,
    spend: number,
    leads: number,
    appts: number,
  ): Candidate => ({
    id,
    name: id,
    spend,
    conversions: { new_lead: leads, appointment_booked: appts },
  });

  it("🔴 does not reward cheap leads that never book", () => {
    /*
     * The §6.6 failure, exactly. `cheap` produces leads at a third of the price
     * and NOT ONE of them books. Judged on leads it is the best campaign in the
     * account and gets more budget; judged on appointments it is the worst.
     */
    const cands = [
      withStages("cheap", 1200, 120, 1), //  $10/lead, $1200/appointment
      withStages("real", 1200, 40, 20), //  $30/lead,   $60/appointment
    ];
    const r = assessCandidates(cands);

    expect(r.stage).toBe("appointment_booked");
    expect(r.stageReason).toMatch(/not on cost per lead/);
    expect(verdictOf(r, "cheap")).toBe("kill");
    expect(verdictOf(r, "real")).toBe("scale");

    // The control: strip the appointment data and the verdicts invert — which
    // is the whole reason the stage is chosen rather than assumed.
    const leadsOnly = assessCandidates(
      cands.map((x) => ({ ...x, conversions: { new_lead: x.conversions.new_lead } })),
    );
    expect(leadsOnly.stage).toBe("new_lead");
    expect(verdictOf(leadsOnly, "cheap")).toBe("scale");
  });

  it("falls back to leads, and says the fallback is a limitation", () => {
    const r = assessCandidates([c("a", 500, 20), c("b", 500, 25)]);
    expect(r.stage).toBe("new_lead");
    expect(r.stageReason).toMatch(/still produce people who never book/);
  });

  it("prefers closed deals when there are enough of them", () => {
    const deep = (id: string, spend: number, won: number): Candidate => ({
      id,
      name: id,
      spend,
      conversions: { new_lead: 100, appointment_booked: 50, closed_won: won },
    });
    const r = assessCandidates([deep("a", 5000, 8), deep("b", 5000, 4)]);
    expect(r.stage).toBe("closed_won");
    expect(r.stageReason).toContain("closed deal");
  });
});

/* ------------------------------------------------------------------ *
 * Ordering and shape
 * ------------------------------------------------------------------ */

describe("the report", () => {
  it("🔴 leads with what deserves attention, biggest money first", () => {
    /*
     * Within a verdict, the reader's attention should go where the money is.
     * The fixture is chosen so the two orderings DISAGREE: `small_dud` is the
     * more confident kill (pWorse 0.99999 on $300 and no leads) while `big_dud`
     * is the more expensive one (pWorse 0.99995 on $4,000). Sorting by
     * confidence puts $300 above $4,000, which is precisely backwards.
     *
     * The previous fixture hid this behind an `if (kills.length > 1)` and a
     * pair of pWorse values that happened to agree with the money ordering, so
     * the mutation survived.
     */
    const r = assessCandidates([
      c("small_dud", 300, 0),
      c("big_dud", 4000, 100),
      c("good", 2000, 100),
    ]);
    const kills = r.assessments.filter((a) => a.verdict === "kill");

    expect(kills).toHaveLength(2);
    expect(kills[0].pWorse).toBeLessThan(kills[1].pWorse); // less confident…
    expect(kills[0].id).toBe("big_dud"); // …but read first, because of the money
    expect(r.assessments[0].verdict).toBe("kill");
  });

  it("reports how many candidates were judged", () => {
    /*
     * Ten campaigns judged at 90% confidence will produce roughly one wrong
     * kill by chance. Rather than a correction that silences the engine on any
     * real account, the count is surfaced so the reader can weigh a lone kill
     * among twenty differently from a lone kill among three.
     */
    const r = assessCandidates([c("a", 500, 20), c("b", 500, 10), c("c", 500, 15)]);
    expect(r.judged).toBe(3);
  });

  it("handles an empty account without inventing anything", () => {
    const r = assessCandidates([]);
    expect(r.assessments).toEqual([]);
    expect(r.stage).toBeNull();
    expect(r.stageReason).toMatch(/No campaigns ran/);
  });

  it("every verdict carries a sentence naming the comparison", () => {
    const r = assessCandidates([c("a", 900, 30), c("b", 600, 10), ...bench()]);
    for (const a of r.assessments) {
      expect(a.reason.length).toBeGreaterThan(30);
      expect(Number.isFinite(a.pWorse)).toBe(true);
      expect(a.pWorse).toBeGreaterThanOrEqual(0);
      expect(a.pWorse).toBeLessThanOrEqual(1);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The arithmetic is the engine's, not a coincidence
 * ------------------------------------------------------------------ */

describe("pWorse is the posterior it claims to be", () => {
  it("matches the closed form computed independently", () => {
    // Re-derived here from the raw counts rather than read back from the
    // engine, so a change to the prior or to the leave-one-out rule shows up.
    const r = assessCandidates([c("x", 400, 8), c("y", 600, 20)]);
    const x = r.assessments.find((a) => a.id === "x")!;
    expect(x.pWorse).toBeCloseTo(probRateBelow(8 + 0.5, 400, 20 + 0.5, 600), 12);
  });

  it("is symmetric between a two-campaign account's halves", () => {
    const r = assessCandidates([c("x", 400, 8), c("y", 600, 20)]);
    const x = r.assessments.find((a) => a.id === "x")!;
    const y = r.assessments.find((a) => a.id === "y")!;
    expect(x.pWorse + y.pWorse).toBeCloseTo(1, 10);
  });
});
