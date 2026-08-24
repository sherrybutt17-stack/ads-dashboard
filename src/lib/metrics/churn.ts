import { poissonAtMost } from "./stats";

/**
 * Which client relationship is in trouble.
 *
 * Every reporting tool in this category shows performance. None of them says
 * *which account is about to leave* — and for an agency that is the only
 * question on the portfolio screen worth answering, because a client who churns
 * takes every future month with them.
 *
 * ---
 *
 * **🔴 There is no score, and there will not be one.**
 *
 * A churn *probability* would need a ledger of past churns to calibrate
 * against, and this system has never observed one. Any percentage would be
 * invented weights wearing a statistic's clothes — which is exactly the move
 * this product was built to replace, and it would be worse here than anywhere
 * else because the reader's response is to phone a real person.
 *
 * So the output is **observations**: named, measured, each carrying the two
 * numbers it was derived from. "Spend 2,400 → 900" is a fact a manager can act
 * on in three seconds and dismiss in one when it has an explanation they already
 * know. "71% churn risk" can be neither acted on nor dismissed.
 *
 * The severity tiers below come from a stated decision table over which signals
 * fired, not from a weighted sum. A person can audit it; a fitted model here
 * could not be audited by anybody, including me.
 *
 * ---
 *
 * **Three things live data forced.**
 *
 * **1 · The in-progress period must be excluded.** Blocks end at the client's
 * *yesterday*, never today. Comparing a part-finished period against complete
 * ones manufactures a decline for every client, every time, forever — the
 * defining bug of this kind of panel, and it looks exactly like a real finding.
 *
 * **2 · Weekly lead counts are too small to trend.** This deployment's live
 * client runs at 0–8 leads a week: the sequence 8, 4, 5, 1, 1, 0, 3, 1, 3, 2, 3,
 * 4, 7, 2, 3 contains several "three weeks of decline" and means nothing. Leads
 * are compared over 28-day blocks and tested against counting noise rather than
 * a percentage, because a 40% fall is meaningless at 5 and alarming at 500.
 *
 * **3 · A dead CRM pipe looks identical to collapsed demand.** If webhooks
 * stopped arriving, leads read as zero and every lead-based signal fires with
 * full confidence about nothing. The pipe is checked first and suppresses them —
 * and is itself reported, because a pipe that has been dead for weeks with
 * nobody noticing is its own kind of relationship problem.
 *
 * ---
 *
 * **What is deliberately NOT here: whether the client still logs in.**
 *
 * "They stopped opening their dashboard" would be the strongest signal on this
 * panel and no competitor could copy it, since per-client logins are unusual in
 * this category. It is not built because it currently has no data: checked
 * live, `user_clients` is empty and every `auth.login` audit row carries a null
 * `client_id`, so a login cannot be attributed to a client at all. Building it
 * would produce a signal that silently never fires, which is worse than its
 * absence. It becomes possible once client logins are actually issued and the
 * login audit row carries the client.
 */

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** One 7-day bucket. Oldest first; the last element is the most recent one. */
export interface ChurnWeek {
  spend: number;
  leads: number;
}

export interface ChurnInput {
  clientId: string;
  name: string;
  slug: string;
  currency: string;
  /**
   * `WEEKS` complete 7-day buckets ending at the client's yesterday, oldest
   * first. Never includes the day the page is being read on.
   */
  weeks: readonly ChurnWeek[];
  /** Days since the last webhook of any kind. Null when none has ever arrived. */
  daysSinceWebhook: number | null;
  /**
   * Days since this client's first sign of life — earliest ad-data day or first
   * webhook. Null when there has never been either.
   *
   * 🔴 Load-bearing. A client onboarded three weeks ago has empty older buckets,
   * which is arithmetically identical to a client who stopped spending. Without
   * this the panel would greet every new account with "they have turned it off".
   */
  firstActivityDaysAgo: number | null;
}

/* ------------------------------------------------------------------ *
 * Outputs
 * ------------------------------------------------------------------ */

export type ChurnSignalId =
  /** Spend has effectively gone to zero after being meaningful. */
  | "spend_stopped"
  /** Spend materially below the block before. A budget cut is a decision. */
  | "spend_down"
  /** Fewer leads than counting noise explains, while the money held up. */
  | "results_down"
  /** Real money spent, effectively no leads at all. Not a trend — a failure. */
  | "nothing_landing"
  /** No CRM events. Every lead figure below is unreliable, and nobody noticed. */
  | "pipe_dead";

