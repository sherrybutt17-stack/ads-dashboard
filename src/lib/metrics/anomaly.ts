import { METRIC_POLARITY, formatCurrency, formatNumber } from "./compute";
import { dayLabel } from "@/lib/dates";
import type { DailyPoint } from "./queries";

/**
 * Anomaly detection — "that number moved strangely".
 *
 * The health checklist answers *is the pipe working*. The insight strip answers
 * *how does this period compare with the last one*. Neither answers the question
 * a client actually asks in a meeting: **what happened on the 14th?** A month
 * that is flat on both ends can contain a day where spend tripled, or three days
 * where leads stopped, and every existing surface averages that away.
 *
 * Pure and deterministic: same series in, same findings out. No I/O, no clock —
 * `todayKey` is passed in, because a function that reads `new Date()` cannot be
 * tested for the one behaviour that matters most here (§ never judge today).
 *
 * ---
 *
 * FOUR DECISIONS, EACH OF WHICH CHANGES WHAT THIS FIRES ON
 *
 * **1 · Median and MAD, not mean and standard deviation.** The plan said mean +
 * stddev; that is the textbook form and it has a defect that matters at this
 * sample size. A single outlier moves the mean *toward itself* and inflates the
 * standard deviation it is being judged against — so the biggest spike in a
 * month is the one least likely to clear the bar, and a spike sitting in the
 * baseline window raises the threshold for every day around it. Median and
 * median-absolute-deviation are unmoved by up to half the sample, which is the
 * property this needs: the baseline should describe an ordinary day, and an
 * ordinary day is exactly what an outlier is not.
 *
 * **2 · A floor under the scale, because MAD collapses to zero.** A client on a
 * fixed daily budget spends the same amount every day, so MAD is 0 and *any*
 * variation scores infinity. Same for a small account whose leads are 0 on most
 * days. Every metric therefore carries a floor, and for counts that floor is
 * Poisson: the standard deviation of a count is √mean, so a metric averaging 2
 * leads a day cannot call 5 leads extraordinary no matter how still the median
 * has been. This is the same lesson `insights.ts` learned — a percentage on
 * small numbers describes the smallness, not the advertising.
 *
 * **3 · Today is never judged.** Today's row is partial by construction: Meta's
 * intraday sync has only the hours so far, and the CRM ledger only the leads so
 * far. Testing it would produce "spend collapsed" every morning for every
 * client, and an alert panel that is wrong every morning is one people stop
 * reading by the end of the week. (Meta's 28-day `is_provisional` window is NOT
 * used as the cutoff — it covers nearly the whole visible range, and excluding
 * it would leave nothing to test. Restatements after day one are small; a
 * half-finished day is not.)
 *
 * **4 · A day with no ad row is a gap, not a zero.** `getDailySeries` emits a
 * zero for every day it has no data on — right for a chart, wrong here, because
 * Meta returns no rows for a paused day AND for a day nobody synced. Treating
 * that zero as a spend collapse would turn one failed nightly job into a
 * confident false alarm. Days without an ad row are excluded from testing and
 * from baselines, and reported separately in language that does not pretend to
 * know which of the two happened.
 */

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/**
 * Days of history a judgement is made against.
 *
 * 28 rather than 30: four whole weeks, so every weekday appears exactly four
 * times in the baseline. Lead flow is strongly weekday-shaped for a service
 * business — Saturdays run at a fraction of Tuesdays — and an unbalanced window
 * would drag the median toward whichever days it happened to include one extra
 * of, then flag the other weekday for it.
 */
export const BASELINE_DAYS = 28;

/**
 * Below this many observed days, no judgement is made at all.
 *
 * A new client with nine days of history has no "usual" yet, and inventing one
 * would greet them with a page of anomalies on their first fortnight.
 */
const MIN_BASELINE_DAYS = 14;

/**
 * Modified z-score cutoff (Iglewicz & Hoaglin). 3.5 is their published
 * recommendation and is the reason the scale is MAD × 1.4826 rather than MAD
 * itself — the constant rescales MAD to a standard deviation for normal data,
 * so "3.5" keeps its familiar meaning.
 */
