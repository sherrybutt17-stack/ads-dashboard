/**
 * The dashboard's sections, as data.
 *
 * Pure — no JSX, no imports from the component tree — so it can be read by the
 * renderer, by a settings UI, and by tests without pulling React in. The
 * matching `renderSection` lives in `sections.tsx`.
 *
 * This exists because the page was a single hardcoded 987-line JSX tree, and
 * every feature that adds a section (creative reporting, breakdowns, campaign
 * detail) made the next one more expensive. Ordering and visibility are now a
 * list you can map over rather than a diff through a wall of markup.
 *
 * Deliberately NOT included: persistence, an API, a proxy change, per-user
 * layouts. This is the shape change on its own, verified to render byte-identical
 * output. What it buys later — a stored layout, a settings drawer — becomes a
 * jsonb column and a checkbox list rather than a rewrite.
 *
 * Also deliberately not included: a `span` / column field. After the funnel was
 * promoted to full width, every section on this page is full width, so there is
 * no pairing to compute — which removes the failure the customization design
 * warned about, where hiding one section silently doubled another's width.
 */

/**
 * Which window a section actually describes. **The load-bearing field.**
 *
 * The date picker sits at the top of the page and visibly does nothing for most
 * of what is below it, with no indication of that anywhere:
 *
 * - the four report tables are FIXED trailing windows by design, and
 * - the pipeline explorer is a snapshot of every paid lead's CURRENT stage,
 *   with no date filter at all — `getPipelineDistribution` and `getLeads` take
 *   no range argument.
 *
 * So a reader who selects "last 7 days" and then scrolls to a pipeline showing
 * 700 leads has been misled by the interface, not by the data. Every section
 * whose cadence is not `range` renders a badge saying what it really covers.
 */
export type SectionCadence =
  | "range"
  | "fixed_windows"
  | "all_time"
  | "month"
  | "current_month";

export const CADENCE_LABEL: Record<SectionCadence, string | null> = {
  range: null, // follows the picker; no badge needed
  fixed_windows: "Fixed windows",
  all_time: "All time",
  month: "By month",
  current_month: "This month",
};

export const CADENCE_HINT: Record<SectionCadence, string | null> = {
  range: null,
  fixed_windows:
    "Trailing windows of a fixed length. Not affected by the date range selected above.",
  all_time:
    "Where every paid lead sits right now, across all time. Not affected by the date range selected above.",
  month:
    "Written and read one calendar month at a time, with its own month picker. Not affected by the date range selected above.",
  /*
   * Distinct from `month`, which has its own picker. This one is pinned to the
   * calendar month in progress and has no picker at all — a projection of a
   * month that has already ended is not a projection.
   */
  current_month:
    "The calendar month currently in progress. Not affected by the date range selected above.",
};

export interface SectionDef {
  id: SectionId;
  /** Name shown in a settings list. Not necessarily the on-page heading. */
  label: string;
  /** One line explaining what the section answers. */
  description: string;
  defaultOrder: number;
  defaultVisible: boolean;
  cadence: SectionCadence;
  /**
   * Which pieces of `DashboardData` this section reads.
   *
   * Not decorative: it is what makes selective loading possible later without
   * re-deriving the dependency graph by hand, and it documents why a section
   * cannot simply be dropped from the query set — `campaigns`, for instance, is
   * read by the pipeline explorer for campaign NAMES even when the campaign
   * table itself is hidden.
   */
  dataKeys: readonly string[];
  /**
   * Cannot be hidden. The lead-source note and the headline numbers are how a
   * reader knows WHICH leads these figures describe; a dashboard that can be
   * configured to omit that is the silent-omission failure this product exists
   * to prevent.
   */
  required?: boolean;
  /**
   * 🔴 This section renders individual people — names, emails, phone numbers.
   *
   * Marked so that surfaces reachable WITHOUT a login can be checked against
   * it. A share link is a bearer URL that travels by email and cannot be
   * recalled; a board pack does not need forty leads' contact details to answer
   * "is the money working?".
   */
  containsLeadPii?: true;
  /**
   * Only the agency sees this. Filtered out of the rendered page AND out of the
   * customise drawer for a client-role session.
   *
   * A field rather than a `staff &&` inside the renderer, because the drawer
   * reads the registry too — gating only at render time would show a client a
   * checkbox for a section that never appears however they set it.
   */
  staffOnly?: true;
  /**
   * Which tab this section lives under.
   *
   * 🔴 The reason tabs exist: twenty-six sections rendered as one continuous
   * scroll, which is the same undifferentiated wall the 158-column spreadsheet
   * presented — and it fails the same way. Nobody notices a block is empty when
   * there are twenty-five others below it.
   *
   * Grouping also makes the page fast rather than merely tidier. `loading.ts`
   * already skips the queries for sections that are not shown, so rendering one
   * tab runs one tab's queries: the dashboard was issuing every query on every
   * load and taking 4–6 seconds to do it.
   */
  group: SectionGroup;
}

