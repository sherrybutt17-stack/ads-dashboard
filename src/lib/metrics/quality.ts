import { probBetaGreater } from "./stats";
import {
  maturationFor,
  OUTCOME_NOUN,
  OUTCOME_VERB,
  type OutcomeStage,
} from "./speed-outcome";

/**
 * What kinds of leads convert.
 *
 * ── 🔴 Why there is no per-lead score, and there is not going to be ────
 *
 * The ask was "score new leads by similarity to ones that closed". That is
 * buildable and it is the wrong thing to build, for a reason that has nothing
 * to do with sample size:
 *
 * **A lead score changes the outcome it predicts.** Mark a lead cold, the team
 * calls it last or not at all, it does not close — and the model trains on its
 * own effect. The score gets more confident every month while the pipeline gets
 * worse, and there is no measurement inside the system that can tell the
 * difference. This is the best-documented failure mode in lead scoring and it
 * is not fixable by better features.
 *
 * The second reason is narrower and just as disqualifying. The attributes we
 * hold that would carry the most signal — name, phone area code — are proxies
 * for geography and therefore for protected characteristics. A medical
 * aesthetics practice routing its callbacks by an area-code-derived score is a
 * discrimination problem wearing a dashboard.
 *
 * So this reports at the level of the GROUP and stops there. Every finding here
 * is a fact about a segment, phrased so the action it suggests is to fix the
 * source — the ad schedule, the form, the campaign mix — rather than to sort
 * people into a queue. The panel says that out loud.
 *
 * ── 🔴 The feature that was measured and then deliberately dropped ─────
 *
 * "Does the lead have a phone number and an email?" looks like the strongest
 * feature available and would have produced a large, confident, completely
 * false signal.
 *
 * On the live database 1,411 of 1,605 contacts carry neither. Those are not
 * people who declined to leave contact details; they are rows the historical
 * import never populated. The feature would have measured which leads arrived
 * through the backfill rather than which leads are any good, and because the
 * backfill is older it is also more matured — so it would have correlated with
 * conversion twice over, for two different wrong reasons.
 *
 * No statistical gate can see this. A minority-share threshold passes it
 * comfortably at 12%. The only defence is knowing where the column came from,
 * which is why the feature list here is short and hand-picked rather than
 * "every column on `contacts`".
 *
 * ── What is left, and why each one survives ────────────────────────────
 *
 * · **When the lead arrived** — day type and hour band. Recorded by GHL at
 *   creation for every lead, backfilled or not, and it points at a real lever:
 *   ad scheduling and out-of-hours cover.
 * · **Which campaign it came from** — the most actionable segment there is.
 *   Unattributed leads are their own level rather than being dropped, because
 *   pre-UTM history is a large share of this book and silently excluding it
 *   would make every campaign look like it carries the whole pipeline.
 */

export type QualityFeature = "day_type" | "hour_band" | "campaign";

/** Leads in a level, and in the remainder, before either may be compared. */
export const MIN_LEADS_PER_LEVEL = 25;

/** Posterior probability required to call a difference real. Matches §6.19. */
export const CONFIDENT = 0.9;

export interface QualityLead {
  leadAt: string;
  /** ISO weekday 1–7 in the CLIENT's timezone, resolved by Postgres. */
  dow: number;
  /** Hour 0–23 in the client's timezone. */
  hour: number;
  campaignId: string | null;
  /** Days from lead-in to entering each stage. Absent means never reached. */
  reached: Partial<Record<OutcomeStage, number>>;
}

export interface LevelResult {
  key: string;
  label: string;
  /** Leads old enough to judge, or already converted. */
  leads: number;
  converted: number;
  rate: number | null;
  restLeads: number;
  restRate: number | null;
  /** P(this level converts better than the rest). Null when not comparable. */
  probability: number | null;
  verdict: "better" | "worse" | "same" | "not_enough";
}

export interface FeatureResult {
  feature: QualityFeature;
  label: string;
  levels: LevelResult[];
  verdict: "differs" | "no_difference" | "not_enough";
}

