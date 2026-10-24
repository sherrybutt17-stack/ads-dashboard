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

  /*
   * Board stats (src/lib/board/catalog.ts). Each has a widget someone can put on
   * a client's board, so each needs the same "what does this mean" as the
   * Overview's own tiles.
   */
  clicks: {
    what: "Clicks the ad platform recorded on the ads.",
    formula: "Sum of daily clicks reported by Google or TikTok.",
  },
  clicksAll: {
    what: "Every click on an ad — links, likes, comments, profile taps and expanding the ad.",
    formula: "Sum of daily 'clicks (all)' reported by Meta.",
    caveat: "Higher than link clicks. Use link clicks for anything about traffic to the website.",
  },
  fbLeads: {
    what: "Leads as Meta counts them — form submissions and pixel lead events it attributes to the ads.",
    formula: "Sum of Meta's daily lead count (all lead types, counted once).",
    caveat:
      "Meta's own attribution, not the CRM. It can be higher or lower than CRM leads; the CRM figure is the one the funnel and cost per lead use.",
  },
  cpFbLead: {
    what: "What each lead cost, by Meta's own lead count.",
    formula: "Ad spend ÷ Meta-reported leads.",
    caveat: "Uses Meta's attribution, so it can differ from the cost per lead calculated from the CRM.",
  },
  fbLeadsOnsite: {
    what: "Leads from Meta's Instant Forms — forms people submitted without leaving Facebook or Instagram.",
    formula: "Sum of Meta's daily on-Facebook lead count.",
    caveat:
      "Meta's own attribution, across every campaign — so it can be higher than Results, which count only what each campaign optimises for. Not the CRM's count.",
  },
  cpFbLeadOnsite: {
    what: "What each on-Facebook (Instant Form) lead cost.",
    formula: "Ad spend ÷ on-Facebook leads.",
    caveat:
      "Divides ALL the spend in the row by these leads, including spend on campaigns after other results. Meta's attribution, not the CRM.",
  },
  fbLeadsPixel: {
    what: "Leads the Meta pixel recorded on the client's website and credited to the ads.",
    formula: "Sum of Meta's daily website (pixel) lead count.",
    caveat:
      "Only appears if the website sends lead events to Meta. Meta's own attribution, across every campaign, so it can differ from Results and from the CRM.",
  },
  cpFbLeadPixel: {
    what: "What each website (pixel) lead cost.",
    formula: "Ad spend ÷ website leads.",
    caveat: "Divides ALL the spend in the row by these leads. Meta's attribution, not the CRM.",
  },
  ctrAll: {
    what: "How often an ad was clicked anywhere — the link, the profile, a reaction, 'see more'.",
    formula: "Clicks (all) ÷ impressions, as Ads Manager's 'CTR (all)'.",
    caveat: "Higher than the link CTR. Use the link CTR for anything about traffic to the website.",
  },
  cpcAll: {
    what: "What each click of any kind cost.",
    formula: "Ad spend ÷ clicks (all), as Ads Manager's 'CPC (all)'.",
    caveat: "Lower than the cost per link click, because every kind of click counts.",
  },
  landRate: {
    what: "Of the people who clicked the link, how many waited for the page to load.",
    formula: "Landing page views ÷ link clicks.",
    caveat: "A low land rate usually means a slow page or accidental clicks, not a weak ad.",
  },
  results: {
    what: "What the ad platform counts as the campaigns' results — whatever each campaign is set to get: website leads, calls, messages, landing page views. On Google, its Conversions column.",
    formula: "Sum of the platform's daily results of the type shown, exactly as its Ads Manager reports them.",
    caveat:
      "Results of different types are never added together; the tile shows the type most spend went to and names the others. The platform's own attribution, so it can differ from the CRM's leads.",
  },
  cpResult: {
    what: "What each result cost, as the platform's Ads Manager shows it.",
    formula: "Spend on the campaigns getting this kind of result ÷ those results.",
    caveat:
      "Spend on campaigns optimising for a different kind of result is left out, so it matches Ads Manager's cost per result rather than spend ÷ every result.",
  },
  googleConversions: {
    what: "Conversions as Google Ads counts them — the actions set as primary goals in the account.",
    formula: "Sum of Google's daily Conversions column.",
    caveat:
      "Google can report fractions of a conversion when it shares credit between ads, so this may not be a whole number. Google's attribution, not the CRM.",
  },
  cpConversion: {
    what: "What each conversion cost, as Google Ads shows it.",
    formula: "Spend ÷ conversions.",
    caveat: "Uses Google's own conversion count, so it can differ from the CRM's cost per lead.",
  },
  frequency: {
    what: "How many times the average person saw an ad.",
    formula: "Impressions ÷ reach, both for the whole range, as Meta reports it.",
    caveat:
      "Like reach, it is NOT additive — it is fetched once for the whole range, never averaged across days.",
  },
  landingPageViews: {
    what: "Link clicks where the landing page actually finished loading.",
    formula: "Sum of Meta's daily landing page views.",
    caveat: "Lower than link clicks: people who click and leave before the page loads are not counted.",
  },
  video3sViews: {
    what: "Times a video ad was watched for at least three seconds.",
    formula: "Sum of Meta's daily 3-second video plays.",
  },
  hookRate: {
    what: "How often a video stopped the scroll.",
    formula: "3-second video plays ÷ impressions, from ad-level figures.",
    caveat: "Only meaningful for video ads; image ads have no hook rate and show a dash.",
  },
  holdRate: {
    what: "Of the people a video hooked, how many kept watching.",
    formula: "ThruPlays ÷ 3-second video plays, from ad-level figures.",
    caveat:
      "Not comparable across video lengths: under 15 seconds a ThruPlay means watched to the end, from 15 seconds on it means reached 15 seconds. Image ads show a dash.",
  },
  thruPlays: {
    what: "Times a video was watched to the end, or for at least 15 seconds.",
    formula: "Sum of Meta's daily ThruPlays, from ad-level figures.",
    caveat: "Meta only reports ThruPlays per ad, so this starts when ad-level syncing began.",
  },
  postReactions: {
    what: "Likes and other reactions on the ads' posts.",
    formula: "Sum of Meta's daily 'post reaction' actions.",
  },
  postComments: {
    what: "Comments on the ads' posts.",
    formula: "Sum of Meta's daily 'comment' actions.",
  },
  postShares: {
    what: "Times the ads' posts were shared.",
    formula: "Sum of Meta's daily 'post share' actions.",
  },
  postSaves: {
    what: "Times the ads' posts were saved.",
    formula: "Sum of Meta's daily 'post save' actions.",
  },
  pageLikes: {
    what: "Page likes Meta attributes to the ads.",
    formula: "Sum of Meta's daily 'page like' actions.",
  },
  postEngagement: {
    what: "All engagement on the ads' posts — reactions, comments, shares, clicks and plays.",
    formula: "Sum of Meta's daily 'post engagement' actions.",
    caveat: "Includes the reactions, comments and shares shown separately, so never add them together.",
  },
  purchases: {
    what: "Website purchases Meta tracked from the ads.",
    formula: "Sum of Meta's daily purchase events, one purchase type per day.",
    caveat:
      "Only appears if the client's website sends purchases to Meta. Meta reports one purchase under several overlapping types; they are never added together.",
  },
  cpPurchase: {
    what: "What each tracked purchase cost.",
    formula: "Ad spend ÷ website purchases.",
  },
  new_lead_qualified: {
    what: "New leads, leaving out the ones marked disqualified.",
    formula: "New leads in the range that have never been moved to Disqualified.",
    caveat: "Only differs from leads when junk leads are being marked as disqualified in the CRM.",
  },
};

