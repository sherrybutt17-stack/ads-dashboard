/**
 * Monthly commentary — what we did, what's next, and how last month's plan
 * actually turned out.
 *
 * ── Why this is not another framing of the written summary ──────────────
 *
 * §6.2's summaries describe a *range*: whatever window the reader happens to be
 * looking at. That is the right shape for a summary and the wrong shape for a
 * promise. "Last month we said we would cut cost per lead" is only answerable if
 * "last month" is a fixed, agreed thing — so commentary is keyed to a calendar
 * month and nothing else. A commentary attached to "the last 30 days" could
 * never be found again from the following month's report.
 *
 * ── The one decision the rest of this file exists to enforce ────────────
 *
 * 🔴 **Where a commitment carries a number, the verdict is computed from the
 * number and a person cannot overrule it.** An agency that promised "cost per
 * lead under $40", delivered $47, and ticked "done" would have turned an
 * accountability feature into a laundering one — and it would be the single
 * most damaging thing this product could ship, because the client's whole
 * reason to trust the report is that its figures are not curated.
 *
 * So the split is:
 *
 *   - a commitment WITH a metric  → status derived, note optional, no verdict
 *   - a commitment WITHOUT one    → only a person can answer, and "nobody has"
 *                                   is a state that renders rather than hides
 *
 * The second half matters as much as the first. Every accountability feature
 * dies the same way: the answering stops and the section quietly empties. A
 * commitment with no answer is reported as unanswered, on the client's own
 * document, which is the only pressure that has ever worked.
 *
 * ── Which month a target is measured over ───────────────────────────────
 *
 * A commitment written into July's commentary is a plan for August. It is
 * therefore measured over August — the month whose figures sit on the report
 * carrying the verdict. The reader can check the claim against the numbers on
 * the same page, which is the entire point.
 */

import {
  METRIC_POLARITY,
  formatCurrency,
  formatMultiple,
  formatNumber,
  formatPercent,
} from "@/lib/metrics/compute";

/* ------------------------------------------------------------------ *
 * Month keys — deliberately string arithmetic
 * ------------------------------------------------------------------ */

/**
 * `yyyy-MM`. The same key `trailingMonths` already produces, so the month-on-
 * month table and the commentary cannot disagree about what "August" means.
 */
export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonthKey(s: unknown): s is string {
  return typeof s === "string" && MONTH_KEY_RE.test(s);
}

/**
 * The month before this one.
 *
 * String arithmetic rather than `subMonths(new Date(...))` on purpose. Every
 * date bug in this codebase has come from a `Date` picking up the runtime's
 * timezone somewhere in the middle; "the month before 2026-01" is a fact about
 * the calendar with no instant in it, and evaluating it as one invites a host in
 * Auckland to answer differently from a host in Los Angeles.
 */
