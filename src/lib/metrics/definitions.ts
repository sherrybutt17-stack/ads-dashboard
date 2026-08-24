/**
 * What every metric on this dashboard actually means.
 *
 * The specific risk this defuses: BOOK %, SHOW % and CLOSE % sit in one row,
 * render in one style, and are divided by three DIFFERENT denominators —
 * appointments ÷ leads, shows ÷ appointments, wins ÷ shows. Nothing on screen
 * says so. A client reads "SHOW 62%" as "62% of my leads showed up", which is a
 * different and much better number than the truth, and the correction arrives
 * in a meeting rather than on the page.
 *
 * Every definition names its denominator explicitly, in words, because the
 * denominator is the part that gets assumed.
 *
 * `caveat` carries the thing that would otherwise be discovered by surprise —
 * counting rules, attribution limits, non-additive quantities. Where a metric
 * has no trap, it has no caveat; padding these would train people to skip them.
 */

export interface MetricDefinition {
  /** Plain-language statement of what the number is. */
  what: string;
  /** The arithmetic, denominator named. */
  formula: string;
  /** The thing that surprises people. Omitted where there is nothing to warn. */
  caveat?: string;
}

/**
 * Shared by every funnel-stage count. Two rules, both of which change the
 * number materially and neither of which is guessable from the label.
 */
const STAGE_COUNTING =
  "Counts distinct people ENTERING this stage during the period, so someone moved back and forth counts once. A person who reached this stage before the period started is not counted again.";

export const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  spend: {
    what: "What the ad platform charged over this period.",
    formula: "Sum of daily spend across every campaign in the account.",
    caveat:
      "Meta restates spend for up to 28 days as attribution windows fill, so recent days can still move.",
  },
  impressions: {
    what: "Times an ad was rendered on screen.",
    formula: "Sum of daily impressions.",
  },
  reach: {
    what: "Distinct people who saw an ad at least once.",
    formula: "Queried once for the whole period, directly from Meta.",
    caveat:
      "Reach is NOT additive — summing daily reach double-counts anyone who saw an ad on more than one day, typically overstating a month by 2–5×. That is why this figure is fetched per period rather than totalled.",
  },
  linkClicks: {
    what: "Clicks that opened the destination link.",
    formula: "Sum of daily link clicks, using the account's attribution setting.",
    caveat:
      "Lower than 'all clicks', which also counts likes, comments and profile taps.",
  },

  new_lead: {
    what: "People who became a lead in the CRM during this period.",
    formula: "Distinct paid leads entering the first pipeline stage.",
    caveat: `${STAGE_COUNTING} Only leads matching the paid-lead filter are included — see the note under the header for which ones those are.`,
  },
  contacted: {
    what: "Leads the team made contact with.",
    formula: "Distinct paid leads entering the contacted stage.",
    caveat: STAGE_COUNTING,
  },
  appointment_booked: {
    what: "Leads who booked an appointment.",
    formula: "Distinct paid leads entering the appointment-booked stage.",
    caveat: STAGE_COUNTING,
  },
  showed: {
    what: "Booked leads who actually turned up.",
    formula: "Distinct paid leads entering the showed stage.",
    caveat: STAGE_COUNTING,
  },
  no_show: {
    what: "Booked leads who did not turn up.",
    formula: "Distinct paid leads entering the no-show stage.",
    caveat: STAGE_COUNTING,
  },
  closed_won: {
    what: "Deals closed.",
    formula: "Distinct paid leads entering the closed-won stage.",
    caveat: STAGE_COUNTING,
  },
  lost: {
    what: "Prospects who did not convert.",
    formula: "Distinct paid leads entering the lost stage.",
    caveat: STAGE_COUNTING,
  },

  cpLead: {
    what: "What each new lead cost.",
    formula: "Ad spend ÷ new leads.",
    caveat:
      "Divides by leads the paid filter counts as paid, not by everyone in the pipeline — otherwise organic and referral leads would make the ads look cheaper than they are.",
  },
  cpAppt: {
    what: "What each booked appointment cost.",
    formula: "Ad spend ÷ appointments booked.",
  },
  cpShow: {
    what: "What each attended appointment cost.",
    formula: "Ad spend ÷ shows.",
  },
  cpWon: {
    what: "What each closed deal cost.",
    formula: "Ad spend ÷ closed-won deals.",
  },

  /*
   * The three that share a row and do not share a denominator.
   */
  bookPct: {
    what: "How many leads go on to book.",
    formula: "Appointments ÷ NEW LEADS.",
    caveat:
      "Denominator is leads. The three conversion rates on this page each divide by the stage before them, not by leads — compare them to each other with that in mind.",
  },
  showPct: {
    what: "How many booked appointments are actually attended.",
    formula: "Shows ÷ APPOINTMENTS.",
    caveat:
      "Denominator is appointments, NOT leads. This is not 'what share of leads showed up' — that figure is smaller.",
  },
  closePct: {
    what: "How many attended appointments turn into a sale.",
    formula: "Closed-won ÷ SHOWS.",
    caveat:
      "Denominator is shows, NOT leads or appointments. Of the three rates on this page it has the narrowest base, so it moves most on small numbers.",
  },
  /**
   * The funnel's between-stage figure. Same trap as the three above, in the one
   * place a reader is most likely to misread it: the percentages stacked down
   * the funnel each divide by the row above them, so they cannot be added or
   * compared to a share of leads.
   */
  funnelStep: {
    what: "The share of people at one stage who go on to reach the next one.",
    formula: "People entering the next stage ÷ people entering this one.",
    caveat:
      "Each percentage divides by the stage IMMEDIATELY above it, not by leads. They multiply rather than add — 50% then 50% means a quarter of leads reached the third stage, not all of them.",
  },
  optinPct: {
    what: "How many people who clicked the ad became a lead.",
    formula: "New leads ÷ link clicks.",
    caveat:
      "Spans two systems — clicks from the ad platform, leads from the CRM — so it is only meaningful once campaign attribution is flowing. A sharp fall here usually means the landing page, not the ads.",
  },

  ctr: {
    what: "How often seeing the ad led to a click.",
    formula: "Link clicks ÷ impressions.",
    caveat:
      "Computed from period totals, never by averaging daily rates — averaging would weight a $1 day the same as a $1,000 day.",
  },
  cpc: {
    what: "What each link click cost.",
    formula: "Ad spend ÷ link clicks.",
  },
  cpm: {
    what: "What a thousand impressions cost.",
    formula: "Ad spend ÷ impressions × 1,000.",
  },

  revenue: {
    what: "Value of deals closed in this period.",
    formula: "Sum of the deal value recorded in the CRM on closed-won deals.",
    caveat:
      "Only counts deals with a value actually entered. If deals are closed without one, this understates revenue and the tile says so rather than showing a confident zero.",
  },
  roas: {
    what: "Return on ad spend — revenue produced per currency unit spent.",
    formula: "Closed-won revenue ÷ ad spend.",
    caveat:
      "Attributed by when the deal CLOSED, not when the lead arrived. A deal closing this month may have come from last month's spend, so short windows read low on long sales cycles.",
  },
  avgDeal: {
    what: "Average value of a closed deal.",
    formula: "Revenue ÷ closed-won deals that have a value recorded.",
    caveat:
      "Deals closed with no value entered are excluded from both sides, so this is the average of what was actually recorded.",
  },
};