export function definitionFor(key: string): MetricDefinition | null {
  return METRIC_DEFINITIONS[key] ?? null;
}

/**
 * The Reports tab's four tables count stages as "reached this stage or further"
 * (`StageCounting` in `queries.ts`), so their column definitions for those
 * stages must say so. Everywhere else keeps `METRIC_DEFINITIONS`.
 *
 * Static text — `queries.ts` pulls in the database and this module is imported
 * by client components — so `definitions.test.ts` holds the two in step.
 */
const REACHED_COUNTING =
  "Counts each lead once, in the period they FIRST got at least this far — this stage or any later one. A lead moved straight from New Lead to Appointment Booked still counts as contacted here. (The Overview tab counts only leads entering this exact stage, so its figures can be lower.)";

export const REPORT_TABLE_DEFINITIONS: Record<string, MetricDefinition> = {
  contacted: {
    what: "Leads the team got at least as far as contacting.",
    formula:
      "Distinct paid leads first reaching Contacted or any later stage: Appointment Booked, Showed, No Show or Closed / Won.",
    caveat: REACHED_COUNTING,
  },
  appointment_booked: {
    what: "Leads who got at least as far as booking an appointment.",
    formula:
      "Distinct paid leads first reaching Appointment Booked or any later stage: Showed, No Show or Closed / Won.",
    caveat: REACHED_COUNTING,
  },
  showed: {
    what: "Booked leads who got at least as far as turning up.",
    formula: "Distinct paid leads first reaching Showed or Closed / Won.",
    caveat: REACHED_COUNTING,
  },
  closed_won: {
    what: "Deals closed.",
    formula: "Distinct paid leads first reaching Closed / Won.",
    caveat: REACHED_COUNTING,
  },
};

/** Column definitions for the Reports tab's tables. */
export function reportTableDefinitionFor(key: string): MetricDefinition | null {
  return REPORT_TABLE_DEFINITIONS[key] ?? definitionFor(key);
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
  // The ad platform's own results, after them — the two can differ from the CRM's leads.
  "results",
  "cpResult",
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
  results: "Results",
  cpResult: "Cost per result",
  appointment_booked: "Appointments",
  showed: "Showed",
  closed_won: "Closed / won",
  funnelStep: "The percentages between funnel stages",
};
