import { STAGE_LABELS, type CanonicalStage } from "@/lib/stages";

/**
 * Which leads are rotting where they sit.
 *
 * `opportunities.last_stage_change_at` has been written since the webhook
 * receiver shipped and read by nothing. The reason it is worth reading is that
 * the ledger can say something no threshold can: how long a lead normally sits
 * in *this* stage, for *this* client, before it moves.
 *
 * ---
 *
 * **🔴 One threshold is why every version of this feature gets ignored.**
 *
 * "Leads older than 14 days" mixes three unrelated situations. A lead untouched
 * in New Lead for three days is a failure; a lead in Appointment Booked for
 * three days is a lead whose appointment is next Tuesday; a closed deal sitting
 * for three hundred days is a closed deal. Put them in one list and the list is
 * mostly noise, so nobody opens it, which is precisely the fate of the source
 * spreadsheet this product replaced.
 *
 * So the bar is per stage and measured: **how old is this lead compared to
 * everything that ever moved on from here?** Past the 90th percentile of that
 * distribution and it is in the slowest tenth of things that eventually move —
 * a statement a client can check against their own memory, unlike "stale".
 *
 * **The conditioning is deliberate and stated.** Dwell times are measured over
 * opportunities that DID move on, which excludes the ones still sitting — so it
 * is not an estimate of how long leads take in general, and it must never be
 * presented as one. It is the answer to a narrower question that happens to be
 * the useful one: *of the leads that came back, how long did the slowest take?*
 *
 * **Two lines, not one.** Past the 90th percentile a lead is unusually old.
 * Past the longest gap ever observed, nothing like it has ever come back — that
 * is a cleanup job, not a call list, and mixing the two floods the list with
 * leads nobody can save. The second line is measured too: "no lead has ever
 * moved on from Contacted after 41 days" is a fact about this pipeline, where
 * "3× the threshold" would be a number I made up.
 */

/**
 * Stages a lead is supposed to leave.
 *
 * `closed_won`, `lost` and `disqualified` are absent because they are ends. An
 * opportunity resting in one of them forever is the system working; flagging it
 * would put the entire history of every account on a list of problems.
 *
 * `no_show` and `showed` ARE here. A no-show that nobody rebooks is the most
 * recoverable lead in the pipeline — they wanted the appointment enough to
 * make it — and a consultation with no decision recorded is a sale in limbo.
 */
export const AGING_STAGES: readonly CanonicalStage[] = [
  "new_lead",
  "contacted",
  "appointment_booked",
  "showed",
  "no_show",
];

/**
 * Used only until this client's ledger can answer for itself.
 *
 * Chosen to be forgiving rather than clever: a default that fires too early
 * produces a list of everything, and a list of everything is ignored in exactly
 * the same way as no list at all.
 */
const DEFAULT_THRESHOLD_DAYS: Record<string, number> = {
  new_lead: 3,
  contacted: 10,
  appointment_booked: 14,
  showed: 14,
  no_show: 7,
};

/** Below this many past movers, a percentile is one lead's habit. */
const MIN_MOVERS = 8;

/**
 * 🔴 The never-coming-back line needs far more evidence than the overdue line,
 * because its consequence is harsher: a lead past it leaves the call list.
 *
 * "Nothing has ever come back after N days" rests on N being the longest stay
 * in the sample — and the largest observation is the weakest thing a small
 * sample estimates. By the rule of succession, with `n` stays all shorter than
 * N the chance the next one is longer is about `1/(n+1)`: at eight movers that
 * is ~11%, which is nowhere near enough to retire a live lead. At thirty it is
 * ~3%, which is.
 *
 * Found by a test whose fixture had eight quick stays: every lead three days
 * old was being written off on the evidence that eight people happened to move
 * within two.
 */
const MIN_MOVERS_FOR_HOPELESS = 30;
const MIN_THRESHOLD_DAYS = 1;
const MAX_THRESHOLD_DAYS = 90;

/** The list is a call list. Past this it is a spreadsheet nobody reads. */
export const MAX_LISTED = 40;

/**
 * 🔴 When a stage stops working, the leads in it are not the finding.
 *
 * Found on live data. GG's Appointment Booked holds 48 open leads and flagged
 * 46 of them — which reads as forty-six follow-up calls and is nothing of the
 * sort. Only twelve leads have EVER left that stage, because nobody marks
 * appointments as attended, so the few completed stays are the handful that
 * cancelled quickly and the bar derived from them is 4.7 days. Every genuine
 * booking crosses it within a week and sits there forever.
 *
 * A percentile cannot separate anything under those conditions, and presenting
 * the result as a call list buries the actual problem: this stage is a bucket,
 * not a step. So the exit rate is measured — of everything that ever entered,
 * how much ever left — and below half the panel reports the stage rather than
 * the people, which is the sentence somebody can act on.
 *
 * Gated on a meaningful number sitting, so a stage holding three leads is never
 * accused of being broken.
 */
