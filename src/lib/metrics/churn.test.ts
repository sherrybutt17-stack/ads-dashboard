import { describe, it, expect } from "vitest";
import {
  assessClient,
  buildChurn,
  levelFor,
  BLOCK_DAYS,
  WEEKS,
  type ChurnInput,
  type ChurnSignal,
  type ChurnWeek,
} from "./churn";

/**
 * A churn panel is read once a week by somebody deciding whether to phone a
 * client, so its failure mode is not a wrong number — it is crying wolf.
 *
 * Most of these fixtures exist to keep a signal QUIET: a new account with empty
 * history, a two-lead client whose count halved, a fortnight that happened to
 * be cheaper. Each of them is a plausible-looking decline that means nothing,
 * and any one of them firing every week is enough for the panel to be ignored
 * for the one month it would have mattered.
 */

const weeks = (spend: readonly number[], leads: readonly number[]): ChurnWeek[] =>
  spend.map((s, i) => ({ spend: s, leads: leads[i] ?? 0 }));

/** Eight steady weeks: $200 and 5 leads apiece. */
const STEADY = weeks(Array(8).fill(200), Array(8).fill(5));

const input = (o: Partial<ChurnInput> = {}): ChurnInput => ({
  clientId: "c1",
  name: "Client",
  slug: "client",
  currency: "USD",
  weeks: STEADY,
  daysSinceWebhook: 0,
  firstActivityDaysAgo: 400,
  ...o,
});

const ids = (s: readonly ChurnSignal[]) => s.map((x) => x.id).sort();

/* ------------------------------------------------------------------ *
 * Staying quiet
 * ------------------------------------------------------------------ */