export function previousMonthKey(key: string): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** The month after this one. The mirror of `previousMonthKey`. */
export function nextMonthKey(key: string): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, "0")}`;
}

export function monthKeyForDateKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function monthLabel(key: string): string {
  const month = Number(key.slice(5, 7));
  return `${MONTH_NAMES[month - 1] ?? "?"} ${key.slice(0, 4)}`;
}

function daysInMonth(year: number, month: number): number {
  if (month !== 2) return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return leap ? 29 : 28;
}

/**
 * The first and last date keys of a month, inclusive.
 *
 * The day is NOT padded, unlike the month in `previousMonthKey` — no month has
 * fewer than 28 days, so a day-of-month here is always two digits already. A
 * `padStart(2, "0")` was written and then removed once a mutation proved it
 * could not change any output; the note is here so it does not get helpfully
 * added back.
 */
export function monthBounds(key: string): { startKey: string; endKey: string } {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  return {
    startKey: `${key}-01`,
    endKey: `${key}-${daysInMonth(year, month)}`,
  };
}

/* ------------------------------------------------------------------ *
 * The metric a commitment may carry
 * ------------------------------------------------------------------ */

export type TargetDirection = "at_most" | "at_least";

/**
 * The metrics a target may be set against.
 *
 * Not every metric on the dashboard — only the ones an agency would actually
 * promise something about. `reach` and `frequency` are excluded because they are
 * not additive and a monthly figure for them means something subtler than a
 * target implies; `optinPct` because nobody has ever set one.
 */
export const TARGET_METRICS = [
  "spend",
  "leads",
  "cpLead",
  "appts",
  "cpAppt",
  "shows",
  "won",
  "cpWon",
  "revenue",
  "roas",
  "bookPct",
  "showPct",
  "closePct",
  "ctr",
  "cpc",
  "cpm",
] as const;

export type TargetMetric = (typeof TARGET_METRICS)[number];

export function isTargetMetric(s: unknown): s is TargetMetric {
  return typeof s === "string" && (TARGET_METRICS as readonly string[]).includes(s);
}

/**
 * The shape a month's figures must have to answer a target.
 *
 * Declared structurally rather than importing `PeriodMetrics` so this module
 * stays free of `queries.ts` — which pulls in the database client, and this file
 * is imported by a `"use client"` editor. `PeriodMetrics` satisfies it by
 * construction; the test asserts that, so a rename upstream fails loudly here
 * instead of silently widening.
 */
export interface MetricSource {
  funnel: {
    new_lead: number;
    appointment_booked: number;
    showed: number;
    closed_won: number;
  };
  ads: { spend: number };
  revenue: { revenue: number } | null;
  derived: {
    cpLead: number | null;
    cpAppt: number | null;
    cpWon: number | null;
    bookPct: number | null;
    showPct: number | null;
    closePct: number | null;
    ctr: number | null;
    cpc: number | null;
    cpm: number | null;
    roas: number | null;
  };
}

export type TargetFormat = "currency" | "count" | "percent" | "multiple";

export interface TargetMetricDef {
  key: TargetMetric;
  label: string;
  format: TargetFormat;
  /**
   * Display units per stored unit. Percentages are held as ratios everywhere in
   * the metrics engine (0.35), and a person types "35".
   */
  scale: number;
  /**
   * The key this metric goes by in `METRIC_POLARITY`.
   *
   * Indirect on purpose: the default direction of a target is read out of the
   * metrics engine rather than restated here, so a metric whose polarity is ever
   * corrected there cannot end up with a target defaulting the wrong way while
   * the dashboard colours it the other. The names differ (`leads` here,
   * `new_lead` there) because this list is written for someone setting a goal
   * and that one is keyed by column.
   */
  polarityKey: string;
  read: (m: MetricSource) => number | null;
}

export const TARGET_METRIC_DEFS: Record<TargetMetric, TargetMetricDef> = {
  spend: {
    key: "spend", label: "Spend", format: "currency", scale: 1,
    // Genuinely neutral, and the only one here that is: "hold spend under $5k"
    // and "scale to $8k" are both ordinary commitments. `METRIC_POLARITY` has no
    // entry, which is the honest answer rather than an oversight.
    polarityKey: "spend", read: (m) => m.ads.spend,
  },
  leads: {
    key: "leads", label: "Leads", format: "count", scale: 1,
    polarityKey: "new_lead", read: (m) => m.funnel.new_lead,
  },
  cpLead: {
    key: "cpLead", label: "Cost per lead", format: "currency", scale: 1,
    polarityKey: "cpLead", read: (m) => m.derived.cpLead,
  },
  appts: {
    key: "appts", label: "Appointments", format: "count", scale: 1,
    polarityKey: "appointment_booked", read: (m) => m.funnel.appointment_booked,
  },
  cpAppt: {
    key: "cpAppt", label: "Cost per appointment", format: "currency", scale: 1,
    polarityKey: "cpAppt", read: (m) => m.derived.cpAppt,
  },
  shows: {
    key: "shows", label: "Shows", format: "count", scale: 1,
    polarityKey: "showed", read: (m) => m.funnel.showed,
  },
  won: {
    key: "won", label: "Closed won", format: "count", scale: 1,
    polarityKey: "closed_won", read: (m) => m.funnel.closed_won,
  },
  cpWon: {
    key: "cpWon", label: "Cost per close", format: "currency", scale: 1,
    polarityKey: "cpWon", read: (m) => m.derived.cpWon,
  },
  revenue: {
    key: "revenue", label: "Revenue", format: "currency", scale: 1,
    polarityKey: "revenue", read: (m) => m.revenue?.revenue ?? null,
  },
  roas: {
    key: "roas", label: "ROAS", format: "multiple", scale: 1,
    polarityKey: "roas", read: (m) => m.derived.roas,
  },
  bookPct: {
    key: "bookPct", label: "Booking rate", format: "percent", scale: 100,
    polarityKey: "bookPct", read: (m) => m.derived.bookPct,
  },
  showPct: {
    key: "showPct", label: "Show rate", format: "percent", scale: 100,
    polarityKey: "showPct", read: (m) => m.derived.showPct,
  },
  closePct: {
    key: "closePct", label: "Close rate", format: "percent", scale: 100,
    polarityKey: "closePct", read: (m) => m.derived.closePct,
  },
  ctr: {
    key: "ctr", label: "Click-through rate", format: "percent", scale: 100,
    polarityKey: "ctr", read: (m) => m.derived.ctr,
  },
  cpc: {
    key: "cpc", label: "Cost per click", format: "currency", scale: 1,
    polarityKey: "cpc", read: (m) => m.derived.cpc,
  },
  cpm: {
    key: "cpm", label: "CPM", format: "currency", scale: 1,
    polarityKey: "cpm", read: (m) => m.derived.cpm,
  },
};

/**
 * Which way a target on this metric usually points — a starting value for the
 * selector, never a constraint. Both directions are always available.
 *
 * A metric the engine calls neutral falls to `at_most`, because a target on a
 * metric that is neither good nor bad to grow is almost always a ceiling: a
 * budget.
 */
export function defaultDirection(key: TargetMetric): TargetDirection {
  return METRIC_POLARITY[TARGET_METRIC_DEFS[key].polarityKey] === "higher-better"
    ? "at_least"
    : "at_most";
}

/* ------------------------------------------------------------------ *
 * Commitments and answers
 * ------------------------------------------------------------------ */

export interface CommitmentTarget {
  metric: TargetMetric;
  direction: TargetDirection;
  /** In display units — 40 for $40, 35 for 35%. */
  value: number;
}

export interface Commitment {
  /**
   * Stable across months. The following month's answers reference it, so an id
   * that changed when the text was edited would orphan the answer.
   */
  id: string;
  text: string;
  target: CommitmentTarget | null;
}

export const VERDICTS = ["done", "partly", "not_done", "dropped"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABEL: Record<Verdict, string> = {
  done: "Done",
  partly: "Partly",
  not_done: "Not done",
  /** Honest, and the option whose absence causes the lying. */
  dropped: "Dropped",
};

export interface Outcome {
  commitmentId: string;
  verdict: Verdict;
  note: string;
}

/** What a reader is shown for one carried-forward commitment. */
export type CommitmentStatus =
  /** A target was set and met. Derived; nobody typed this. */
  | "met"
  /** A target was set and missed. Derived; nobody typed this either. */
  | "missed"
  /** A target was set and the month produced no figure to judge it by. */
  | "unmeasurable"
  | Verdict
  /** No target, and nobody has said what happened. */
  | "unanswered";

export interface ResolvedCommitment {
  commitment: Commitment;
  status: CommitmentStatus;
  /** Present iff the commitment carried a target. Stored units, not display. */
  actual: number | null;
  /** Free text from a person. Allowed alongside a derived status. */
  note: string;
}

export interface Accountability {
  /** The month those commitments were written in. */
  priorMonth: string;
  items: ResolvedCommitment[];
  counts: {
    met: number;
    missed: number;
    unmeasurable: number;
    done: number;
    partly: number;
    not_done: number;
    dropped: number;
    unanswered: number;
  };
  /** Commitments a person still owes an answer on. */
  unanswered: number;
  /** Answered one way or another — the number worth showing as coverage. */
  answered: number;
  total: number;
}

/**
 * The target in the same units the metrics engine stores — 0.35, not 35.
 *
 * Converting the target down rather than the actual up. `0.35 * 100` is
 * `35.000000000000004`, which makes "at least 35%" read as missed on a month
 * that hit exactly 35%; `35 / 100` is bit-identical to the double `div(7, 20)`
 * produces, so the knife-edge lands the right way. Judging and formatting both
 * go through here so they cannot disagree about where the line is.
 */
export function targetThreshold(target: CommitmentTarget): number {
  return target.value / TARGET_METRIC_DEFS[target.metric].scale;
}

/** Judge one target against a month's figures. */
export function judgeTarget(
  target: CommitmentTarget,
  actuals: MetricSource | null,
): { actual: number | null; status: "met" | "missed" | "unmeasurable" } {
  const actual = actuals ? TARGET_METRIC_DEFS[target.metric].read(actuals) : null;
  if (actual === null || !Number.isFinite(actual)) {
    return { actual: null, status: "unmeasurable" };
  }
  const threshold = targetThreshold(target);
  const met =
    target.direction === "at_most" ? actual <= threshold : actual >= threshold;
  return { actual, status: met ? "met" : "missed" };
}

/**
 * Render a figure in this metric's own units. The input is STORED units, so a
 * target must be put through `targetThreshold` first — which is what keeps the
 * printed target and the printed actual on the same scale.
 */
export function formatMetricValue(
  key: TargetMetric,
  stored: number | null,
  currency = "USD",
): string {
  switch (TARGET_METRIC_DEFS[key].format) {
    case "currency":
      return formatCurrency(stored, currency);
    case "percent":
      return formatPercent(stored, 1);
    case "multiple":
      return formatMultiple(stored);
    default:
      return formatNumber(stored);
  }
}

export function describeTarget(target: CommitmentTarget, currency = "USD"): string {
  const def = TARGET_METRIC_DEFS[target.metric];
  const word = target.direction === "at_most" ? "at most" : "at least";
  return `${def.label} ${word} ${formatMetricValue(target.metric, targetThreshold(target), currency)}`;
}

/**
 * Last month's plan, against this month's reality.
 *
 * `actuals` is this month's figures — see the header note on which month a
 * target is measured over. Passing `null` is legitimate (the figures could not
 * be loaded) and produces `unmeasurable`, never `missed`: a database that was
 * unreachable is not an agency that failed.
 */
export function resolveAccountability(input: {
  priorMonth: string;
  priorCommitments: readonly Commitment[];
  outcomes: readonly Outcome[];
  actuals: MetricSource | null;
}): Accountability {
  const byId = new Map(input.outcomes.map((o) => [o.commitmentId, o]));

  const items: ResolvedCommitment[] = input.priorCommitments.map((commitment) => {
    const stated = byId.get(commitment.id) ?? null;
    const note = stated?.note?.trim() ?? "";

    if (commitment.target) {
      /*
       * 🔴 `stated.verdict` is read nowhere in this branch, and that is the
       * whole design. A target that was set gets answered by the arithmetic;
       * the person keeps the note, which is where a legitimate explanation
       * ("the $900 test budget is in this figure") belongs.
       */
      const judged = judgeTarget(commitment.target, input.actuals);
      return { commitment, status: judged.status, actual: judged.actual, note };
    }

    return {
      commitment,
      status: stated ? stated.verdict : "unanswered",
      actual: null,
      note,
    };
  });

  const counts = {
    met: 0, missed: 0, unmeasurable: 0,
    done: 0, partly: 0, not_done: 0, dropped: 0, unanswered: 0,
  };
  for (const item of items) counts[item.status]++;

  return {
    priorMonth: input.priorMonth,
    items,
    counts,
    unanswered: counts.unanswered,
    answered: items.length - counts.unanswered,
    total: items.length,
  };
}

/* ------------------------------------------------------------------ *
 * Parsing what arrives from a request or out of jsonb
 * ------------------------------------------------------------------ */

export const MAX_COMMITMENTS = 12;
export const MAX_COMMITMENT_CHARS = 400;
export const MAX_NOTE_CHARS = 600;
export const MAX_DID_CHARS = 8_000;

/**
 * Coerce stored jsonb into commitments, dropping anything unrecognisable.
 *
 * Lenient on read, in line with `resolveLayout`: a row written by an older
 * shape, or hand-edited in psql, must cost the commentary panel rather than the
 * page it sits on. The write path is where strictness lives.
 */
export function parseCommitments(raw: unknown): Commitment[] {
  if (!Array.isArray(raw)) return [];
  const out: Commitment[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const text = typeof e.text === "string" ? e.text.trim() : "";
    /*
     * A duplicate id would make the following month's answer ambiguous — the
     * `Map` above would silently attach one note to two commitments. Dropping
     * the later one keeps the first-written answer pointing where it was aimed.
     */
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text: text.slice(0, MAX_COMMITMENT_CHARS), target: parseTarget(e.target) });
    if (out.length >= MAX_COMMITMENTS) break;
  }
  return out;
}

export function parseTarget(raw: unknown): CommitmentTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (!isTargetMetric(t.metric)) return null;
  if (t.direction !== "at_most" && t.direction !== "at_least") return null;
  const value = typeof t.value === "number" ? t.value : Number(t.value);
  if (!Number.isFinite(value)) return null;
  return { metric: t.metric, direction: t.direction, value };
}

export function parseOutcomes(raw: unknown): Outcome[] {
  if (!Array.isArray(raw)) return [];
  const out: Outcome[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const commitmentId = typeof e.commitmentId === "string" ? e.commitmentId : "";
    const verdict = e.verdict;
    if (!commitmentId || seen.has(commitmentId)) continue;
    if (typeof verdict !== "string" || !VERDICTS.includes(verdict as Verdict)) continue;
    seen.add(commitmentId);
    out.push({
      commitmentId,
      verdict: verdict as Verdict,
      note: typeof e.note === "string" ? e.note.trim().slice(0, MAX_NOTE_CHARS) : "",
    });
  }
  return out;
}

/**
 * Answers whose commitment no longer exists.
 *
 * Kept rather than pruned on write: a commitment deleted from last month's
 * published document takes its answer out of the report anyway, and silently
 * discarding the text someone typed — in case the deletion is itself undone —
 * is a worse trade than carrying a few dead rows in jsonb.
 */
export function orphanedOutcomes(
  outcomes: readonly Outcome[],
  priorCommitments: readonly Commitment[],
): Outcome[] {
  const live = new Set(priorCommitments.map((c) => c.id));
  return outcomes.filter((o) => !live.has(o.commitmentId));
}

/** Is there anything at all in this month's commentary? */
export function isEmptyCommentary(c: {
  did: string;
  commitments: readonly Commitment[];
  outcomes: readonly Outcome[];
}): boolean {
  return (
    c.did.trim() === "" && c.commitments.length === 0 && c.outcomes.length === 0
  );
}