const STALLED_EXIT_RATE = 0.5;
const MIN_STALLED_SITTING = 8;

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** One completed stay: an opportunity entered a stage and later left it. */
export interface DwellObservation {
  stage: CanonicalStage;
  days: number;
}

/** An opportunity sitting in a stage right now. */
export interface SittingOpportunity {
  opportunityId: string;
  name: string | null;
  /** Null when the GHL stage it sits in is not mapped to anything canonical. */
  stage: CanonicalStage | null;
  ghlStageName: string | null;
  /** Days since it entered its current stage; null when that date is unknown. */
  daysInStage: number | null;
  value: number | null;
  campaignId: string | null;
  campaignName: string | null;
  /**
   * Whether an outbound call has ever reached this lead.
   *
   * `null` means unknowable — the lead predates call tracking. Rendering that
   * as "never called" would put every historical lead at the top of the list
   * on the strength of a fact we do not have.
   */
  everCalled: boolean | null;
}

/* ------------------------------------------------------------------ *
 * Outputs
 * ------------------------------------------------------------------ */

export interface StageAge {
  stage: CanonicalStage;
  label: string;
  /** Older than this and the lead is in the slowest tenth of eventual movers. */
  thresholdDays: number;
  /** The longest gap ever seen here. Past it, nothing has ever come back. */
  hopelessDays: number | null;
  /** True when both lines come from this client's ledger, not the defaults. */
  measured: boolean;
  /** Completed stays the measurement is built on. */
  movers: number;
  /** Opportunities sitting here right now. */
  sitting: number;
  /** Of those, past the threshold but still inside living memory. */
  aging: number;
  /** Past the longest gap ever observed here. Cleanup, not a call list. */
  cold: number;
  /** Of everything that ever entered this stage, the share that ever left. */
  exitRate: number | null;
  /**
   * 🔴 Almost nothing ever leaves this stage, so the finding is the STAGE, not
   * the leads in it. See `STALLED_EXIT_RATE`.
   */
  stalled: boolean;
}

export interface AgingLead {
  opportunityId: string;
  name: string | null;
  stage: CanonicalStage;
  stageLabel: string;
  ghlStageName: string | null;
  daysInStage: number;
  thresholdDays: number;
  value: number | null;
  campaignId: string | null;
  campaignName: string | null;
  /** Never had an outbound call; null when the lead predates call tracking. */
  everCalled: boolean | null;
}

export interface AgingReport {
  stages: StageAge[];
  /** Ranked, capped at `MAX_LISTED`. See `rankAging` for the order and why. */
  leads: AgingLead[];
  /** How many aging leads exist beyond the ones listed. */
  notListed: number;
  totalAging: number;
  totalCold: number;
  totalSitting: number;
  /** Sitting in a GHL stage bound to nothing canonical — cannot be judged. */
  unmapped: number;
  /** No date for when they entered their stage — cannot be judged either. */
  undated: number;
}

export const EMPTY_AGING: AgingReport = {
  stages: [],
  leads: [],
  notListed: 0,
  totalAging: 0,
  totalCold: 0,
  totalSitting: 0,
  unmapped: 0,
  undated: 0,
};

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function thresholdFor(
  stage: CanonicalStage,
  dwells: readonly number[],
): Pick<StageAge, "thresholdDays" | "hopelessDays" | "measured" | "movers"> {
  if (dwells.length < MIN_MOVERS) {
    return {
      thresholdDays: DEFAULT_THRESHOLD_DAYS[stage] ?? 14,
      // 🔴 Null, not a guess. "No lead has ever come back after N days" is a
      // claim about observed history; without the history there is no claim,
      // and inventing one would retire leads that are still perfectly alive.
      hopelessDays: null,
      measured: false,
      movers: dwells.length,
    };
  }
  const sorted = [...dwells].sort((a, b) => a - b);
  return {
    thresholdDays: Math.min(
      MAX_THRESHOLD_DAYS,
      Math.max(MIN_THRESHOLD_DAYS, quantile(sorted, 0.9)),
    ),
    hopelessDays:
      sorted.length >= MIN_MOVERS_FOR_HOPELESS ? sorted[sorted.length - 1] : null,
    measured: true,
    movers: sorted.length,
  };
}