export function definitionFor(key: string): MetricDefinition | null {
  return METRIC_DEFINITIONS[key] ?? null;
}

/**
 * The metrics a REPORT actually puts in front of a reader, in reading order.
 *
 * ── Why this list is short, and why it is a list ──────────────────────
 *
 * In the app a definition is a tap on an ⓘ. A report is read on paper, in a
 * PDF, or in an email client — none of which can open a popover. So the report
 * carries its definitions as text, and the text has to be worth reading:
 * printing all 24 when the page shows six would train the reader to skip the
 * block, and the block exists precisely for the three or four entries that
 * change how a number should be understood.
 *
 * Hand-maintained rather than derived from the sections, because `dataKeys`
 * describes what a section LOADS and not what it displays. `report-glossary`'s
 * test asserts every key resolves and that the headline tiles are all covered,
 * so drift fails the build rather than quietly dropping a definition.
 */
export const REPORT_GLOSSARY: readonly string[] = [
  // The six headline tiles, in the order they appear.
  "spend",
  "new_lead",
  "cpLead",
  "appointment_booked",
  "showed",
  "closed_won",
  // The funnel's between-stage percentages — the single most misread figure on
  // the page, and the reason this module exists.
  "funnelStep",
];

/**
 * The heading each glossary entry appears under.
 *
 * 🔴 These must read EXACTLY as the labels printed on the report, not as
 * tidier names for the same things. A reader looking up "Closed / won" and
 * finding "Closed-won deals" has to decide whether they are the same metric,
 * and a glossary that provokes that question has failed at the one job it has.
 * `report-glossary.test.ts` checks them against the tile labels in the section
 * source, so a rename on either side fails the build.
 */
export const REPORT_GLOSSARY_LABEL: Record<string, string> = {
  spend: "Ad spend",
  new_lead: "New leads",
  cpLead: "Cost per lead",
  appointment_booked: "Appointments",
  showed: "Showed",
  closed_won: "Closed / won",
  funnelStep: "The percentages between funnel stages",
};