export interface ChurnSignal {
  id: ChurnSignalId;
  /** The two numbers it was derived from — always rendered, never summarised. */
  recent: number;
  prior: number;
  /** Fractional change, or null when the prior period was zero. */
  change: number | null;
  /**
   * For `results_down` only: how likely a fall at least this large is if
   * nothing changed and leads are pure counting noise.
   */
  p?: number;
  /** For `spend_down`: spend fell in every one of the recent weeks as well. */
  everyWeek?: boolean;
  /** For `pipe_dead`: days since the last webhook, or null if never. */
  days?: number | null;
  /** For `nothing_landing`: the money that produced nothing. */
  spend?: number;
}

/**
 * `unknown` is not `none`, and the difference matters more than the rest of the
 * scale: "we cannot tell" printed as "nothing wrong" is how a silent failure
 * becomes a lost client.
 */
export type ChurnLevel = "none" | "watch" | "talk" | "unknown";

export interface ChurnClient {
  clientId: string;
  name: string;
  slug: string;
  currency: string;
  level: ChurnLevel;
  signals: ChurnSignal[];
  /** Why nothing could be judged, when `level` is `unknown`. */
  unknownReason: "too_new" | "no_activity" | null;
}

export interface ChurnReport {
  /** Only clients with something to say, worst first. */
  flagged: ChurnClient[];
  /** Clients checked and found unremarkable. */
  steady: number;
  /** Clients too new or too quiet to judge — counted, never called steady. */
  unknown: number;
  /** Days in each comparison block, for the copy. */
  blockDays: number;
}

/* ------------------------------------------------------------------ *
 * Thresholds
 * ------------------------------------------------------------------ */

/** Two 28-day blocks. See the header for why not weeks. */
export const WEEKS = 8;
const BLOCK_WEEKS = 4;
export const BLOCK_DAYS = BLOCK_WEEKS * 7;

/**
 * Below this in the prior block, a percentage change is arithmetic on a
 * rounding error. Matches the gate the insights engine needed for the same
 * reason: at small numbers every ratio is a headline.
 */
const MIN_SPEND_TO_JUDGE = 250;
/** Recent spend below this share of prior counts as stopped, not reduced. */
const STOPPED_SHARE = 0.1;
/** A real budget cut, as opposed to a fortnight with a bank holiday in it. */
const SPEND_DROP = 0.25;

/**
 * Leads are tested against counting noise, not a percentage.
 *
 * 🔴 The test treats lead arrivals as pure Poisson, which is optimistic — real
 * lead flow is lumpier than counting noise, because campaigns change and
 * seasons exist. So this p is a floor and the signal fires slightly more often
 * than it strictly should. That is the direction to be wrong in here: a false
 * flag costs somebody two minutes looking at an account, and a missed one costs
 * the account.
 */
const LEAD_FALL_P = 0.05;
/*
 * 🔴 There is deliberately no minimum-lead gate here, and the absence is the
 * argument for using a tail probability at all: the test gates itself.
 *
 * Even a total collapse to zero only clears the bar when the prior block held
 * more than ln(20) ≈ 3 leads, because P(0 | λ) = e^-λ. So a client running at
 * one or two leads a month can never trip this however badly the fortnight
 * went — which is exactly right, and needs no separate constant to enforce. One
 * was written; a mutation proved it could not change any outcome, so it is gone
 * and the reasoning is here instead.
 */
/** Spend must not have fallen much, or "same money, fewer leads" is not true. */
const SPEND_HELD = 0.85;

/** Real money in the recent block with essentially nothing to show for it. */
const NOTHING_LANDING_LEADS = 1;

/** No webhook for this long and the CRM pipe is not delivering. */
const PIPE_DEAD_DAYS = 7;

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Fractional change, or null when there is no base to change from. */
function change(recent: number, prior: number): number | null {
  return prior > 0 ? (recent - prior) / prior : null;
}

/**
 * The decision table. Stated, auditable, and deliberately not a weighted sum.
 *
 * `talk` is reserved for the two situations that are unambiguous on their own —
 * the client has switched the spend off, or is paying for nothing — plus the
 * conjunction where both directions are wrong at once. Everything else is
 * `watch`: worth knowing, not worth a phone call on its own.
 */
export function levelFor(signals: readonly ChurnSignal[]): ChurnLevel {
  const has = (id: ChurnSignalId) => signals.some((s) => s.id === id);
  if (signals.length === 0) return "none";
  if (has("spend_stopped") || has("nothing_landing")) return "talk";
  if (has("spend_down") && has("results_down")) return "talk";
  return "watch";
}

const RANK: Record<ChurnLevel, number> = { talk: 0, watch: 1, unknown: 2, none: 3 };

