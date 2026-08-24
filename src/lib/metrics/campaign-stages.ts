import { costPer } from "./compute";
import type { CanonicalStage } from "@/lib/stages";
import type { AdPlatform } from "@/lib/metrics/queries";

/**
 * Cost per appointment, show and close — per campaign.
 *
 * The dashboard has always divided spend by *leads* per campaign, and that is
 * the number that gets a working campaign switched off. A campaign producing
 * leads at $40 against an account average of $90 is the obvious winner on every
 * screen in this category; if none of those leads ever books, it is the most
 * expensive thing in the account and nothing here could show it.
 *
 * The counts come from the stage-transition ledger, which is the asset no
 * competitor has — Motion, Atria and Foreplay have no CRM, so "which campaign
 * produced customers" is not a question they can be asked.
 *
 * ---
 *
 * TWO THINGS THAT MAKE A DEEP-STAGE COST LIE, BOTH HANDLED HERE
 *
 * **1 · The sample.** At these volumes a campaign's closes are a single digit,
 * and "$1,345 per closed deal" from one deal is not a rate, it is one deal. The
 * plan's rule is explicit and it is the right one: do NOT suppress the figure —
 * a tool that shows "3 of 7" instead of a percentage looks like it knows less
 * than it does. Show the cost **and the count it came from**, always, so the
 * reader can weigh it themselves. `CostAtStage` cannot be constructed without
 * its denominator.
 *
 * **2 · 🔴 The numerator and denominator describe different weeks.** A deal
 * closed this month came from a lead generated weeks earlier, against spend
 * from weeks earlier. Cost per lead barely notices this — leads arrive the same
 * day as the click — but cost per close divides *this* period's spend by
 * conversions that *earlier* spend bought, and the gap widens with every stage.
 * That is not a rounding error: for a business with a 40-day sales cycle, a
 * month where spend doubled shows cost per close doubling too, for no reason
 * connected to the advertising. The lag is measured rather than hand-waved —
 * see `StageLag` — and stated in days next to the number it distorts.
 */

/** Stages a per-campaign cost is worth computing for, shallowest first. */
export const COST_STAGES = [
  "new_lead",
  "appointment_booked",
  "showed",
  "closed_won",
] as const;

export type CostStage = (typeof COST_STAGES)[number];

export const STAGE_LABEL: Record<CostStage, string> = {
  new_lead: "Leads",
  appointment_booked: "Appointments",
  showed: "Shows",
  closed_won: "Closed",
};

/**
 * The plural noun for prose, which is not the column label.
 *
 * "Which campaign brought the closed" is what reusing the column heading gets
 * you — a table header has to be short and a sentence has to be a sentence.
 */
export const STAGE_NOUN: Record<CostStage, string> = {
  new_lead: "leads",
  appointment_booked: "appointments",
  showed: "shows",
  closed_won: "closed deals",
};

/** The cost column's heading for each stage — what the sheet called CP-*. */
export const STAGE_COST_LABEL: Record<CostStage, string> = {
  new_lead: "CP-Lead",
  appointment_booked: "CP-Appt",
  showed: "CP-Show",
  closed_won: "CP-Won",
};

/**
 * A cost and the conversions it was computed from, inseparably.
 *
 * The pairing is the design. A number on its own invites "our cost per close is
 * $1,345"; the same number beside "1 deal" invites "we have one deal, so this
 * is one deal". Both are in the object because the second must never be
 * optional at the call site.
 */
export interface CostAtStage {
  /** Null where undefined — no conversions, or conversions against no spend. */
  cost: number | null;
  conversions: number;
}

export interface CampaignStageRow {
  campaignId: string;
  campaignName: string;
  platform: AdPlatform;
  spend: number;
  impressions: number;
  linkClicks: number;
  /** Ledger counts for this campaign, paid-filtered, for the window. */
  counts: Record<CostStage, number>;
  costs: Record<CostStage, CostAtStage>;
}