export interface QualitySignal {
  feature: QualityFeature;
  key: string;
  label: string;
  direction: "better" | "worse";
  rate: number;
  restRate: number;
  leads: number;
  converted: number;
}

export interface QualityReport {
  stage: OutcomeStage;
  features: FeatureResult[];
  signals: QualitySignal[];
  /** Leads withheld as too young to have converted yet. */
  maturing: number;
  maturationDays: number;
  maturationMeasured: boolean;
  judged: number;
  converted: number;
  baseRate: number | null;
}

export const FEATURE_LABEL: Record<QualityFeature, string> = {
  day_type: "Day of the week",
  hour_band: "Time of day",
  campaign: "Campaign",
};

/**
 * What to do about each feature if it turns out to matter.
 *
 * Written into the model rather than the component because it is the point of
 * the panel: every one of these is a change to the SOURCE. None of them is
 * "call this lead sooner", which is the reading this feature has to design out.
 */
export const FEATURE_ACTION: Record<QualityFeature, string> = {
  day_type: "worth checking against the ad schedule and weekend cover",
  hour_band: "worth checking against ad dayparting and out-of-hours cover",
  campaign: "worth checking against budget split and creative",
};

const DAY_TYPE_LABEL: Record<string, string> = {
  weekday: "Weekday",
  weekend: "Weekend",
};

const HOUR_BAND_LABEL: Record<string, string> = {
  business: "8am–6pm",
  evening: "6pm–11pm",
  overnight: "11pm–8am",
};

export function dayTypeOf(dow: number): string | null {
  if (!Number.isInteger(dow) || dow < 1 || dow > 7) return null;
  return dow >= 6 ? "weekend" : "weekday";
}

export function hourBandOf(hour: number): string | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (hour >= 8 && hour < 18) return "business";
  if (hour >= 18 && hour < 23) return "evening";
  return "overnight";
}

/** The campaign a lead is filed under. Unattributed is a level, not a gap. */
export const UNATTRIBUTED = "__unattributed__";

function rate(converted: number, leads: number): number | null {
  return leads > 0 ? converted / leads : null;
}

interface Judged {
  converted: boolean;
  dayType: string | null;
  hourBand: string | null;
  campaign: string;
}

/**
 * Compare one level against everything else under the same feature.
 *
 * Against the REST rather than against the overall base rate, for the same
 * reason §6.19 does: the base rate contains the level, so a level holding most
 * of the volume would be compared with a near-copy of itself and could never
 * differ from it.
 */
function compareLevel(
  key: string,
  label: string,
  rows: readonly Judged[],
  belongs: (j: Judged) => boolean,
): LevelResult {
  const mine = rows.filter(belongs);
  const rest = rows.filter((j) => !belongs(j));
  const converted = mine.filter((j) => j.converted).length;
  const restConverted = rest.filter((j) => j.converted).length;

  const base: LevelResult = {
    key,
    label,
    leads: mine.length,
    converted,
    rate: rate(converted, mine.length),
    restLeads: rest.length,
    restRate: rate(restConverted, rest.length),
    probability: null,
    verdict: "not_enough",
  };

  if (mine.length < MIN_LEADS_PER_LEVEL || rest.length < MIN_LEADS_PER_LEVEL) {
    return base;
  }

  const p = probBetaGreater(
    converted + 1,
    mine.length - converted + 1,
    restConverted + 1,
    rest.length - restConverted + 1,
  );
  if (!Number.isFinite(p)) return base;

  return {
    ...base,
    probability: p,
    verdict: p >= CONFIDENT ? "better" : p <= 1 - CONFIDENT ? "worse" : "same",
  };
}