export type SectionGroup = "overview" | "ads" | "leads" | "reports";

/**
 * Tab order and labels.
 *
 * Named for the question each answers rather than the data it holds — "Ads"
 * over "Meta metrics" — because the reader arrives with a question, not a
 * schema.
 */
export const SECTION_GROUPS: readonly {
  id: SectionGroup;
  label: string;
  blurb: string;
}[] = [
  { id: "overview", label: "Overview", blurb: "What happened, and where it is heading" },
  { id: "ads", label: "Ads", blurb: "Where the money went and what it bought" },
  { id: "leads", label: "Leads", blurb: "What happened after the click" },
  { id: "reports", label: "Reports", blurb: "Written summaries and the tables" },
];

export function isSectionGroup(v: unknown): v is SectionGroup {
  return SECTION_GROUPS.some((g) => g.id === v);
}

export function parseSectionGroup(v: unknown): SectionGroup {
  return isSectionGroup(v) ? v : "overview";
}

export type SectionId =
  | "lead_filter_note"
  | "insights"
  | "anomalies"
  | "weekly_summary"
  | "commentary"
  | "kpis"
  | "funnel"
  | "trend"
  | "campaigns"
  | "keep_kill"
  | "creatives"
  | "creative_fatigue"
  | "breakdowns"
  | "speed_to_lead"
  | "speed_outcome"
  | "forecast"
  | "budget_pacing"
  | "budget_delivery"
  | "duplicates"
  | "call_timing"
  | "lead_quality"
  | "aging"
  | "uncalled"
  | "maturation"
  | "channels"
  | "pipeline"
  | "heatmap"
  | "report_tables";