export interface StageOption {
  stage: CostStage;
  label: string;
  /** Plural noun for prose — "closed deals", not "Closed". */
  noun: string;
  costLabel: string;
  /** Across every campaign. */
  total: number;
  /**
   * Median days from a lead arriving to reaching this stage, or null when too
   * few reached it to say. Zero for `new_lead` by definition.
   */
  lagDays: number | null;
  /**
   * Why this stage shows nothing, when it shows nothing.
   *
   * 🔴 Two different causes, never merged: nobody reached the stage, or the
   * stage was never mapped to a GHL stage so nothing could ever be recorded
   * against it. The second is a broken configuration reading as a business
   * result, which is exactly the failure this product replaced.
   */
  emptyReason: string | null;
}

export interface CampaignStages {
  rows: CampaignStageRow[];
  options: StageOption[];
  /** Deepest stage with any conversions — the sensible default to show. */
  defaultStage: CostStage;
}

/** Median days from lead to each deeper stage, measured over the window. */
export type StageLag = Partial<Record<CostStage, number | null>>;

const EMPTY_COUNTS: Record<CostStage, number> = {
  new_lead: 0,
  appointment_booked: 0,
  showed: 0,
  closed_won: 0,
};

export interface CampaignInput {
  campaignId: string;
  campaignName: string;
  platform: AdPlatform;
  spend: number;
  impressions: number;
  linkClicks: number;
}

export function buildCampaignStages(
  campaigns: readonly CampaignInput[],
  funnelByCampaign: ReadonlyMap<string, Partial<Record<CanonicalStage, number>>>,
  opts: {
    /** Canonical stages that have at least one GHL stage bound to them. */
    mappedStages: ReadonlySet<CanonicalStage>;
    lag: StageLag;
  },
): CampaignStages {
  const rows: CampaignStageRow[] = campaigns.map((c) => {
    const funnel = funnelByCampaign.get(c.campaignId) ?? {};
    const counts: Record<CostStage, number> = { ...EMPTY_COUNTS };
    const costs = {} as Record<CostStage, CostAtStage>;

    for (const stage of COST_STAGES) {
      const n = funnel[stage] ?? 0;
      counts[stage] = n;
      /*
       * `costPer`, not plain division: spend of zero against conversions that
       * happened returns null rather than "$0.00 each". That exact figure —
       * free appointments — is what the source spreadsheet printed for
       * May–June 2026 and what this product exists to stop reprinting.
       */
      costs[stage] = { cost: costPer(c.spend, n), conversions: n };
    }

    return {
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      platform: c.platform,
      spend: c.spend,
      impressions: c.impressions,
      linkClicks: c.linkClicks,
      counts,
      costs,
    };
  });

  const options: StageOption[] = COST_STAGES.map((stage) => {
    const total = rows.reduce((s, r) => s + r.counts[stage], 0);
    const mapped = opts.mappedStages.has(stage);
    return {
      stage,
      label: STAGE_LABEL[stage],
      noun: STAGE_NOUN[stage],
      costLabel: STAGE_COST_LABEL[stage],
      total,
      lagDays: stage === "new_lead" ? 0 : (opts.lag[stage] ?? null),
      emptyReason:
        total > 0
          ? null
          : mapped
            ? `No ${STAGE_NOUN[stage]} were recorded in this period.`
            : `No GHL stage is mapped to “${STAGE_LABEL[stage].toLowerCase()}”, so nothing can be counted here whatever happened.`,
    };
  });

  /*
   * The deepest stage that actually has conversions.
   *
   * Opening on `Closed` when nothing has closed would greet every reader with
   * an empty column; opening on `Leads` when the account has closes buries the
   * one number that answers whether the advertising is working. So: as deep as
   * the data supports, and no deeper.
   */
  const withData = [...options].reverse().find((o) => o.total > 0);

  return { rows, options, defaultStage: withData?.stage ?? "new_lead" };
}
