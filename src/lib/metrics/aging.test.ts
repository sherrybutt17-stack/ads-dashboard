import { describe, it, expect } from "vitest";
import {
  buildAging,
  rankAging,
  AGING_STAGES,
  MAX_LISTED,
  type DwellObservation,
  type SittingOpportunity,
} from "./aging";
import type { CanonicalStage } from "@/db/schema";

/**
 * The reason a "stale leads" list gets ignored, written as fixtures.
 *
 * Almost all of these are about the *bar*, not the list: a bar that is one
 * number across every stage flags a lead whose appointment is next Tuesday, a
 * bar measured from too few leads flags everything, and a bar with no upper
 * limit fills the list with leads that were never coming back. Any of the three
 * turns a call list into a spreadsheet nobody opens.
 */

let seq = 0;
const sitting = (o: Partial<SittingOpportunity> = {}): SittingOpportunity => ({
  opportunityId: `opp-${String(++seq).padStart(4, "0")}`,
  name: "Lead",
  stage: "contacted",
  ghlStageName: "Contacted",
  daysInStage: 1,
  value: null,
  campaignId: null,
  campaignName: null,
  everCalled: true,
  ...o,
});

const dwells = (stage: CanonicalStage, days: number[]): DwellObservation[] =>
  days.map((d) => ({ stage, days: d }));

/**
 * 31 completed stays: 27 inside four days, then 7, 9, 12 and 20.
 *
 * Sized past `MIN_MOVERS_FOR_HOPELESS` on purpose — below it the engine refuses
 * to name a never-coming-back line at all, so a smaller fixture could not
 * exercise the two-line behaviour. p90 lands exactly on 7 days; the longest
 * stay that ever ended is 20.
 */
const CONTACTED_HISTORY = dwells("contacted", [
  ...Array.from({ length: 27 }, (_, i) => 1 + (i % 4)),
  7,
  9,
  12,
  20,
]);

/* ------------------------------------------------------------------ *
 * The bar is per stage
 * ------------------------------------------------------------------ */

describe("what counts as too long", () => {
  it("🔴 does not apply one stage's bar to another", () => {
    /*
     * The failure that makes every version of this feature useless. This client
     * moves people out of Contacted in a day or two and books appointments
     * three weeks out. A single threshold either floods the list with
     * appointments that have not happened yet, or misses every neglected new
     * lead.
     */
    const r = buildAging(
      [
        ...dwells("contacted", [1, 1, 1, 1, 2, 2, 2, 2]),
        ...dwells("appointment_booked", [18, 20, 21, 22, 24, 25, 28, 30]),
      ],
      [
        sitting({ stage: "contacted", daysInStage: 6 }),
        sitting({ stage: "appointment_booked", daysInStage: 6 }),
      ],
    );
    const contacted = r.stages.find((s) => s.stage === "contacted")!;
    const booked = r.stages.find((s) => s.stage === "appointment_booked")!;
    expect(contacted.aging).toBe(1); // six days is a long time to go quiet
    expect(booked.aging).toBe(0); // six days is a normal wait for an appointment
  });

  it("measures the bar from this client's own completed stays", () => {
    const r = buildAging(CONTACTED_HISTORY, []);
    const s = r.stages.find((x) => x.stage === "contacted")!;
    expect(s.measured).toBe(true);
    expect(s.movers).toBe(31);
    expect(s.thresholdDays).toBeCloseTo(7, 6);
  });

  it("🔴 falls back to a stated default below eight completed stays", () => {
    // A percentile over three leads is one salesperson's week. The default is
    // deliberately forgiving: a bar that fires too early lists everything, and
    // a list of everything is ignored exactly like no list at all.
    const r = buildAging(dwells("contacted", [1, 1, 2]), []);
    const s = r.stages.find((x) => x.stage === "contacted")!;
    expect(s.measured).toBe(false);
    expect(s.thresholdDays).toBe(10);
    expect(s.movers).toBe(3);
  });

  it("🔴 refuses to guess the never-coming-back line without history", () => {
    // "No lead has ever moved on after N days" is a claim about observed
    // history. With no history there is no claim, and inventing one would
    // retire leads that are still perfectly alive.
    const r = buildAging(dwells("contacted", [1, 2]), []);
    expect(r.stages.find((x) => x.stage === "contacted")!.hopelessDays).toBeNull();
  });

  it("takes the never-coming-back line from the longest stay that ever ended", () => {
    const r = buildAging(CONTACTED_HISTORY, []);
    expect(r.stages.find((x) => x.stage === "contacted")!.hopelessDays).toBe(20);
  });

  it("🔴 will not retire a lead on the evidence of eight quick stays", () => {
    /*
     * The flaw a fixture caught. Eight leads that all moved within two days do
     * NOT establish that nothing comes back after two days — by the rule of
     * succession there is still roughly a one-in-nine chance the next one is
     * longer. Without the higher bar, every lead three days old was being
     * written off as unreachable and removed from the call list entirely.
     */
    const r = buildAging(dwells("contacted", [1, 1, 1, 1, 2, 2, 2, 2]), [
      sitting({ daysInStage: 6 }),
    ]);
    const s = r.stages.find((x) => x.stage === "contacted")!;
    expect(s.measured).toBe(true);
    expect(s.thresholdDays).toBe(2);
    expect(s.hopelessDays).toBeNull();
    expect(r.totalCold).toBe(0);
    expect(r.totalAging).toBe(1); // listed, not written off
  });

  it("reports only stages a lead is expected to leave", () => {
    const r = buildAging(dwells("closed_won", [1, 2, 3, 4, 5, 6, 7, 8, 9]), []);
    expect(r.stages.map((s) => s.stage)).toEqual([...AGING_STAGES]);
    expect(r.stages.every((s) => !s.measured)).toBe(true);
  });

  it("🔴 caps the bar at ninety days however slow the pipeline is", () => {
    /*
     * A stage where the slowest tenth take two years produces a bar nothing can
     * ever cross, and the panel reports an empty, reassuring list for a
     * pipeline that is entirely stalled — the reassuring-silence failure this
     * product exists to replace.
     */
    const r = buildAging(
      dwells("contacted", Array.from({ length: 40 }, (_, i) => 100 + i * 20)),
      [sitting({ daysInStage: 200 })],
    );
    const s = r.stages.find((x) => x.stage === "contacted")!;
    expect(s.thresholdDays).toBe(90);
    expect(r.totalAging).toBe(1);
  });

  it("🔴 floors the bar at a day when everything moves same-day", () => {
    // A bar of zero flags every lead in the pipeline the moment it arrives,
    // which is a list of the whole pipeline and therefore not a list.
    const r = buildAging(
      dwells("contacted", Array.from({ length: 40 }, () => 0)),
      [sitting({ daysInStage: 0.5 })],
    );
    expect(r.stages.find((x) => x.stage === "contacted")!.thresholdDays).toBe(1);
    expect(r.totalAging).toBe(0);
  });

  it("discards impossible dwell times rather than averaging them in", () => {
    // A negative gap means two transitions arrived out of order — GHL's
    // webhooks are at-least-once and unordered. It is not a zero-day stay.
    const r = buildAging(
      [...dwells("contacted", [-5, 1, 1, 2, 2, 3, 3, 4, 5, 20])],
      [],
    );
    expect(r.stages.find((x) => x.stage === "contacted")!.movers).toBe(9);
  });
});

