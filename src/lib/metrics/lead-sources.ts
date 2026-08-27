/**
 * Which page and which form actually bring leads in — and which of those leads
 * go on to book.
 *
 * GHL records the landing URL and the form/calendar id on every lead it
 * captures itself, nested under `attributionSource`. We have stored the whole
 * object in `contacts.raw_attribution` since the first webhook, so this panel
 * needs no new pipe and no new sync — it is a read of data already on disk.
 *
 * ── 🔴 The comparison this module refuses to make ──────────────────────
 *
 * The single most tempting row here is the one that must never be ranked
 * against the others. On the live book, 1,398 of 1,686 contacts carry no
 * attribution object at all, and they are not people who arrived anonymously —
 * they are the historical import, the same rows `quality.ts` documents as
 * carrying neither phone nor email.
 *
 * Put them in the same table as a real landing page and the arithmetic is
 * devastating and completely false: the import books at ~7% and
 * `retainer.growthguild.us/ghloffer` books at ~54%, so the page looks like it
 * converts eight times better than "direct". It does not. The import rows are
 * older, were never callable, and in many cases were never worked at all. The
 * page would be taking credit for the difference between a real lead and a
 * spreadsheet row.
 *
 * So the unattributed count is reported — loudly, because hiding it is how the
 * old sheet lied — but it is reported as **coverage**, above the table, and is
 * never given a conversion rate or a rank. The table ranks only leads that were
 * actually captured with attribution, against each other.
 *
 * ── Two different kinds of "missing", kept apart ───────────────────────
 *
 * · **No attribution captured** — no `attributionSource` at all. Import ghosts.
 *   Excluded from the table entirely and shown as a coverage figure.
 * · **No landing page** — attribution captured, but no `url` on it. A real,
 *   meaningful group: manual entry, calendar bookings, DM conversations. It
 *   stays in the table as its own row, because "how many of our leads never
 *   touched a page" is a genuine answer, not an absence of one.
 *
 * Folding those two together would put 180 real calendar bookings in the same
 * bucket as 1,398 import rows and make both unreadable.
 */

/** Which attribute the table is grouped by. */
export type LeadSourceDimension = "page" | "form" | "medium";

export const DIMENSION_LABEL: Record<LeadSourceDimension, string> = {
  page: "Landing page",
  form: "Form or calendar",
  medium: "How it came in",
};

/**
 * 🔴 A caveat that has to travel with the row, not sit in a doc comment.
 *
 * The `medium` table contains a partly circular comparison and it is not
 * obvious from looking at it. A lead whose medium is `calendar` arrived BY
 * booking a slot — booking is the mechanism, not the outcome — so its book rate
 * is close to a tautology and on the live book reads 63% against 8% for manual
 * entry. A reader who takes that at face value concludes the calendar widget
 * converts eight times better than the sales team, which is not a finding, it
 * is the definition of the two groups restated.
 *
 * Pages and forms do not have this problem: standing on a page is genuinely
 * upstream of booking. So the warning is attached to the one dimension that
 * earns it rather than blanketing the panel, which would train readers to skip
 * it.
 */
export const DIMENSION_CAVEAT: Partial<Record<LeadSourceDimension, string>> = {
  medium:
    "A calendar lead arrived by booking a slot, so its book rate is close to circular — read this table for volume, and compare pages and forms for conversion.",
};

export const DIMENSION_BLURB: Record<LeadSourceDimension, string> = {
  page: "The URL the lead was standing on when they converted.",
  form: "The specific form, calendar or Instant Form that captured them.",
  medium: "The mechanism GHL recorded — form, calendar, manual entry, a DM.",
};

/**
 * Leads a row needs before its book rate is stated as a number.
 *
 * Below this a rate is arithmetic, not a finding: three leads and three
 * bookings renders "100%", which reads as the best page on the site and means
 * nothing whatsoever. Those rows still appear — they are real leads and
 * omitting them would understate the total — but their rate reads `—` and the
 * caption says why.
 *
 * Deliberately lower than `quality.ts`'s MIN_LEADS_PER_LEVEL of 25: that module
 * makes a statistical claim about whether a difference is real, and this one
 * only counts what happened. A descriptive rate can be shown on thinner
 * evidence than an inferential one, as long as the thinness is visible.
 */
export const MIN_LEADS_FOR_RATE = 10;

/** The shape the query hands over — one row per contact in the window. */
export interface LeadSourceInput {
  /** `contacts.raw_attribution`, whatever shape it landed in. */
  raw: unknown;
  /** Did any opportunity for this contact ever enter `appointment_booked`. */
  appt: boolean;
  /** …or `closed_won`. */
  won: boolean;
}

export interface LeadSourceRow {
  value: string;
  /** Full untruncated value for a tooltip — a URL can be long. */
  title: string;
  leads: number;
  appts: number;
  won: number;
  /** Null below `MIN_LEADS_FOR_RATE`, or when leads is 0. */
  bookRate: number | null;
  /** True for the "no landing page" / "not recorded" row, which reads muted. */
  isResidual: boolean;
}