/**
 * The order the list is worked in — and it is deliberately not "oldest first".
 *
 * Sorting by age puts the deadest leads on top: a lead untouched for four
 * hundred days is not a task, it is a monument. What is worth a phone call this
 * afternoon is the lead that went quiet *recently*, in the stage where the most
 * has already been invested — someone who booked and drifted is a warmer call
 * than someone who filled a form in March.
 *
 * So: deepest stage first, then least overdue within it. Every other tool in
 * this category sorts descending by age, which is the same list upside down.
 */
export function rankAging(leads: readonly AgingLead[]): AgingLead[] {
  const depth = (s: CanonicalStage) => AGING_STAGES.indexOf(s);
  return [...leads].sort((a, b) => {
    const d = depth(b.stage) - depth(a.stage);
    if (d !== 0) return d;
    const overdue = a.daysInStage - a.thresholdDays - (b.daysInStage - b.thresholdDays);
    if (overdue !== 0) return overdue;
    return a.opportunityId < b.opportunityId ? -1 : 1;
  });
}

export function buildAging(
  dwells: readonly DwellObservation[],
  sitting: readonly SittingOpportunity[],
): AgingReport {
  const byStage = new Map<CanonicalStage, number[]>();
  for (const d of dwells) {
    /*
     * A negative gap means two transitions arrived out of order — GHL's
     * webhooks are at-least-once and unordered — and it is not a same-day stay.
     *
     * There is deliberately no filter on terminal stages here: only
     * `AGING_STAGES` is ever read back out, so a `closed_won` key would sit
     * unread. It was written and removed once a mutation showed it could not
     * change any output; defensive code that cannot be tested is a liability
     * rather than a safeguard.
     */
    if (!Number.isFinite(d.days) || d.days < 0) continue;
    const list = byStage.get(d.stage);
    if (list) list.push(d.days);
    else byStage.set(d.stage, [d.days]);
  }

  const thresholds = new Map<CanonicalStage, StageAge>();
  for (const stage of AGING_STAGES) {
    thresholds.set(stage, {
      stage,
      label: STAGE_LABELS[stage],
      ...thresholdFor(stage, byStage.get(stage) ?? []),
      sitting: 0,
      aging: 0,
      cold: 0,
      exitRate: null,
      stalled: false,
    });
  }

  const flagged: AgingLead[] = [];
  let unmapped = 0;
  let undated = 0;

  for (const o of sitting) {
    // The `continue` is belt-and-braces — a null stage misses the lookup below
    // and is dropped by the `!t` guard either way. Kept for intent, since the
    // alternative reads as though an unmapped lead falls through to something.
    if (o.stage === null) {
      unmapped++;
      continue;
    }
    const t = thresholds.get(o.stage);
    // A terminal stage. Not sitting, finished — and never counted as either.
    if (!t) continue;

    if (o.daysInStage === null) {
      undated++;
      continue;
    }
    t.sitting++;

    if (o.daysInStage <= t.thresholdDays) continue;

    /*
     * Past the longest stay that ever ended: nothing like this has come back
     * here. Counted, never listed — a call list padded with unreachable leads
     * is a call list that stops being opened.
     */
    if (t.hopelessDays !== null && o.daysInStage > t.hopelessDays) {
      t.cold++;
      continue;
    }

    t.aging++;
    flagged.push({
      opportunityId: o.opportunityId,
      name: o.name,
      stage: o.stage,
      stageLabel: STAGE_LABELS[o.stage],
      ghlStageName: o.ghlStageName,
      daysInStage: o.daysInStage,
      thresholdDays: t.thresholdDays,
      value: o.value,
      campaignId: o.campaignId,
      campaignName: o.campaignName,
      everCalled: o.everCalled,
    });
  }

  /*
   * Now that both halves are counted: what share of everything that ever
   * entered each stage ever left it? Below half, the stage is a bucket rather
   * than a step, and no percentile drawn from the few completed stays can
   * separate a neglected lead from a normal one.
   */
  for (const t of thresholds.values()) {
    const entered = t.movers + t.sitting;
    t.exitRate = entered > 0 ? t.movers / entered : null;
    t.stalled =
      t.sitting >= MIN_STALLED_SITTING &&
      t.exitRate !== null &&
      t.exitRate < STALLED_EXIT_RATE;
  }

  const ranked = rankAging(flagged);
  const stages = AGING_STAGES.map((s) => thresholds.get(s)!);

  return {
    stages,
    leads: ranked.slice(0, MAX_LISTED),
    notListed: Math.max(0, ranked.length - MAX_LISTED),
    totalAging: ranked.length,
    totalCold: stages.reduce((n, s) => n + s.cold, 0),
    totalSitting: stages.reduce((n, s) => n + s.sitting, 0),
    unmapped,
    undated,
  };
}