const THRESHOLD = 3.5;

/** MAD → σ for normally distributed data. 1 / 0.6745. */
const MAD_TO_SIGMA = 1.4826;

/** Most findings shown at once. Beyond a handful, nobody reads any of them. */
const MAX_FINDINGS = 4;

/* ------------------------------------------------------------------ *
 * What gets tested
 * ------------------------------------------------------------------ */

type Scale = "count" | "money";

interface MetricSpec {
  id: string;
  label: string;
  scale: Scale;
  /** `null` means "not measurable that day" — skipped, never treated as zero. */
  read: (p: DailyPoint) => number | null;
  /** Derived from ad-platform rows, so a day with no ad row cannot be judged. */
  needsAdData: boolean;
  /**
   * The smallest deviation that can EVER be flagged, whatever the statistics
   * say. A client spending $9 a day can produce a mathematically flawless 6σ
   * event involving four dollars; the score says it is unusual, this says
   * nobody cares.
   *
   * Expressed as a floor on the scale (`minDeviation / THRESHOLD`) rather than
   * as a separate check, so there is exactly one place a value can be
   * suppressed. Written as a second `if` it was provably unreachable — the
   * floor already rejected everything it would have — and a dead guard is worse
   * than none, because the next person to touch the floor believes something is
   * behind them that isn't.
   */
  minDeviation: number;
  /** Floor on the scale as a fraction of the baseline, for money metrics. */
  relativeFloor?: number;
  format: (v: number, currency: string) => string;
}

/**
 * Four metrics, chosen for being directly actionable.
 *
 * Deliberately absent: CTR and the other daily ratios. A daily ratio's noise is
 * governed by its denominator, so a low-impression day produces a wild CTR that
 * says nothing about the ad — judging it would need a second, denominator-based
 * gate on top of everything below, for a signal already visible through leads
 * and cost per lead. Also absent: closed deals, which at these volumes are 0 or
 * 1 a day; the Poisson floor would correctly suppress almost every one, so the
 * row would exist to do nothing.
 */
const METRICS: readonly MetricSpec[] = [
  {
    id: "spend",
    label: "Ad spend",
    scale: "money",
    read: (p) => p.ads.spend,
    needsAdData: true,
    minDeviation: 50,
    relativeFloor: 0.2,
    format: (v, c) => formatCurrency(v, c),
  },
  {
    id: "new_lead",
    label: "Leads",
    scale: "count",
    read: (p) => p.funnel.new_lead,
    needsAdData: false,
    minDeviation: 3,
    format: (v) => formatNumber(v),
  },
  {
    id: "appointment_booked",
    label: "Appointments",
    scale: "count",
    read: (p) => p.funnel.appointment_booked,
    needsAdData: false,
    minDeviation: 3,
    format: (v) => formatNumber(v),
  },
  {
    id: "cpLead",
    label: "Cost per lead",
    scale: "money",
    // Already null on a day with no leads — `div` guards it upstream, and a
    // no-lead day shows up as a lead anomaly rather than an infinite cost.
    read: (p) => p.derived.cpLead,
    needsAdData: true,
    minDeviation: 10,
    relativeFloor: 0.2,
    format: (v, c) => formatCurrency(v, c),
  },
];

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

export interface Anomaly {
  kind: "outlier" | "gap";
  /** Metric id, matching `METRIC_POLARITY`. `"ad_data"` for a gap. */
  metric: string;
  label: string;
  /** First and last day of the run — equal when it is a single day. */
  startKey: string;
  endKey: string;
  days: number;
  direction: "above" | "below";
  /** Value on the most extreme day of the run. */
  value: number;
  /** The ordinary-day figure it is judged against. */
  baseline: number;
  /** Modified z-score of the most extreme day. `Infinity` is never emitted. */
  score: number;
  tone: "good" | "bad" | "neutral";
  text: string;
}

