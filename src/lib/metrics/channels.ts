import { spearman, studentTTwoSided } from "./stats";
import { costPer } from "./compute";

/**
 * Is the advertising actually adding anything, or would these leads have come
 * anyway?
 *
 * The question that decides whether a retainer gets renewed, and the one this
 * dashboard has never been able to answer: every number on it divides by paid
 * leads, so the rest of the pipeline is invisible.
 *
 * ---
 *
 * **🔴 It is NOT built on `contacts.source`, and that is a finding, not an
 * omission.**
 *
 * The plan called for splitting the pipeline on that column. Checked against
 * live data before building: it is null for 93% of contacts, and the values
 * that exist are `Free Consultation Calendar` (a GHL calendar name, on 87
 * contacts, 72 of which carry a Meta campaign id and are therefore *paid*),
 * `payment_link`, and two members of staff by name. GoHighLevel's `source` is
 * whatever object created the contact — a calendar, a form, an import — not a
 * marketing channel. A split built on it would classify most of the pipeline as
 * unknown and file paid traffic under a calendar's name.
 *
 * So the split uses the same paid-lead definition every other figure on the
 * dashboard divides by. The other side is therefore **"everything else"**, and
 * the panel must never call it "organic": it is referrals, walk-ins, repeat
 * customers — and any paid lead whose attribution failed to arrive.
 *
 * **🔴 Which is why the panel checks whether the split can be believed BEFORE
 * it compares anything.**
 *
 * The failure it guards against is specific and documented elsewhere in this
 * codebase: native Instant Form leads carry no UTMs at all, and the ad URL
 * parameters that populate `meta_campaign_id` are a setup step that can simply
 * not have been applied. Either one drops paid leads into the "everything else"
 * bucket. A month where that happens reads as the rest of the pipeline surging
 * while paid collapses — and the advice that follows is "cancel the ads".
 *
 * The gap is directly measurable rather than inferred: the platform reports how
 * many leads it generated, the CRM reports how many it could identify, and both
 * numbers are already stored. So the panel measures it and withholds the
 * comparison rather than publishing the most damaging wrong conclusion
 * available to it. (Checked against live data while building: the accounts on
 * this deployment currently match, so the guard is precaution rather than
 * diagnosis.)
 *
 * **🔴 And even when trustworthy, per-lead rates are not the verdict.** The
 * non-paid side contains referrals and repeat customers — the warmest leads any
 * business gets — so it will usually convert better per lead. That is selection,
 * not evidence about the advertising. What paid can be judged on is *volume it
 * adds*: whether the non-paid line held up as spend rose, and what the pipeline
 * looked like before any of this started.
 */

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface MonthChannel {
  month: string;
  label: string;
  /** Ad spend recorded for the month; null when no ad data exists at all. */
  spend: number | null;
  /** What the ad platform itself reported it generated. */
  platformLeads: number | null;
  /** Leads the CRM could attribute to paid. */
  paidLeads: number;
  /** Every other lead that reached the pipeline. */
  otherLeads: number;
  paidAppointments: number;
  otherAppointments: number;
  paidWon: number;
  otherWon: number;
}

/* ------------------------------------------------------------------ *
 * Outputs
 * ------------------------------------------------------------------ */

export interface SideTotals {
  leads: number;
  appointments: number;
  won: number;
  bookRate: number | null;
  closeRate: number | null;
}

export type TrustLevel = "usable" | "degraded" | "broken";

export interface SplitTrust {
  level: TrustLevel;
  /** Months where the platform reported materially more leads than we matched. */
  gapMonths: string[];
  /** Platform-reported leads, and the ones the CRM matched, over the window. */
  platformLeads: number;
  matchedLeads: number;
}

export type CannibalisationVerdict =
  | "no_sign"
  | "possible"
  | "not_enough_months"
  | "not_measurable";

export interface Cannibalisation {
  verdict: CannibalisationVerdict;
  /** Rank correlation between monthly spend and monthly non-paid leads. */
  rho: number | null;
  /** Two-sided p for that correlation. */
  p: number | null;
  months: number;
}