export const SECTIONS: readonly SectionDef[] = [
  {
    id: "lead_filter_note",
    group: "overview",
    label: "Lead source note",
    description: "Which leads these numbers count, and which are excluded.",
    defaultOrder: 10,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["leadFilter"],
    required: true,
  },
  {
    id: "insights",
    group: "overview",
    label: "What changed",
    description: "Plain-English headlines derived from the period-over-period deltas.",
    defaultOrder: 20,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["deltas", "current", "previous"],
  },
  {
    id: "anomalies",
    group: "overview",
    label: "Unusual days",
    description:
      "Individual days that sat far outside this account's own normal — the thing a period-over-period comparison averages away.",
    // Directly beneath "What changed", which reads the same range at period
    // level. The two answer the same question at two resolutions, and they are
    // read together or not at all.
    defaultOrder: 25,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["anomalies"],
  },
  {
    id: "weekly_summary",
    group: "reports",
    label: "Written summary",
    description:
      "A drafted update for this period, in four framings — edited by a person, published deliberately.",
    // Above the numbers, because it is written by reading them and the reader
    // of a report meets the words first.
    defaultOrder: 27,
    defaultVisible: true,
    cadence: "range",
    dataKeys: [],
    staffOnly: true,
  },
  {
    id: "commentary",
    group: "reports",
    label: "Monthly commentary",
    description:
      "What we did and what happens next, written per calendar month — and last month's plan answered against this month's figures.",
    // Directly under the written summary: both are prose the agency writes by
    // reading the numbers, and they are edited in the same sitting.
    defaultOrder: 28,
    defaultVisible: true,
    /*
     * `month`, not `range`. Every other cadence on this dashboard follows the
     * date picker; this one deliberately does not, because a promise attached
     * to "the trailing 30 days" cannot be found again a month later. The
     * cadence label is what tells a reader the panel is ignoring their range on
     * purpose rather than by mistake.
     */
    cadence: "month",
    dataKeys: [],
    staffOnly: true,
  },
  {
    id: "kpis",
    group: "overview",
    label: "Headline metrics",
    description: "Spend, leads, cost per lead, appointments, shows, wins, revenue, ROAS.",
    defaultOrder: 30,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["current", "deltas", "daily"],
    required: true,
  },
  {
    id: "budget_delivery",
    group: "reports",
    label: "Budget delivery",
    description:
      "Whether the agreed monthly budget was actually placed, for the last twelve months.",
    /*
     * Under Reports rather than beside the pacing panel in Overview: pacing is
     * a decision with a deadline and belongs high on the page, while this is
     * the record in arrears — the thing read at a renewal, not on a Tuesday.
     */
    defaultOrder: 45,
    defaultVisible: true,
    // Twelve trailing calendar months, like the report tables and channel mix —
    // it answers a question about the year, not about the selected range.
    cadence: "fixed_windows",
    dataKeys: ["budgetHistory"],
    /* Same reasoning as `budget_pacing`: a budget is a commercial term. */
    staffOnly: true,
  },
  {
    id: "budget_pacing",
    group: "overview",
    label: "Budget pacing",
    description:
      "Spend against the monthly budget the client agreed, with the projected month-end and what to spend per day to land on it.",
    /*
     * Immediately before the forecast, which it reuses: this panel is the
     * decision ("are we spending the right amount?") and the forecast is the
     * detail behind it. Both are about the calendar month, so they read as one
     * block rather than being separated by a range-scoped section.
     */
    defaultOrder: 29,
    defaultVisible: true,
    cadence: "current_month",
    dataKeys: ["pacing"],
    /*
     * Staff only. A budget is a commercial term between the agency and the
     * client, and the variance against it is an agency-side conversation — a
     * client reading "underspending by £1,200" on their own dashboard is a
     * conversation the agency should be having, not one a panel should start.
     */
    staffOnly: true,
  },
  {
    id: "forecast",
    group: "overview",
    label: "Where this month lands",
    description:
      "Projected spend and leads for the calendar month in progress, weighted by weekday, with an 80% range.",
    /*
     * Between "unusual days" and the funnel: the panels above are all about
     * what has happened, and this is the first one about what has not. It sits
     * high because budget pacing is a decision with a deadline — knowing on the
     * 12th is worth something, knowing on the 30th is worth nothing.
     */
    defaultOrder: 30,
    defaultVisible: true,
    cadence: "current_month",
    dataKeys: ["forecast"],
  },
  {
    id: "duplicates",
    group: "leads",
    label: "The same person, more than once",
    description:
      "Leads sharing a phone number or email — and how much of the book can be checked at all.",
    /*
     * Directly under the lead-quality work rather than beside the KPI row. It
     * is a data-integrity finding, and putting a "your lead count is inflated"
     * card at the top would make it the headline of every dashboard on a book
     * where only one lead in eight can even be checked.
     */
    defaultOrder: 78,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["duplicates", "current"],
    /*
     * Renders names, phone numbers and email addresses — it has to, since the
     * matched value is what lets a reader dismiss a false positive without
     * opening two GHL records. That makes it exactly the kind of section a
     * share link must not carry.
     */
    containsLeadPii: true,
  },
  {
    id: "funnel",
    group: "overview",
    label: "Funnel",
    description:
      "Where people are lost between stages — the view no CRM-less competitor can build.",
    defaultOrder: 40,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["funnel", "current"],
  },
  {
    id: "trend",
    group: "overview",
    label: "Spend and leads over time",
    description: "Two stacked panels sharing a timeline, with the previous period ghosted.",
    defaultOrder: 50,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["daily", "prevDaily", "annotations"],
  },
  {
    id: "campaigns",
    group: "ads",
    label: "Campaign breakdown",
    description: "Ad spend joined to CRM leads, per campaign.",
    defaultOrder: 60,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["campaigns"],
  },
  {
    id: "keep_kill",
    group: "ads",
    label: "Keep or stop",
    description:
      "Which campaigns are far enough from the rest of the account to act on, with the confidence behind each call.",
    // Directly under the campaign table: the table says what each did, this
    // says what to do about it, and they are read as one thought.
    defaultOrder: 62,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["keepKill"],
    // Agency-facing. A client reading "consider stopping" without the context
    // of what else is running turns a recommendation into an instruction.
    staffOnly: true,
  },
  {
    id: "creatives",
    group: "ads",
    label: "Creative performance",
    description:
      "Which image or video is working, grouped by asset rather than by ad id.",
    // Immediately after campaigns: "which campaign" and "which creative" are the
    // same question at two depths, and reading them together is how a decision
    // gets made.
    defaultOrder: 65,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["creatives", "creativeLeads", "adLevelSynced"],
  },
  {
    id: "creative_fatigue",
    group: "ads",
    label: "Creative fatigue",
    description:
      "Creatives performing measurably worse than they used to, judged against their own history.",
    // Directly under the creative grid, for the same reason keep/kill sits under
    // the campaign table: the grid says which asset is working now, this says
    // which one is on its way out, and the pair is one thought.
    defaultOrder: 66,
    defaultVisible: true,
    /*
     * `fixed`, not `range`. The engine reads its own trailing span — see
     * `FATIGUE_DAYS` — because "has this stopped working" is a question about
     * the creative's history, and a viewer switching to a 7-day range has not
     * changed the answer, only their ability to see it. Labelled so nobody
     * reads the panel as describing the selected dates.
     */
    cadence: "fixed_windows",
    dataKeys: ["fatigue", "adLevelSynced"],
  },
  {
    id: "breakdowns",
    group: "ads",
    label: "Where the money went",
    description:
      "Spend by region, placement, device, age and gender — including the share Meta withholds.",
    // After creatives: "which ad" then "who saw it" is the order the questions
    // actually get asked in.
    defaultOrder: 67,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["breakdowns"],
  },
  {
    id: "speed_to_lead",
    group: "leads",
    label: "Speed to lead",
    description: "Time from a new lead arriving to the first outbound call.",
    defaultOrder: 70,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["speedToLead"],
  },
  {
    id: "speed_outcome",
    group: "leads",
    label: "Speed to lead vs outcome",
    description:
      "Whether leads answered faster actually booked, showed and closed more often.",
    // Immediately under speed-to-lead: that panel says how fast you answered,
    // this one says whether it mattered. Read apart they are two half-answers.
    defaultOrder: 72,
    defaultVisible: true,
    /*
     * `range` — the cohort is the leads that ARRIVED in the selected range. But
     * their outcomes are followed forward out of it, which is deliberately not
     * what the badge system can express, so the panel states it in prose
     * instead: a lead that arrived in the range and booked afterwards counts.
     */
    cadence: "range",
    dataKeys: ["speedOutcome"],
  },
  {
    id: "call_timing",
    group: "leads",
    label: "When calls connect",
    description:
      "Which hours of the day outbound calls actually reach a person — and whether enough of the day has been tried to say.",
    // Third in the calling group: how fast you answered, whether that mattered,
    // then when the phone is worth picking up at all.
    defaultOrder: 74,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["callTiming"],
  },
  {
    id: "lead_quality",
    group: "leads",
    label: "What kinds of leads convert",
    description:
      "Which groups of leads book more often — by when they arrived and which campaign they came from. A group-level finding, never a per-lead score.",
    // After the calling group and before the queues: this is about where leads
    // come from, which is a different argument from what to do with them today.
    defaultOrder: 76,
    defaultVisible: true,
    /*
     * `range` is where the cohort ARRIVES, but outcomes are followed forward
     * out of it — a lead that came in during the range and booked afterwards
     * counts. The badge system cannot express that, so the panel says it in
     * prose, exactly as `speed_outcome` does.
     */
    cadence: "range",
    dataKeys: ["quality"],
  },
  {
    id: "aging",
    group: "leads",
    label: "Leads that stopped moving",
    description:
      "Open leads sitting longer than this pipeline normally takes at their stage.",
    // Directly above the pipeline explorer: "where is everyone" then "who has
    // been there too long" is one thought, and the explorer is where a reader
    // goes next to see the rest.
    defaultOrder: 75,
    defaultVisible: true,
    /*
     * Current state, like the pipeline explorer beside it. The date picker
     * cannot change who is sitting in a stage right now, and the badge says so
     * rather than leaving a reader to wonder why a 7-day range shows a lead
     * that has been stuck for forty days.
     */
    cadence: "all_time",
    dataKeys: ["aging"],
    // Renders individual people by name — see the flag's contract.
    containsLeadPii: true,
  },
  {
    id: "uncalled",
    group: "leads",
    label: "Call these people",
    description: "Leads nobody has phoned, a working day or more after they arrived.",
    /*
     * Immediately above the overdue list, and above it deliberately. "Nobody
     * has ever called this person" is a strictly harder failure than "this lead
     * is slow for its stage", and a reader working down the page should hit the
     * shorter, more urgent list first.
     */
    defaultOrder: 74,
    defaultVisible: true,
    /*
     * Current state. The date picker cannot change who has never been phoned,
     * and the badge says so — a reader selecting "last 7 days" and finding a
     * lead from three weeks ago has otherwise been misled by the interface.
     */
    cadence: "all_time",
    dataKeys: ["uncalled"],
    // Renders people by name AND phone number — the most identifying thing this
    // dashboard puts on screen anywhere.
    containsLeadPii: true,
  },
  {
    id: "maturation",
    group: "leads",
    label: "Is this month worse, or younger?",
    description:
      "How long a month's leads take to convert, and whether the last two months are comparable yet.",
    // Immediately above the report tables, whose month-on-month row is the
    // exact comparison this section qualifies. Read after it, the qualification
    // arrives too late to stop the conclusion.
    defaultOrder: 95,
    defaultVisible: true,
    /*
     * Trailing arrival cohorts, so the date picker does not move it — and the
     * badge says so, because a reader who selects "last 7 days" and finds
     * twelve months of rows has been misled by the interface.
     */
    cadence: "fixed_windows",
    dataKeys: ["maturation"],
  },
  {
    id: "channels",
    group: "leads",
    label: "Paid vs the rest of the pipeline",
    description:
      "Whether the advertising is adding leads, and whether the split can be believed.",
    defaultOrder: 97,
    defaultVisible: true,
    // Twelve months of arrival cohorts, like the maturation panel above it —
    // the retainer question is annual, not weekly.
    cadence: "fixed_windows",
    dataKeys: ["channels"],
  },
  {
    id: "pipeline",
    group: "leads",
    label: "Pipeline explorer",
    description: "Every paid lead and the stage it sits in right now.",
    defaultOrder: 80,
    defaultVisible: true,
    // Snapshot of current state — the queries behind it take no date window.
    cadence: "all_time",
    dataKeys: ["leads", "pipelineDistribution", "campaigns"],
    // Renders each lead by name, and the drawer carries email and phone.
    containsLeadPii: true,
  },
  {
    id: "heatmap",
    group: "leads",
    label: "When leads arrive",
    description: "Paid leads by weekday and hour, in the client's timezone.",
    defaultOrder: 90,
    defaultVisible: true,
    cadence: "range",
    dataKeys: ["heatmap"],
  },
  {
    id: "report_tables",
    group: "reports",
    label: "Report tables",
    description:
      "Moving averages, 7-day change, 14-day daily and month-on-month — the source sheet's four views.",
    defaultOrder: 100,
    defaultVisible: true,
    cadence: "fixed_windows",
    dataKeys: [], // loaded separately, behind its own Suspense boundary
  },
] as const;