export interface LeadSourceGroup {
  dimension: LeadSourceDimension;
  rows: LeadSourceRow[];
  /** Leads represented in `rows` — i.e. those carrying an attribution object. */
  attributedLeads: number;
}

export interface LeadSourceReport {
  groups: LeadSourceGroup[];
  /** Every lead created in the window, attributed or not. */
  totalLeads: number;
  /** Leads carrying no `attributionSource` at all. Coverage, never a row. */
  unattributedLeads: number;
}

/**
 * Unwrap the two shapes `raw_attribution` is stored in.
 *
 * The webhook path nests the object under `attributionSource`; some older rows
 * hold the bare object. `attribution.ts` draws the same distinction for the
 * same reason, and getting it wrong reads as "no lead has any attribution"
 * rather than as an error.
 */
function attributionOf(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nested = o.attributionSource;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  // A bare object with none of the keys we read is not attribution.
  return Object.keys(o).length > 0 ? o : null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * A URL reduced to host + path — the unit a marketer actually thinks in.
 *
 * The query string is dropped on purpose. It carries the UTMs, so keeping it
 * would split one landing page into one row per ad, which is the campaign
 * breakdown's job and would leave this table with hundreds of rows of one lead
 * each. The trailing slash goes too, so `/contact-us` and `/contact-us/` are
 * not two pages.
 */
export function pageLabel(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    // Not parseable — show it rather than dropping the lead on the floor.
    return rawUrl.slice(0, 80);
  }
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.host.toLowerCase()}${path}`;
}

/**
 * The best human name for the thing that captured the lead.
 *
 * `formName` is present only on Meta Instant Form leads and is the one label a
 * reader recognises ("GG | Lead Form | SEO 2"), so it wins. Otherwise we are
 * left with an opaque id — `formId` for forms, `mediumId` for calendars — which
 * is genuinely all GHL gives us. Shown as-is rather than hidden: an id a reader
 * can paste into GHL search beats a row that says "unknown".
 */
function formLabel(a: Record<string, unknown>): string | null {
  return (
    str(a.formName) ?? str(a.formId) ?? str(a.mediumId) ?? null
  );
}

/** Label for a row that has attribution but nothing on this dimension. */
const RESIDUAL_LABEL: Record<LeadSourceDimension, string> = {
  page: "No landing page",
  form: "No form or calendar",
  medium: "Not recorded",
};

function valueFor(
  dimension: LeadSourceDimension,
  a: Record<string, unknown>,
): string | null {
  switch (dimension) {
    case "page": {
      const url = str(a.url);
      return url ? pageLabel(url) : null;
    }
    case "form":
      return formLabel(a);
    case "medium":
      return str(a.medium);
  }
}

function buildGroup(
  dimension: LeadSourceDimension,
  attributed: { a: Record<string, unknown>; appt: boolean; won: boolean }[],
): LeadSourceGroup {
  const acc = new Map<string, { leads: number; appts: number; won: number }>();

  for (const { a, appt, won } of attributed) {
    const key = valueFor(dimension, a) ?? RESIDUAL_LABEL[dimension];
    const cur = acc.get(key) ?? { leads: 0, appts: 0, won: 0 };
    cur.leads += 1;
    if (appt) cur.appts += 1;
    if (won) cur.won += 1;
    acc.set(key, cur);
  }

  const rows: LeadSourceRow[] = [...acc.entries()].map(([value, v]) => ({
    value,
    title: value,
    leads: v.leads,
    appts: v.appts,
    won: v.won,
    bookRate: v.leads >= MIN_LEADS_FOR_RATE ? v.appts / v.leads : null,
    isResidual: value === RESIDUAL_LABEL[dimension],
  }));

  /*
   * Ordered by lead volume, not by book rate. Sorting by rate would put a
   * one-lead-one-booking row at the top of every table forever, and the first
   * row of a table is read as its headline finding.
   *
   * The residual row sinks to the bottom regardless of its size — it is context
   * for the rows above it, not a competitor to them.
   */
  rows.sort((x, y) => {
    if (x.isResidual !== y.isResidual) return x.isResidual ? 1 : -1;
    if (y.leads !== x.leads) return y.leads - x.leads;
    return x.value.localeCompare(y.value);
  });

  return {
    dimension,
    rows,
    attributedLeads: attributed.length,
  };
}

const DIMENSIONS: readonly LeadSourceDimension[] = ["page", "form", "medium"];

/**
 * Build the whole report from one pass over the window's contacts.
 *
 * Pure — no I/O, no clock, no database — so the residual/unattributed split and
 * the rate suppression are testable against fixtures rather than against a
 * live book that changes under the test.
 */
export function buildLeadSources(input: readonly LeadSourceInput[]): LeadSourceReport {
  const attributed: { a: Record<string, unknown>; appt: boolean; won: boolean }[] = [];
  let unattributed = 0;

  for (const row of input) {
    const a = attributionOf(row.raw);
    if (!a) {
      unattributed += 1;
      continue;
    }
    attributed.push({ a, appt: row.appt, won: row.won });
  }

  return {
    groups: DIMENSIONS.map((d) => buildGroup(d, attributed)),
    totalLeads: input.length,
    unattributedLeads: unattributed,
  };
}