export interface AnomalyReport {
  findings: Anomaly[];
  /**
   * Days in the range that had enough history behind them to be judged.
   *
   * Carried so the panel can tell "nothing unusual happened" from "we cannot
   * yet tell" — two different facts that both produce an empty list. A new
   * client shown "nothing unusual" for their first fortnight has been told
   * something reassuring and untrue, which is the exact register this product
   * exists to avoid.
   */
  judgedDays: number;
  /** Finished days inside the range, whether or not they could be judged. */
  testedDays: number;
}

export interface AnomalyInput {
  /**
   * Daily rows in ascending date order, covering the tested range AND the
   * `BASELINE_DAYS` of lead-in before it. Passing only the selected range means
   * the earliest days have no baseline and are silently untested.
   */
  series: DailyPoint[];
  /** First day to test, inclusive. */
  testFrom: string;
  /** Last day to test, inclusive. */
  testTo: string;
  /** Today in the CLIENT's timezone. This day and anything after is never judged. */
  todayKey: string;
  /**
   * Date keys with at least one ad-platform row. Omit when unknown — every day
   * is then treated as having data, which is the honest reading of "we can't
   * tell" rather than fabricating gaps.
   */
  adDataDays?: ReadonlySet<string>;
  currency?: string;
}

/* ------------------------------------------------------------------ *
 * Robust statistics
 * ------------------------------------------------------------------ */

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation — the median of distances from the median. */
export function mad(xs: readonly number[], centre = median(xs)): number {
  if (xs.length === 0) return 0;
  return median(xs.map((x) => Math.abs(x - centre)));
}

/**
 * The scale a deviation is measured in, floored so it can never reach zero.
 *
 * Exported because the floor is the part worth testing directly: it is what
 * stands between a client on a fixed daily budget and a page of anomalies.
 */