export const SECTION_BY_ID: Record<SectionId, SectionDef> = Object.fromEntries(
  SECTIONS.map((s) => [s.id, s]),
) as Record<SectionId, SectionDef>;

/**
 * What a REPORT contains — the document, not the dashboard.
 *
 * 🔴 **An allowlist, deliberately, and it lives here rather than in the
 * component that renders it.** The report is served over a share link: an
 * unauthenticated bearer URL that gets forwarded through mail servers and reply
 * chains and cannot be recalled. Under a denylist, every section added to the
 * dashboard in future would be published to that URL by default, and the person
 * adding it would have no reason to think about share links at all. Under an
 * allowlist the default is exclusion and the decision is explicit.
 *
 * `src/lib/dashboard/report-sections.test.ts` fails if anything here is flagged
 * `containsLeadPii`.
 *
 * The order is the reading order of the document: what we counted, the headline
 * numbers, where people were lost, how it moved, which campaigns did it.
 *
 * `anomalies` is deliberately absent, and not for privacy reasons. Its findings
 * are written for whoever can act on them — a data gap points at the connection
 * health panel, which a report reader cannot reach and has no context for. A
 * board pack saying "the sync may not have run" is an operational note leaking
 * into a client deliverable.
 */
export const REPORT_SECTIONS: readonly SectionId[] = [
  "lead_filter_note",
  "kpis",
  "funnel",
  "trend",
  "campaigns",
] as const;