export function assessClient(input: ChurnInput): ChurnClient {
  const base = {
    clientId: input.clientId,
    name: input.name,
    slug: input.slug,
    currency: input.currency,
  };

  /*
   * Nothing has ever happened here, or it started too recently to have two
   * blocks to compare. Reported as unknown rather than steady — a brand new
   * client is not evidence of a healthy one, and an account with no activity at
   * all is a setup problem the health badge beside it already owns.
   */
  if (input.firstActivityDaysAgo === null) {
    return { ...base, level: "unknown", signals: [], unknownReason: "no_activity" };
  }
  if (input.firstActivityDaysAgo < WEEKS * 7) {
    return { ...base, level: "unknown", signals: [], unknownReason: "too_new" };
  }

  const weeks = input.weeks.slice(-WEEKS);
  /*
   * Fewer buckets than two full blocks. The client is old enough on paper, so
   * this is the loader having supplied a short series rather than a new
   * account — and half a block compared against a full one produces the same
   * manufactured decline as an unfinished week would.
   */
  if (weeks.length < WEEKS) {
    return { ...base, level: "unknown", signals: [], unknownReason: "too_new" };
  }
  const recentWeeks = weeks.slice(BLOCK_WEEKS);
  const priorWeeks = weeks.slice(0, BLOCK_WEEKS);

  const recentSpend = sum(recentWeeks.map((w) => w.spend));
  const priorSpend = sum(priorWeeks.map((w) => w.spend));
  const recentLeads = sum(recentWeeks.map((w) => w.leads));
  const priorLeads = sum(priorWeeks.map((w) => w.leads));

  const signals: ChurnSignal[] = [];

  /*
   * The pipe first, because everything about leads below is downstream of it.
   * A CRM that stopped delivering reads as demand collapsing, with exactly the
   * same numbers and none of the meaning.
   */
  const pipeDead =
    input.daysSinceWebhook === null || input.daysSinceWebhook >= PIPE_DEAD_DAYS;
  if (pipeDead) {
    signals.push({
      id: "pipe_dead",
      recent: recentLeads,
      prior: priorLeads,
      change: null,
      days: input.daysSinceWebhook,
    });
  }

  /* --- Money ---------------------------------------------------------- */

  if (priorSpend >= MIN_SPEND_TO_JUDGE) {
    if (recentSpend < priorSpend * STOPPED_SHARE) {
      signals.push({
        id: "spend_stopped",
        recent: recentSpend,
        prior: priorSpend,
        change: change(recentSpend, priorSpend),
      });
    } else if (recentSpend < priorSpend * (1 - SPEND_DROP)) {
      /*
       * Whether it also fell every single week is reported but never required.
       * Four consecutive falls is a much rarer thing than one step down and
       * reads very differently to a human — but demanding it would miss the
       * client who halved their budget in one go, which is the clearer decision
       * of the two.
       */
      // Four falls over four weeks, so the first recent week is compared to the
      // last prior one — otherwise "fell every week" would silently mean three.
      const run = [priorWeeks[priorWeeks.length - 1], ...recentWeeks];
      let everyWeek = true;
      for (let i = 1; i < run.length; i++) {
        if (run[i].spend >= run[i - 1].spend) everyWeek = false;
      }
      signals.push({
        id: "spend_down",
        recent: recentSpend,
        prior: priorSpend,
        change: change(recentSpend, priorSpend),
        everyWeek,
      });
    }
  }

  /* --- Results, only if the lead numbers can be believed --------------- */

  if (!pipeDead) {
    if (recentSpend >= MIN_SPEND_TO_JUDGE && recentLeads < NOTHING_LANDING_LEADS) {
      // Not a trend and not a comparison: real money went out and nothing came
      // back. The one signal that needs no history at all to be alarming.
      signals.push({
        id: "nothing_landing",
        recent: recentLeads,
        prior: priorLeads,
        change: null,
        spend: recentSpend,
      });
    } else if (recentSpend >= priorSpend * SPEND_HELD) {
      const p = poissonAtMost(recentLeads, priorLeads);
      if (p < LEAD_FALL_P) {
        signals.push({
          id: "results_down",
          recent: recentLeads,
          prior: priorLeads,
          change: change(recentLeads, priorLeads),
          p,
        });
      }
    }
  }

  return { ...base, level: levelFor(signals), signals, unknownReason: null };
}

export function buildChurn(inputs: readonly ChurnInput[]): ChurnReport {
  const assessed = inputs.map(assessClient);

  const flagged = assessed
    .filter((c) => c.level === "talk" || c.level === "watch")
    .sort((a, b) => {
      const r = RANK[a.level] - RANK[b.level];
      if (r !== 0) return r;
      /*
       * Then by how many separate things are off — and that is all it is. More
       * independent problems is a weak ordering, not a risk model, and the copy
       * says so rather than letting a position in a list imply a ranking.
       */
      const n = b.signals.length - a.signals.length;
      if (n !== 0) return n;
      return a.name < b.name ? -1 : 1;
    });

  return {
    flagged,
    steady: assessed.filter((c) => c.level === "none").length,
    unknown: assessed.filter((c) => c.level === "unknown").length,
    blockDays: BLOCK_DAYS,
  };
}