export interface PreSpendBaseline {
  /** Months before any ad data exists for this client. */
  months: number;
  /** Median total leads per month across them. */
  medianLeads: number;
  /** Median total leads per month since ads started. */
  medianSince: number;
}

export interface ChannelMix {
  rows: MonthChannel[];
  paid: SideTotals;
  other: SideTotals;
  spend: number;
  costPerPaidLead: number | null;
  trust: SplitTrust;
  cannibalisation: Cannibalisation;
  /** Null unless there are enough pre-ad-data months to say anything. */
  baseline: PreSpendBaseline | null;
}

/**
 * How far the CRM may fall short of the platform's own lead count before the
 * split stops meaning anything.
 *
 * Some gap is normal and not a fault: the two count different things over
 * different attribution windows, and Meta's figure includes conversion events
 * the CRM never sees as a contact. A THIRD missing is past explaining that way.
 */
const DEGRADED_MATCH_RATE = 0.66;
const BROKEN_MATCH_RATE = 0.34;
/** Below this many platform-reported leads the ratio is not worth computing. */
const MIN_PLATFORM_LEADS = 5;

/** Spearman on fewer months than this detects nothing worth reporting. */
const MIN_MONTHS_FOR_CORRELATION = 8;
/** Two-sided p below this, with a negative rho, is worth raising. */
const CANNIBALISATION_P = 0.1;

/** Fewer pre-ad months than this and the "before" figure is one quiet quarter. */
const MIN_BASELINE_MONTHS = 3;

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const rate = (k: number, n: number) => (n > 0 ? k / n : null);

function totals(
  rows: readonly MonthChannel[],
  side: "paid" | "other",
): SideTotals {
  let leads = 0;
  let appointments = 0;
  let won = 0;
  for (const r of rows) {
    leads += side === "paid" ? r.paidLeads : r.otherLeads;
    appointments += side === "paid" ? r.paidAppointments : r.otherAppointments;
    won += side === "paid" ? r.paidWon : r.otherWon;
  }
  return {
    leads,
    appointments,
    won,
    bookRate: rate(appointments, leads),
    // Against appointments, not leads — the same denominator the funnel uses,
    // so a reader can reconcile it rather than discovering two close rates.
    closeRate: rate(won, appointments),
  };
}

/**
 * Can the split be believed at all?
 *
 * Compares what the ad platform says it produced against what the CRM could
 * identify. Both numbers already exist — this is not an estimate — and their
 * divergence is the single thing that decides whether the rest of the panel is
 * information or misinformation.
 */
export function assessTrust(rows: readonly MonthChannel[]): SplitTrust {
  const ordered = [...rows].sort((a, b) => (a.month < b.month ? -1 : 1));
  let platformLeads = 0;
  let matchedLeads = 0;
  const gapMonths: string[] = [];
  /** Match rate of the most recent month big enough to measure. */
  let latestShare: number | null = null;

  for (const r of ordered) {
    if (r.platformLeads === null) continue;
    platformLeads += r.platformLeads;
    matchedLeads += r.paidLeads;
    if (r.platformLeads < MIN_PLATFORM_LEADS) continue;

    const share = r.paidLeads / r.platformLeads;
    latestShare = share;
    if (share < DEGRADED_MATCH_RATE) gapMonths.push(r.month);
  }

  if (platformLeads < MIN_PLATFORM_LEADS) {
    // Nothing to check against. Not a pass — the absence of a contradiction is
    // not evidence, and calling it "usable" would be the reassuring-silence
    // failure this product exists to replace.
    return { level: "degraded", gapMonths, platformLeads, matchedLeads };
  }

  const grade = (share: number): TrustLevel =>
    share < BROKEN_MATCH_RATE ? "broken" : share < DEGRADED_MATCH_RATE ? "degraded" : "usable";

  /*
   * 🔴 The worse of the whole period and the most recent measurable month —
   * because a break that started last month is the one distorting the numbers
   * being read right now.
   *
   * Found by a fixture taken from live data: July matched 12 of 16 and August 1
   * of 7. Averaged, that is 13 of 23 and grades as merely "degraded", which
   * understates a live break to the point of uselessness. This is the same
   * reason the anomaly panel exists at all — a period average is where a single
   * catastrophic day goes to hide.
   */
  const RANK: Record<TrustLevel, number> = { usable: 0, degraded: 1, broken: 2 };
  const overall = grade(matchedLeads / platformLeads);
  const latest = latestShare === null ? "usable" : grade(latestShare);
  const level = RANK[latest] > RANK[overall] ? latest : overall;

  return { level, gapMonths, platformLeads, matchedLeads };
}