/**
 * The sections to render, in order.
 *
 * Total by construction — it never throws and never returns an empty page.
 * `stored` is accepted now so the eventual persistence layer is a caller change
 * rather than a signature change; today every caller passes nothing.
 *
 * Rules, in the order they matter:
 *
 * 1. An id in `stored` that is no longer in the registry is dropped silently —
 *    a deleted section must not break a saved layout.
 * 2. A registry id absent from `stored` is INSERTED at its default position and
 *    VISIBLE. A dashboard that silently omits a newly shipped capability is
 *    precisely the `SHOWN = 0` failure this project replaces.
 * 3. `required` sections are always visible regardless of what was stored.
 */
export function resolveLayout(
  stored?: StoredLayout | { id: string; visible: boolean }[] | null,
  opts: LayoutAudienceOpts = {},
): SectionDef[] {
  return resolveLayoutFull(stored, opts)
    .filter((e) => e.visible)
    .map((e) => e.def);
}

export interface LayoutAudienceOpts {
  /**
   * Whether the viewer is agency staff. Defaults to FALSE — fail closed.
   *
   * A staff-only section reaching a client is a disclosure; a staff-only
   * section missing from a staff view is an inconvenience. The default has to
   * be the second of those, so a caller that forgets the flag shows less rather
   * than more.
   */
  staff?: boolean;
}