export function buildQuality(
  leads: readonly QualityLead[],
  opts: {
    stage: OutcomeStage;
    asOf: Date;
    /** Campaign ids to their display names, for the level labels. */
    campaignNames?: Record<string, string>;
  },
): QualityReport {
  const { stage, asOf } = opts;
  const asOfMs = asOf.getTime();

  const observed = leads
    .map((l) => l.reached[stage])
    .filter((d): d is number => d !== undefined);
  const { days: maturationDays, measured } = maturationFor(stage, observed);

  const rows: Judged[] = [];
  let maturing = 0;

  for (const l of leads) {
    const converted = l.reached[stage] !== undefined;
    /*
     * 🔴 `converted ||` first, exactly as §6.7 does. A lead that booked
     * yesterday is a settled observation however young it is; testing age alone
     * would discard the fastest-converting leads from whichever segment they
     * belong to — and the segments that convert fastest are the ones this panel
     * exists to find.
     */
    const ageDays = (asOfMs - new Date(l.leadAt).getTime()) / 86_400_000;
    if (!converted && !(ageDays >= maturationDays)) {
      maturing++;
      continue;
    }
    rows.push({
      converted,
      dayType: dayTypeOf(l.dow),
      hourBand: hourBandOf(l.hour),
      campaign: l.campaignId ?? UNATTRIBUTED,
    });
  }

  const converted = rows.filter((r) => r.converted).length;

  const dayLevels = ["weekday", "weekend"].map((key) =>
    compareLevel(key, DAY_TYPE_LABEL[key], rows, (j) => j.dayType === key),
  );
  const bandLevels = ["business", "evening", "overnight"].map((key) =>
    compareLevel(key, HOUR_BAND_LABEL[key], rows, (j) => j.hourBand === key),
  );

  const campaignKeys = [...new Set(rows.map((r) => r.campaign))].sort();
  const campaignLevels = campaignKeys
    .map((key) =>
      compareLevel(
        key,
        key === UNATTRIBUTED
          ? "Unattributed"
          : (opts.campaignNames?.[key] ?? key),
        rows,
        (j) => j.campaign === key,
      ),
    )
    // Biggest first: a campaign list is read top-down and the one carrying the
    // volume is the one worth arguing about.
    .sort((a, b) => b.leads - a.leads);

  const features: FeatureResult[] = (
    [
      ["day_type", dayLevels],
      ["hour_band", bandLevels],
      ["campaign", campaignLevels],
    ] as const
  ).map(([feature, levels]) => ({
    feature,
    label: FEATURE_LABEL[feature],
    levels,
    verdict: levels.some((l) => l.verdict === "better" || l.verdict === "worse")
      ? ("differs" as const)
      : levels.some((l) => l.verdict === "same")
        ? ("no_difference" as const)
        : ("not_enough" as const),
  }));

  const signals: QualitySignal[] = [];
  for (const f of features) {
    for (const l of f.levels) {
      if (l.verdict !== "better" && l.verdict !== "worse") continue;
      if (l.rate === null || l.restRate === null) continue;
      signals.push({
        feature: f.feature,
        key: l.key,
        label: l.label,
        direction: l.verdict,
        rate: l.rate,
        restRate: l.restRate,
        leads: l.leads,
        converted: l.converted,
      });
    }
  }
  /*
   * Largest gap first. A reader takes the top line as the finding, so the
   * ordering has to be by size of effect and not by which feature happened to
   * be declared first.
   */
  signals.sort(
    (a, b) => Math.abs(b.rate - b.restRate) - Math.abs(a.rate - a.restRate),
  );

  return {
    stage,
    features,
    signals,
    maturing,
    maturationDays,
    maturationMeasured: measured,
    judged: rows.length,
    converted,
    baseRate: rate(converted, rows.length),
  };
}

/** "Weekend leads booked 12% of the time, against 31% for the rest." */
export function describeSignal(s: QualitySignal, stage: OutcomeStage): string {
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  return `${s.label} leads ${OUTCOME_VERB[stage]} ${pct(s.rate)} of the time, against ${pct(s.restRate)} for the rest — ${s.converted} of ${s.leads} ${OUTCOME_NOUN[stage]}.`;
}