describe("clients that should not be flagged", () => {
  it("says nothing about a steady client", () => {
    const r = assessClient(input());
    expect(r.level).toBe("none");
    expect(r.signals).toEqual([]);
  });

  it("🔴 does not flag a client that only just started", () => {
    /*
     * The trap this panel would otherwise ship with. A client onboarded three
     * weeks ago has four empty older buckets, which is arithmetically identical
     * to one that switched its spend off — so every new account would be
     * greeted with "they have turned it off" on the day it starts working.
     */
    const r = assessClient(
      input({
        weeks: weeks([0, 0, 0, 0, 200, 200, 200, 200], [0, 0, 0, 0, 5, 5, 5, 5]),
        firstActivityDaysAgo: 26,
      }),
    );
    expect(r.level).toBe("unknown");
    expect(r.unknownReason).toBe("too_new");
    expect(r.signals).toEqual([]);
  });

  it("does not call a client with no history at all steady", () => {
    // "We cannot tell" printed as "nothing wrong" is how a silent failure
    // becomes a lost client — the exact shape of the sheet this replaced.
    const r = assessClient(input({ firstActivityDaysAgo: null, weeks: weeks(Array(8).fill(0), Array(8).fill(0)) }));
    expect(r.level).toBe("unknown");
    expect(r.unknownReason).toBe("no_activity");
  });

  it("🔴 ignores a percentage swing on trivial spend", () => {
    /*
     * $80 → $20 is a 75% collapse and is somebody's test campaign. The insights
     * engine needed exactly this gate: below a few hundred dollars every ratio
     * is a headline and none of them mean anything.
     */
    const r = assessClient(
      input({ weeks: weeks([20, 20, 20, 20, 5, 5, 5, 5], Array(8).fill(0)) }),
    );
    expect(ids(r.signals)).not.toContain("spend_stopped");
    expect(ids(r.signals)).not.toContain("spend_down");
  });

  it("🔴 ignores a lead count halving from two", () => {
    /*
     * Live, this deployment's client runs 0–8 leads a week. A fixed percentage
     * would fire on almost every fortnight; a counting-noise test correctly
     * finds 8 → 4 unremarkable, because it is.
     */
    const r = assessClient(input({ weeks: weeks(Array(8).fill(200), [2, 2, 2, 2, 1, 1, 1, 1]) }));
    expect(ids(r.signals)).not.toContain("results_down");
  });

  it("does not read fewer leads as our failure when the budget was cut", () => {
    // Half the money buying half the leads is arithmetic, not a delivery
    // problem, and reporting both would double-count one decision.
    const r = assessClient(
      input({ weeks: weeks([400, 400, 400, 400, 150, 150, 150, 150], [10, 10, 10, 10, 2, 2, 2, 2]) }),
    );
    expect(ids(r.signals)).toEqual(["spend_down"]);
  });

  it("🔴 ignores a fortnight that was simply a bit cheaper", () => {
    /*
     * Spend down 10%. Every account does this — a bank holiday, a weekend of
     * thin auctions, a campaign restarted a day late. A bar low enough to catch
     * it flags most of the book most weeks, and then nobody reads the panel on
     * the month a client really does halve their budget.
     */
    const r = assessClient(
      input({ weeks: weeks([400, 400, 400, 400, 360, 360, 360, 360], Array(8).fill(5)) }),
    );
    expect(r.signals).toEqual([]);
  });

  it("🔴 does not call three leads for eight hundred dollars 'nothing'", () => {
    /*
     * Expensive, and possibly worth a conversation for other reasons — but
     * leads ARE landing, and this signal claims they are not. It exists for the
     * broken-funnel case, where a relative test would miss the collapse
     * entirely if the previous month was also poor.
     */
    const r = assessClient(
      input({ weeks: weeks(Array(8).fill(200), [3, 3, 3, 3, 1, 1, 1, 0]) }),
    );
    expect(ids(r.signals)).not.toContain("nothing_landing");
  });

  it("🔴 does not call a paused account a broken funnel", () => {
    /*
     * $40 over four weeks and no leads. Correct behaviour for forty dollars,
     * and the difference between "the funnel is broken" and "the ads are barely
     * running" is the difference between a panicked call and none at all.
     */
    const r = assessClient(input({ weeks: weeks(Array(8).fill(10), Array(8).fill(0)) }));
    expect(r.signals).toEqual([]);
  });

  it("ignores a small rise", () => {
    const r = assessClient(
      input({ weeks: weeks([200, 200, 200, 200, 230, 230, 230, 230], Array(8).fill(5)) }),
    );
    expect(r.signals).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

describe("the money signals", () => {
  it("flags spend switched off, and calls it a conversation", () => {
    const r = assessClient(
      input({ weeks: weeks([300, 300, 300, 300, 0, 0, 0, 0], Array(8).fill(5)) }),
    );
    expect(ids(r.signals)).toContain("spend_stopped");
    expect(r.level).toBe("talk");
  });

  it("carries the two numbers it was derived from", () => {
    /*
     * The whole design in one assertion. A manager dismisses "1,200 → 0" in a
     * second when they already know why; a "risk score" can be neither acted on
     * nor dismissed, which is why there is not one.
     */
    const r = assessClient(
      input({ weeks: weeks([300, 300, 300, 300, 0, 0, 0, 0], Array(8).fill(5)) }),
    );
    const s = r.signals.find((x) => x.id === "spend_stopped")!;
    expect(s.prior).toBeCloseTo(1200, 6);
    expect(s.recent).toBeCloseTo(0, 6);
    expect(s.change).toBeCloseTo(-1, 6);
  });

  it("separates a cut from a stop", () => {
    // "They halved it" and "they turned it off" call for different phone calls.
    const r = assessClient(
      input({ weeks: weeks([400, 400, 400, 400, 200, 200, 200, 200], Array(8).fill(5)) }),
    );
    expect(ids(r.signals)).toEqual(["spend_down"]);
    expect(r.level).toBe("watch");
  });

  it("notes when spend also fell every single week", () => {
    /*
     * Four consecutive falls is far rarer than one step down and reads very
     * differently to a person. Reported, never required — demanding it would
     * miss the client who halved the budget in one go, which is the clearer
     * decision of the two.
     */
    const r = assessClient(
      input({ weeks: weeks([400, 400, 400, 400, 280, 240, 200, 160], Array(8).fill(5)) }),
    );
    expect(r.signals.find((s) => s.id === "spend_down")?.everyWeek).toBe(true);
  });

  it("🔴 counts the run from the last prior week, not the first recent one", () => {
    /*
     * Recent weeks 300, 280, 240, 200 fall three times among themselves, but
     * the week before them was 250 — so the first recent week ROSE and "fell
     * every week" is not true. Comparing only within the block would silently
     * mean "fell three times".
     */
    const r = assessClient(
      input({ weeks: weeks([450, 450, 450, 250, 300, 280, 240, 200], Array(8).fill(5)) }),
    );
    expect(r.signals.find((s) => s.id === "spend_down")?.everyWeek).toBe(false);
  });

  it("does not claim every week when one was flat", () => {
    const r = assessClient(
      input({ weeks: weeks([400, 400, 400, 400, 280, 280, 200, 160], Array(8).fill(5)) }),
    );
    expect(r.signals.find((s) => s.id === "spend_down")?.everyWeek).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

describe("the results signals", () => {
  it("flags a real collapse in leads at the same spend", () => {
    // 40 → 8 over four weeks with the money unchanged. Whatever the cause, the
    // client will notice before the agency does unless something says this.
    const r = assessClient(
      input({ weeks: weeks(Array(8).fill(200), [10, 10, 10, 10, 2, 2, 2, 2]) }),
    );
    const s = r.signals.find((x) => x.id === "results_down")!;
    expect(s.recent).toBe(8);
    expect(s.prior).toBe(40);
    expect(s.p!).toBeLessThan(0.05);
  });

  it("🔴 flags real money buying nothing at all", () => {
    /*
     * Not a trend and not a comparison — the one signal that needs no history
     * to be alarming. A month of spend with zero leads is a broken funnel, and
     * a relative test would miss it entirely if the prior month was also poor.
     */
    const r = assessClient(
      input({ weeks: weeks(Array(8).fill(200), [1, 1, 0, 0, 0, 0, 0, 0]) }),
    );
    expect(ids(r.signals)).toContain("nothing_landing");
    expect(r.signals.find((s) => s.id === "nothing_landing")?.spend).toBeCloseTo(800, 6);
    expect(r.level).toBe("talk");
  });

  it("does not report both nothing-landing and results-down", () => {
    // They describe the same zero. Two lines for one fact reads as two problems.
    const r = assessClient(
      input({ weeks: weeks(Array(8).fill(200), [10, 10, 10, 10, 0, 0, 0, 0]) }),
    );
    expect(ids(r.signals)).toEqual(["nothing_landing"]);
  });

  it("scales with volume rather than using a percentage", () => {
    /*
     * The same 40% fall, twice: at 200 leads it is far outside counting noise,
     * at 5 it is an ordinary fortnight. A fixed threshold is wrong at one end
     * or the other, always.
     */
    const big = assessClient(
      input({ weeks: weeks(Array(8).fill(200), [50, 50, 50, 50, 30, 30, 30, 30]) }),
    );
    const small = assessClient(
      input({ weeks: weeks(Array(8).fill(200), [2, 2, 1, 0, 1, 1, 1, 0]) }),
    );
    expect(ids(big.signals)).toContain("results_down");
    expect(ids(small.signals)).not.toContain("results_down");
  });
});

/* ------------------------------------------------------------------ *
 * The pipe
 * ------------------------------------------------------------------ */

describe("a dead CRM pipe", () => {
  it("🔴 suppresses the lead signals rather than reporting collapsed demand", () => {
    /*
     * If webhooks stopped arriving, leads read as zero and every lead-based
     * signal fires with total confidence about nothing at all. The panel would
     * tell an agency their campaigns had died when their integration had.
     */
    const r = assessClient(
      input({
        weeks: weeks(Array(8).fill(200), [10, 10, 10, 10, 0, 0, 0, 0]),
        daysSinceWebhook: 21,
      }),
    );
    expect(ids(r.signals)).toEqual(["pipe_dead"]);
    expect(r.signals[0].days).toBe(21);
  });

  it("still reports the money, which does not come from the CRM", () => {
    // Spend is Meta's number. A dead GHL webhook says nothing about it, and
    // suppressing it would hide a budget cut behind an integration fault.
    const r = assessClient(
      input({
        weeks: weeks([400, 400, 400, 400, 0, 0, 0, 0], Array(8).fill(5)),
        daysSinceWebhook: 30,
      }),
    );
    expect(ids(r.signals)).toEqual(["pipe_dead", "spend_stopped"]);
  });

  it("treats a client that has never sent a webhook as pipe-dead", () => {
    const r = assessClient(input({ daysSinceWebhook: null }));
    expect(ids(r.signals)).toEqual(["pipe_dead"]);
    expect(r.signals[0].days).toBeNull();
  });

  it("tolerates a few quiet days", () => {
    // Small clients genuinely go days without a CRM event. A bar low enough to
    // fire on a quiet weekend would mark the whole book red every Monday.
    expect(assessClient(input({ daysSinceWebhook: 6 })).signals).toEqual([]);
    expect(ids(assessClient(input({ daysSinceWebhook: 7 })).signals)).toEqual(["pipe_dead"]);
  });
});

/* ------------------------------------------------------------------ *
 * The decision table
 * ------------------------------------------------------------------ */

describe("severity", () => {
  const sig = (id: ChurnSignal["id"]): ChurnSignal => ({ id, recent: 0, prior: 1, change: null });

  it("is none with nothing to report", () => {
    expect(levelFor([])).toBe("none");
  });

  it("escalates the two unambiguous signals on their own", () => {
    expect(levelFor([sig("spend_stopped")])).toBe("talk");
    expect(levelFor([sig("nothing_landing")])).toBe("talk");
  });

  it("🔴 escalates only on the conjunction, not on either half", () => {
    /*
     * A budget cut alone has a hundred innocent explanations, and so does a
     * quiet fortnight. Both at once is the pattern worth a phone call — and
     * requiring the conjunction is what stops half the book reading `talk`
     * every month.
     */
    expect(levelFor([sig("spend_down")])).toBe("watch");
    expect(levelFor([sig("results_down")])).toBe("watch");
    expect(levelFor([sig("spend_down"), sig("results_down")])).toBe("talk");
  });

  it("keeps a dead pipe at watch", () => {
    // It is a fault to fix, not a relationship to rescue — though nobody having
    // noticed for three weeks is itself worth seeing.
    expect(levelFor([sig("pipe_dead")])).toBe("watch");
  });
});

/* ------------------------------------------------------------------ *
 * The book
 * ------------------------------------------------------------------ */

describe("across the book", () => {
  it("lists only clients with something to say", () => {
    const r = buildChurn([
      input({ clientId: "a", name: "Steady" }),
      input({
        clientId: "b",
        name: "Stopped",
        weeks: weeks([300, 300, 300, 300, 0, 0, 0, 0], Array(8).fill(5)),
      }),
    ]);
    expect(r.flagged.map((c) => c.name)).toEqual(["Stopped"]);
    expect(r.steady).toBe(1);
  });

  it("🔴 counts the unjudgeable apart from the steady", () => {
    /*
     * Rolled together, "9 clients look fine" would include three nobody could
     * form an opinion about. That is the reassuring-summary failure this whole
     * product exists to replace, in one number.
     */
    const r = buildChurn([
      input({ clientId: "a" }),
      input({ clientId: "b", firstActivityDaysAgo: 10 }),
      input({ clientId: "c", firstActivityDaysAgo: null }),
    ]);
    expect(r.steady).toBe(1);
    expect(r.unknown).toBe(2);
    expect(r.flagged).toEqual([]);
  });

  it("puts conversations above things to watch", () => {
    const r = buildChurn([
      input({ clientId: "a", name: "Watch", weeks: weeks([400, 400, 400, 400, 200, 200, 200, 200], Array(8).fill(5)) }),
      input({ clientId: "b", name: "Talk", weeks: weeks([300, 300, 300, 300, 0, 0, 0, 0], Array(8).fill(5)) }),
    ]);
    expect(r.flagged.map((c) => c.name)).toEqual(["Talk", "Watch"]);
  });

  it("then orders by how many separate things are off", () => {
    // Explicitly a weak ordering and nothing more. It is not a risk model, and
    // the copy beside it says so rather than letting position imply rank.
    const r = buildChurn([
      input({ clientId: "a", name: "One", weeks: weeks([400, 400, 400, 400, 200, 200, 200, 200], Array(8).fill(5)) }),
      input({
        clientId: "b",
        name: "Two",
        weeks: weeks([400, 400, 400, 400, 200, 200, 200, 200], Array(8).fill(5)),
        daysSinceWebhook: 20,
      }),
    ]);
    expect(r.flagged.map((c) => c.name)).toEqual(["Two", "One"]);
  });

  it("breaks ties by name so the list does not reshuffle", () => {
    const bad = weeks([300, 300, 300, 300, 0, 0, 0, 0], Array(8).fill(5));
    const r = buildChurn([
      input({ clientId: "b", name: "Zeta", weeks: bad }),
      input({ clientId: "a", name: "Alpha", weeks: bad }),
    ]);
    expect(r.flagged.map((c) => c.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("reports the block length it used", () => {
    expect(buildChurn([]).blockDays).toBe(28);
    expect(BLOCK_DAYS).toBe(28);
    expect(WEEKS).toBe(8);
  });

  it("🔴 refuses to judge a short series rather than comparing half a block", () => {
    /*
     * The client is old enough on paper, so this is the loader having supplied
     * fewer buckets than asked for. Half a block against a full one produces
     * the same manufactured decline an unfinished week would.
     */
    const r = assessClient(input({ weeks: weeks([200, 200, 200, 200, 200], Array(5).fill(5)) }));
    expect(r.level).toBe("unknown");
    expect(r.unknownReason).toBe("too_new");
  });
});