/**
 * The current shape of a stored layout. Bump when the jsonb shape changes, and
 * add a step to `migrateLayout`.
 */
export const LAYOUT_SCHEMA_VERSION = 1;

export interface StoredLayout {
  schemaVersion?: number;
  sections?: unknown;
}

export interface ResolvedSection {
  def: SectionDef;
  visible: boolean;
  /**
   * This section is in the registry but was absent from the stored layout — it
   * shipped after the layout was saved.
   *
   * Surfaced in the settings UI as a "New" badge. Rule 2 already makes such a
   * section VISIBLE rather than hidden, because a dashboard that silently omits
   * a newly shipped capability is the `SHOWN = 0` failure this project exists to
   * replace. The badge is the other half: it tells the reader that something
   * appeared and that they get to decide about it, rather than leaving them to
   * notice an unexplained new block.
   */
  isNew: boolean;
}

/**
 * `resolveLayout` with the visibility and novelty flags retained — what the
 * settings UI needs, since it has to render hidden sections too.
 */
export function resolveLayoutFull(
  stored?: StoredLayout | { id: string; visible: boolean }[] | null,
  opts: LayoutAudienceOpts = {},
): ResolvedSection[] {
  // Fail closed: without an explicit `staff: true`, staff-only sections are not
  // in the registry this call can see at all — not hidden, absent. They then
  // cannot be reintroduced by a stored layout naming one, because rule 1 drops
  // an id the registry does not hold.
  const visibleRegistry = opts.staff ? SECTIONS : SECTIONS.filter((s) => !s.staffOnly);

  const byId = new Map(visibleRegistry.map((s) => [s.id, s]));
  const defaults = (): ResolvedSection[] =>
    [...visibleRegistry]
      .sort((a, b) => a.defaultOrder - b.defaultOrder)
      .map((def) => ({ def, visible: def.defaultVisible, isNew: false }));

  const entries = normalise(stored);
  if (entries === null) return defaults();

  const seen = new Set<SectionId>();
  const placed: Array<ResolvedSection & { order: number }> = [];

  for (const entry of entries) {
    const def = byId.get(entry.id as SectionId);
    if (!def || seen.has(def.id)) continue; // rule 1, plus dedupe
    seen.add(def.id);
    placed.push({
      def,
      visible: def.required ? true : Boolean(entry.visible), // rule 3
      isNew: false,
      order: placed.length,
    });
  }

  /*
   * Rule 2 — a section the stored layout has never heard of.
   *
   * It has to be inserted at its DEFAULT position, which means interpolating
   * into the stored ordering rather than appending: slot it immediately after
   * the last stored section that the registry also orders before it. Ordering
   * new arrivals on the raw `defaultOrder` scale would put every one of them
   * after every stored section, since stored positions are indices — which is
   * how a newly shipped section ends up silently at the bottom of the page.
   */
  for (const def of visibleRegistry) {
    if (seen.has(def.id)) continue;
    let after = -1;
    for (const p of placed) {
      if (p.def.defaultOrder < def.defaultOrder) after = Math.max(after, p.order);
    }
    placed.push({
      def,
      visible: def.defaultVisible,
      isNew: true,
      order: after + 0.5,
    });
  }

  return placed
    .sort((a, b) => a.order - b.order || a.def.defaultOrder - b.def.defaultOrder)
    .map(({ def, visible, isNew }) => ({ def, visible, isNew }));
}