export function robustScale(spec: MetricSpec, baseline: readonly number[]): number {
  const centre = median(baseline);
  const fromMad = MAD_TO_SIGMA * mad(baseline, centre);

  const shape =
    spec.scale === "count"
      ? // Poisson: a count's own standard deviation is √mean. Below one, a
        // single event is a whole unit of noise, so 1 is the smallest honest
        // scale — never 0, whatever the median does.
        Math.sqrt(Math.max(centre, 1))
      : // Daily ad delivery lands ±20% of budget with nothing behind it.
        centre * (spec.relativeFloor ?? 0.2);

  /*
   * `minDeviation / THRESHOLD` is the absolute floor restated as a scale: at
   * exactly this scale, a deviation of `minDeviation` scores exactly THRESHOLD,
   * so nothing smaller can ever clear the bar. It applies to both shapes, which
   * is what lets the deviation check live in one place instead of two.
   */
  return Math.max(fromMad, shape, spec.minDeviation / THRESHOLD);
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

interface Flag {
  index: number;
  dateKey: string;
  value: number;
  baseline: number;
  score: number;
  direction: "above" | "below";
}

export function detectAnomalies(input: AnomalyInput): AnomalyReport {
  const { series, testFrom, testTo, todayKey, adDataDays, currency = "USD" } = input;
  if (series.length === 0) return { findings: [], judgedDays: 0, testedDays: 0 };

  const hasAds = (key: string) => !adDataDays || adDataDays.has(key);

  /** A day is judgeable when it is inside the range and finished. */
  const testable = (key: string) =>
    key >= testFrom && key <= testTo && key < todayKey;

  const out: Anomaly[] = [];
  const judged = new Set<string>();

  for (const spec of METRICS) {
    const flags: Flag[] = [];

    for (let i = 0; i < series.length; i++) {
      const day = series[i];
      if (!testable(day.dateKey)) continue;
      if (spec.needsAdData && !hasAds(day.dateKey)) continue;

      const value = spec.read(day);
      if (value === null || !Number.isFinite(value)) continue;

      /*
       * The baseline is STRICTLY before the day under test. Including it would
       * let a large value pull its own centre toward itself and inflate its own
       * scale — the exact self-masking that median-and-MAD is here to avoid, put
       * straight back in through the window definition.
       */
      const from = Math.max(0, i - BASELINE_DAYS);
      const baseline: number[] = [];
      for (let j = from; j < i; j++) {
        const prior = series[j];
        if (spec.needsAdData && !hasAds(prior.dateKey)) continue;
        const v = spec.read(prior);
        if (v !== null && Number.isFinite(v)) baseline.push(v);
      }
      if (baseline.length < MIN_BASELINE_DAYS) continue;
      judged.add(day.dateKey);

      const centre = median(baseline);
      const deviation = value - centre;
      // No second gate on the raw deviation — `robustScale` carries the
      // absolute floor, so this comparison is the only place a value passes.
      const score = Math.abs(deviation) / robustScale(spec, baseline);
      if (!Number.isFinite(score) || score < THRESHOLD) continue;

      flags.push({
        index: i,
        dateKey: day.dateKey,
        value,
        baseline: centre,
        score,
        direction: deviation > 0 ? "above" : "below",
      });
    }

    out.push(...runs(flags, spec, currency));
  }

  out.push(...gaps(input));

  return {
    /*
     * Ranked by how far outside normal, not by recency. A 9σ collapse three
     * weeks ago outranks a 3.6σ wobble yesterday — the reader has limited
     * attention and should spend it on the largest thing, which is also the one
     * most likely to still be true.
     */
    findings: out.sort((a, b) => b.score - a.score).slice(0, MAX_FINDINGS),
    judgedDays: judged.size,
    testedDays: series.filter((p) => testable(p.dateKey)).length,
  };
}

/**
 * Collapse consecutive flagged days into one finding.
 *
 * A budget that doubled and stayed doubled is ONE event, and reporting it as
 * five is how a panel becomes wallpaper. Consecutive here means adjacent in the
 * series and pointing the same way; the run is described by its most extreme
 * day, which is the one worth looking at.
 *
 * The trailing baseline does the rest on its own: once the new level has been
 * held for a couple of weeks it becomes the median, the score falls below the
 * threshold, and the finding stops — which is correct, because by then it is no
 * longer news.
 */
function runs(flags: Flag[], spec: MetricSpec, currency: string): Anomaly[] {
  const out: Anomaly[] = [];
  let i = 0;

  while (i < flags.length) {
    let j = i;
    while (
      j + 1 < flags.length &&
      flags[j + 1].index === flags[j].index + 1 &&
      flags[j + 1].direction === flags[j].direction
    ) {
      j++;
    }

    const group = flags.slice(i, j + 1);
    const peak = group.reduce((a, b) => (b.score > a.score ? b : a));
    out.push(describe(spec, group, peak, currency));
    i = j + 1;
  }

  return out;
}

function describe(
  spec: MetricSpec,
  group: Flag[],
  peak: Flag,
  currency: string,
): Anomaly {
  const startKey = group[0].dateKey;
  const endKey = group[group.length - 1].dateKey;
  const days = group.length;
  const up = peak.direction === "above";

  const value = spec.format(peak.value, currency);
  const usual = spec.format(peak.baseline, currency);

  /*
   * Tone comes from the SAME polarity table the tiles and the insight strip
   * use, so the three surfaces cannot disagree about whether a cheaper lead is
   * good news. Spend is polarity-neutral there and stays neutral here: spending
   * more is not by itself better or worse, and colouring it either way would be
   * a judgement the data does not support.
   *
   * 🔴 Read from `METRIC_POLARITY` directly rather than through
   * `changeSentiment`. That helper is the right gate for a KPI tile — its ±5%
   * dead band stops a 1% drift arriving in the same red as a 40% blowout — and
   * the wrong gate here, where significance has already been settled by a
   * stricter test. Routing through it means a percentage can veto a σ.
   *
   * Which it did, on live data: a metric whose baseline is 0 has no computable
   * percentage at all, the fallback of 0 lands inside the dead band, and "Leads
   * reached 4 on Jul 8, on an account that usually records none" rendered as a
   * grey shrug. Two sentiment paths that can disagree is one too many.
   */
  const polarity = METRIC_POLARITY[spec.id] ?? "neutral";
  const tone: Anomaly["tone"] =
    polarity === "neutral" ? "neutral" : (polarity === "higher-better") === up ? "good" : "bad";
  const relative = peak.baseline > 0 ? (peak.value - peak.baseline) / peak.baseline : 0;

  const when =
    days === 1
      ? `on ${dayLabel(peak.dateKey)}`
      : `for ${days} days from ${dayLabel(startKey)}`;

  /*
   * "About 4× the usual" is the phrasing people repeat back; a z-score is not.
   * The multiple is only quoted when the baseline is large enough for it to be
   * meaningful — 0 → 4 leads is not "infinity times" — and below that the two
   * raw figures carry the point on their own.
   *
   * A zero baseline gets words rather than a figure. "Leads reached 4 — usually
   * 0" is technically true and reads like a typo; it was the first thing that
   * looked wrong when this ran against a live account.
   */
  const ratio = peak.baseline > 0 ? peak.value / peak.baseline : 0;
  const multiple =
    peak.baseline <= 0
      ? " — this account normally records none"
      : Math.abs(relative) >= 0.5
        ? ` — about ${ratio.toFixed(ratio >= 10 ? 0 : 1)}× the usual ${usual}`
        : ` — usually ${usual}`;

  return {
    kind: "outlier",
    metric: spec.id,
    label: spec.label,
    startKey,
    endKey,
    days,
    direction: peak.direction,
    value: peak.value,
    baseline: peak.baseline,
    score: peak.score,
    tone,
    text: `${spec.label} ${up ? "reached" : "fell to"} ${value} ${when}${multiple}.`,
  };
}

/**
 * Days inside the tested range with no ad-platform row at all.
 *
 * 🔴 Reported without a verdict, because we genuinely cannot tell which
 * happened. Meta's insights endpoint returns no rows for a paused day and no
 * rows for a day that was never synced — the same absence, two completely
 * different actions. Naming one of them would be a confident guess, and a
 * confident guess about a dead pipe is precisely the failure this product was
 * built to replace. The connection health panel CAN separate them, so the text
 * points there.
 *
 * Only gaps that interrupt an established run are reported: at least one day
 * with ad data must precede them in the series. A client whose account was
 * connected halfway through the month has no gap, just a start date.
 */
function gaps(input: AnomalyInput): Anomaly[] {
  const { series, testFrom, testTo, todayKey, adDataDays } = input;
  if (!adDataDays) return [];

  const out: Anomaly[] = [];
  let sawData = false;
  let i = 0;

  while (i < series.length) {
    const key = series[i].dateKey;

    if (adDataDays.has(key)) {
      sawData = true;
      i++;
      continue;
    }

    let j = i;
    while (j + 1 < series.length && !adDataDays.has(series[j + 1].dateKey)) j++;

    const run = series.slice(i, j + 1).map((p) => p.dateKey);
    const inRange = run.filter((k) => k >= testFrom && k <= testTo && k < todayKey);

    if (sawData && inRange.length > 0) {
      const startKey = inRange[0];
      const endKey = inRange[inRange.length - 1];
      const days = inRange.length;
      out.push({
        kind: "gap",
        metric: "ad_data",
        label: "Ad data",
        startKey,
        endKey,
        days,
        direction: "below",
        value: 0,
        baseline: 0,
        /*
         * Ranked above every statistical finding on purpose. A missing day is
         * not a big number — it is the absence of numbers, and every other
         * figure covering that window is understated by an unknown amount. That
         * outranks knowing which Tuesday was expensive.
         */
        score: Number.MAX_SAFE_INTEGER,
        tone: "bad",
        text:
          days === 1
            ? `No ad data recorded for ${dayLabel(startKey)}. Either the account was paused that day or the sync did not run — the connection health panel tells them apart. Spend and cost figures covering it are understated.`
            : `No ad data recorded for ${days} days (${dayLabel(startKey)}–${dayLabel(endKey)}). Either the account was paused or the sync did not run — the connection health panel tells them apart. Spend and cost figures covering those days are understated.`,
      });
    }

    i = j + 1;
  }

  return out;
}