/**
 * Did the rest of the pipeline shrink as spend grew?
 *
 * The one result that would genuinely undermine the retainer: if non-paid leads
 * fall in the months with the most spend, some of what is being paid for would
 * have arrived free. Rank correlation, because a dozen monthly points have no
 * reason to be linear and every reason to contain one outlying month.
 *
 * 🔴 Reported in three states, and "not enough months" is never rendered as
 * reassurance. A correlation over five points detects nothing, and printing
 * "no sign of cannibalisation" from it would be a guarantee drawn from silence.
 */
export function assessCannibalisation(rows: readonly MonthChannel[]): Cannibalisation {
  const usable = rows.filter((r) => r.spend !== null);
  if (usable.length < MIN_MONTHS_FOR_CORRELATION) {
    return { verdict: "not_enough_months", rho: null, p: null, months: usable.length };
  }

  const rho = spearman(
    usable.map((r) => r.spend as number),
    usable.map((r) => r.otherLeads),
  );
  if (!Number.isFinite(rho)) {
    // Every month at the same budget, or the same lead count: no ordering to
    // correlate against, which is a different thing from no relationship.
    return { verdict: "not_measurable", rho: null, p: null, months: usable.length };
  }

  const df = usable.length - 2;
  const t = rho * Math.sqrt(df / Math.max(1e-12, 1 - rho * rho));
  const p = studentTTwoSided(t, df);

  return {
    verdict: rho < 0 && p < CANNIBALISATION_P ? "possible" : "no_sign",
    rho,
    p,
    months: usable.length,
  };
}

/**
 * What the pipeline looked like before any advertising was recorded here.
 *
 * The strongest incrementality evidence available without an experiment — and
 * carefully worded, because "no ad data" is not the same as "no ads were
 * running". It says what the pipeline received, and leaves whether ads were
 * running then to the person who would know.
 */
export function assessBaseline(rows: readonly MonthChannel[]): PreSpendBaseline | null {
  const ordered = [...rows].sort((a, b) => (a.month < b.month ? -1 : 1));
  const firstWithAds = ordered.findIndex((r) => r.spend !== null);
  if (firstWithAds < MIN_BASELINE_MONTHS) return null;

  const before = ordered.slice(0, firstWithAds);
  // No guard on `after` being empty: `findIndex` returning a valid index means
  // that element exists, so the slice always has at least it. A check there was
  // written and removed once a mutation showed nothing could distinguish it.
  const after = ordered.slice(firstWithAds);

  return {
    months: before.length,
    medianLeads: median(before.map((r) => r.paidLeads + r.otherLeads)),
    medianSince: median(after.map((r) => r.paidLeads + r.otherLeads)),
  };
}

export function buildChannelMix(rows: readonly MonthChannel[]): ChannelMix {
  const ordered = [...rows].sort((a, b) => (a.month < b.month ? 1 : -1));
  const spend = rows.reduce((s, r) => s + (r.spend ?? 0), 0);
  const paid = totals(rows, "paid");

  return {
    rows: ordered,
    paid,
    other: totals(rows, "other"),
    spend,
    costPerPaidLead: costPer(spend, paid.leads),
    trust: assessTrust(rows),
    cannibalisation: assessCannibalisation(rows),
    baseline: assessBaseline(rows),
  };
}