/**
 * Reduce anything a caller might hand us to a usable entry list, or `null`
 * meaning "use the code defaults".
 *
 * Total by construction. Every branch that cannot be understood returns null
 * rather than throwing, because the alternative — a dashboard that 500s
 * because a jsonb column holds something unexpected — is strictly worse than a
 * dashboard that renders its default sections.
 */
function normalise(
  stored: StoredLayout | { id: string; visible: boolean }[] | null | undefined,
): Array<{ id: string; visible: boolean }> | null {
  if (!stored) return null;

  // A bare array — the shape every caller used before persistence existed.
  if (Array.isArray(stored)) return stored.length ? stored : null;

  const version = stored.schemaVersion ?? LAYOUT_SCHEMA_VERSION;

  /*
   * 🔴 A version we have never seen means a NEWER deploy wrote this row —
   * during a rolling deploy, or after a rollback. We cannot know what the shape
   * means, and a guess would render a dashboard that silently omits sections.
   * Defaults are the only honest reading, and the row is left untouched so the
   * newer deploy still finds it intact.
   */
  if (version > LAYOUT_SCHEMA_VERSION) return null;

  const migrated = version < LAYOUT_SCHEMA_VERSION
    ? migrateLayout(stored.sections, version)
    : stored.sections;

  if (!Array.isArray(migrated) || migrated.length === 0) return null;

  return migrated.flatMap((e) =>
    e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string"
      ? [
          {
            id: (e as { id: string }).id,
            visible: Boolean((e as { visible?: unknown }).visible),
          },
        ]
      : [],
  );
}

/**
 * Bring an older stored shape up to the current one.
 *
 * Empty today — version 1 is the first shape there has ever been. It exists as
 * a named step so the first shape change has somewhere obvious to go, rather
 * than being bolted into `normalise` under time pressure.
 */
function migrateLayout(sections: unknown, fromVersion: number): unknown {
  /*
   * Each future step goes here as `if (version < N) { … }`, applied in order so
   * a row two versions behind is brought all the way forward rather than
   * skipping the steps in between. `fromVersion` is read now so the parameter
   * is wired up before the first step needs it.
   */
  if (fromVersion < 1) return sections;
  return sections;
}