/* ------------------------------------------------------------------ *
 * Terminal stages
 * ------------------------------------------------------------------ */

describe("stages a lead is allowed to rest in", () => {
  it("🔴 never flags a closed, lost or disqualified lead", () => {
    /*
     * An opportunity resting in closed_won forever is the system working.
     * Flagging it would put the entire history of every account on a list of
     * problems, which is the fastest possible way to make the list worthless.
     */
    const r = buildAging(
      [],
      [
        sitting({ stage: "closed_won", daysInStage: 900 }),
        sitting({ stage: "lost", daysInStage: 900 }),
        sitting({ stage: "disqualified", daysInStage: 900 }),
      ],
    );
    expect(r.totalAging).toBe(0);
    expect(r.totalSitting).toBe(0);
    expect(r.leads).toHaveLength(0);
  });

  it("🔴 does flag a no-show nobody rebooked", () => {
    // The most recoverable lead in the pipeline: they wanted the appointment
    // enough to make it. Treating no_show as an ending throws that away.
    const r = buildAging([], [sitting({ stage: "no_show", daysInStage: 30 })]);
    expect(r.totalAging).toBe(1);
    expect(r.leads[0].stage).toBe("no_show");
  });

  it("flags a consultation with no decision recorded", () => {
    const r = buildAging([], [sitting({ stage: "showed", daysInStage: 40 })]);
    expect(r.totalAging).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * The two lines
 * ------------------------------------------------------------------ */

describe("overdue against gone-quiet", () => {
  const history = CONTACTED_HISTORY; // threshold 7 days, hopeless 20

  it("leaves a lead inside the normal window alone", () => {
    const r = buildAging(history, [sitting({ daysInStage: 4 })]);
    expect(r.totalAging).toBe(0);
    expect(r.totalSitting).toBe(1);
  });

  it("lists a lead past the threshold", () => {
    const r = buildAging(history, [sitting({ daysInStage: 12 })]);
    expect(r.totalAging).toBe(1);
    expect(r.leads[0].daysInStage).toBe(12);
    expect(r.leads[0].thresholdDays).toBeCloseTo(7, 6);
  });

  it("🔴 counts but never lists a lead past anything that ever came back", () => {
    /*
     * A call list padded with unreachable leads is a call list that stops being
     * opened — so these are counted, named, and kept out of the rows. Counted,
     * not dropped: "127 leads are beyond saving" is itself a finding, and
     * silently discarding them would be the omission this product exists to
     * prevent.
     */
    const r = buildAging(history, [
      sitting({ daysInStage: 12 }),
      sitting({ daysInStage: 300 }),
    ]);
    expect(r.totalAging).toBe(1);
    expect(r.totalCold).toBe(1);
    expect(r.leads).toHaveLength(1);
    expect(r.stages.find((s) => s.stage === "contacted")!.cold).toBe(1);
  });

  it("keeps everything listable when there is no gone-quiet line yet", () => {
    // Without history there is no upper limit, so nothing may be retired.
    const r = buildAging(dwells("contacted", [1, 2]), [
      sitting({ daysInStage: 400 }),
    ]);
    expect(r.totalCold).toBe(0);
    expect(r.totalAging).toBe(1);
  });

  it("treats a lead sitting exactly at the bar as fine", () => {
    const r = buildAging(dwells("contacted", [5, 5, 5, 5, 5, 5, 5, 5]), [
      sitting({ daysInStage: 5 }),
    ]);
    expect(r.totalAging).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * What cannot be judged
 * ------------------------------------------------------------------ */

describe("leads that cannot be aged at all", () => {
  it("🔴 counts an unmapped stage separately instead of assuming a stage", () => {
    // A GHL stage bound to nothing canonical has no bar to be judged against.
    // Dropping these silently would understate the pipeline; guessing a stage
    // would file them under a bar that is not theirs.
    const r = buildAging(CONTACTED_HISTORY, [
      sitting({ stage: null, daysInStage: 90 }),
    ]);
    expect(r.unmapped).toBe(1);
    expect(r.totalAging).toBe(0);
    expect(r.totalSitting).toBe(0);
  });

  it("🔴 counts an undated lead separately rather than calling it new", () => {
    // A null entry date is "we do not know", not "arrived today". Defaulting to
    // zero days would quietly clear every one of them.
    const r = buildAging(CONTACTED_HISTORY, [sitting({ daysInStage: null })]);
    expect(r.undated).toBe(1);
    expect(r.totalSitting).toBe(0);
    expect(r.totalAging).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The order the list is worked in
 * ------------------------------------------------------------------ */

describe("ranking", () => {
  it("🔴 puts the deepest stage first, not the oldest lead", () => {
    /*
     * Sorting by age surfaces the deadest leads: a lead untouched for four
     * hundred days is a monument, not a task. Someone who booked and drifted
     * last week is a warmer call than someone who filled in a form in March,
     * and every other tool in this category sorts this list upside down.
     */
    const row = (
      opportunityId: string,
      stage: CanonicalStage,
      daysInStage: number,
      thresholdDays: number,
    ) => ({
      opportunityId,
      name: null,
      stage,
      stageLabel: stage,
      ghlStageName: null,
      daysInStage,
      thresholdDays,
      value: null,
      campaignId: null,
      campaignName: null,
      everCalled: null,
    });

    /*
     * The fixture has to make depth and recency DISAGREE, or a ranking that
     * ignores stage entirely passes it. Here the booked lead is 30 days
     * overdue and the new lead only 1 — so sorting by how overdue they are
     * puts the new lead first, and only stage depth puts the booking on top.
     */
    const ranked = rankAging([
      row("fresh-new-lead", "new_lead", 4, 3),
      row("stale-booking", "appointment_booked", 44, 14),
      row("older-new-lead", "new_lead", 400, 3),
    ]);
    expect(ranked.map((l) => l.opportunityId)).toEqual([
      "stale-booking",
      "fresh-new-lead",
      "older-new-lead",
    ]);
  });

  it("puts the least overdue first within a stage — the freshest lapse", () => {
    const r = buildAging(CONTACTED_HISTORY, [
      sitting({ daysInStage: 18 }),
      sitting({ daysInStage: 9 }),
      sitting({ daysInStage: 13 }),
    ]);
    expect(r.leads.map((l) => l.daysInStage)).toEqual([9, 13, 18]);
  });

  it("is deterministic when two leads are equally overdue", () => {
    // Two renders of the same data must not reorder, or a reader loses their
    // place between refreshes.
    const rows = Array.from({ length: 6 }, () => sitting({ daysInStage: 12 }));
    const a = buildAging(CONTACTED_HISTORY, rows).leads.map((l) => l.opportunityId);
    const b = buildAging(CONTACTED_HISTORY, [...rows].reverse()).leads.map(
      (l) => l.opportunityId,
    );
    expect(a).toEqual(b);
  });

  it("🔴 caps the list and says how many it did not show", () => {
    // Silent truncation reads as "that is all of them" — the same lie as a
    // blank chart reading as a zero.
    const rows = Array.from({ length: MAX_LISTED + 17 }, (_, i) =>
      sitting({ daysInStage: 9 + i * 0.01 }),
    );
    const r = buildAging(CONTACTED_HISTORY, rows);
    expect(r.leads).toHaveLength(MAX_LISTED);
    expect(r.notListed).toBe(17);
    expect(r.totalAging).toBe(MAX_LISTED + 17);
  });
});

/* ------------------------------------------------------------------ *
 * Carrying the detail through
 * ------------------------------------------------------------------ */

describe("what each row carries", () => {
  it("🔴 distinguishes never-called from unknowable", () => {
    /*
     * `false` is the most actionable row on the panel: nobody has ever picked
     * up the phone. `null` is a lead that predates call tracking, where we
     * simply do not know — and rendering that as "never called" would put every
     * historical lead at the top of the list on a fact we do not have.
     */
    const r = buildAging(CONTACTED_HISTORY, [
      sitting({ daysInStage: 9, everCalled: false }),
      sitting({ daysInStage: 10, everCalled: null }),
      sitting({ daysInStage: 11, everCalled: true }),
    ]);
    expect(r.leads.map((l) => l.everCalled)).toEqual([false, null, true]);
  });

  it("carries the value and campaign through untouched", () => {
    const r = buildAging(CONTACTED_HISTORY, [
      sitting({ daysInStage: 10, value: 4200, campaignId: "c1", campaignName: "Spring" }),
    ]);
    expect(r.leads[0].value).toBe(4200);
    expect(r.leads[0].campaignId).toBe("c1");
  });

  it("survives an empty pipeline without throwing", () => {
    const r = buildAging([], []);
    expect(r.totalSitting).toBe(0);
    expect(r.totalAging).toBe(0);
    expect(r.stages).toHaveLength(AGING_STAGES.length);
  });

  it("totals sitting across every non-terminal stage", () => {
    const r = buildAging([], [
      sitting({ stage: "new_lead", daysInStage: 1 }),
      sitting({ stage: "contacted", daysInStage: 1 }),
      sitting({ stage: "closed_won", daysInStage: 1 }),
    ]);
    expect(r.totalSitting).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * A stage that has stopped working
 * ------------------------------------------------------------------ */

describe("stages nothing ever leaves", () => {
  it("🔴 reports the stage rather than the people in it", () => {
    /*
     * The live failure. Forty-eight leads sit in Appointment Booked and only
     * twelve have ever left, because nobody marks appointments as attended —
     * so the completed stays are the handful that cancelled quickly, the bar
     * derived from them is a few days, and every genuine booking crosses it
     * within a week. The panel would announce forty-six follow-up calls; the
     * truth is one sentence about a CRM column nobody updates.
     */
    const r = buildAging(
      dwells("appointment_booked", [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]),
      Array.from({ length: 48 }, (_, i) =>
        sitting({ stage: "appointment_booked", daysInStage: 20 + i }),
      ),
    );
    const s = r.stages.find((x) => x.stage === "appointment_booked")!;
    expect(s.stalled).toBe(true);
    expect(s.exitRate).toBeCloseTo(12 / 60, 6);
    // The leads are still real and still listed — the framing changes, not the data.
    expect(s.aging).toBe(48);
    expect(r.leads.length).toBeGreaterThan(0);
  });

  it("does not accuse a healthy stage", () => {
    // Most of what entered has left: the bar is separating something, and the
    // leads past it are genuinely the unusual ones.
    const r = buildAging(
      dwells("contacted", Array.from({ length: 40 }, (_, i) => 1 + (i % 5))),
      Array.from({ length: 9 }, () => sitting({ daysInStage: 30 })),
    );
    const s = r.stages.find((x) => x.stage === "contacted")!;
    expect(s.exitRate).toBeCloseTo(40 / 49, 6);
    expect(s.stalled).toBe(false);
  });

  it("🔴 never accuses a stage holding a handful of leads", () => {
    // Three leads and one mover is a 25% exit rate and means nothing. A panel
    // that called that a broken stage would cry wolf on every new account.
    const r = buildAging(dwells("no_show", [2]), [
      sitting({ stage: "no_show", daysInStage: 40 }),
      sitting({ stage: "no_show", daysInStage: 40 }),
      sitting({ stage: "no_show", daysInStage: 40 }),
    ]);
    const s = r.stages.find((x) => x.stage === "no_show")!;
    expect(s.exitRate).toBeCloseTo(0.25, 6);
    expect(s.stalled).toBe(false);
  });

  it("leaves the exit rate null for a stage nothing has ever touched", () => {
    const r = buildAging([], []);
    expect(r.stages.every((s) => s.exitRate === null && !s.stalled)).toBe(true);
  });
});
