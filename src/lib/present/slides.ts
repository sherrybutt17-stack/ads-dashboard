import type { DashboardData } from "@/lib/metrics/dashboard";
import type { CommentaryForReport } from "@/lib/commentary/report";
import type { Accountability, Commitment } from "@/lib/commentary/model";
import {
  formatCurrency,
  formatMultiple,
  formatNumber,
  formatPercent,
} from "@/lib/metrics/compute";

/**
 * The monthly review call, as a deck.
 *
 * These figures get presented on a call every month by scrolling a browser tab —
 * which means the client sees twenty numbers at once while the presenter talks
 * about one, and the presenter loses their place every time they scroll. One
 * point per screen fixes both.
 *
 * ── Why the deck is BUILT rather than rendered ─────────────────────────
 *
 * The whole file is a pure function from the dashboard's data to a list of
 * slides, and the interesting part is what it refuses to put in.
 *
 * 🔴 **A slide whose only content is a dash is worse than no slide.** On a
 * screen share there is no scrolling past it: the presenter has to stand there
 * and explain an empty number to a paying client. So a metric with no figure is
 * dropped — and every drop is recorded with its reason and shown to the
 * presenter before they start. Silently shorter is how the old spreadsheet's six
 * empty blocks went unnoticed for months; visibly shorter, with reasons, is the
 * opposite.
 *
 * 🔴 **Zero is not missing.** `$0 spend` is a fact about the month and gets its
 * slide, with the words "no spend in this period" under it rather than a bare
 * zero the client has to interpret. `null` — a ratio with nothing to divide — is
 * the one that gets dropped.
 *
 * ── What is deliberately not here ──────────────────────────────────────
 *
 * No lead names, emails or phone numbers, on any slide. A screen share is more
 * exposed than a share link — it gets recorded, and it gets recorded by whoever
 * is on the call. The pipeline explorer is excluded for exactly the reason it is
 * excluded from the report.
 */

/* ------------------------------------------------------------------ *
 * Slide shapes
 * ------------------------------------------------------------------ */

export type ValueFormat = "currency" | "count" | "percent" | "multiple";

export interface TitleSlide {
  kind: "title";
  id: string;
  brandName: string;
  periodLabel: string;
  platformLabel: string;
  timezone: string;
}

export interface MetricSlide {
  kind: "metric";
  id: string;
  label: string;
  value: number;
  format: ValueFormat;
  /** Period-over-period, as a fraction. Null when there is no comparison. */
  delta: number | null;
  /**
   * The key this metric goes by in `METRIC_POLARITY`, carried rather than a
   * resolved tone so the slide runs the delta through `changeSentiment` — the
   * same function, and the same 5% dead band, as the dashboard tiles. A deck
   * calling a 1% move green while the tile behind it calls it neutral is the
   * kind of contradiction someone notices mid-call.
   */
  polarityKey: string;
  /**
   * What the number is made of, in words — "$940 spend ÷ 20 paid leads".
   *
   * Presented aloud. "Cost per lead is forty-seven dollars" invites "per lead of
   * what?", and the answer differs between BOOK%, SHOW% and CLOSE% in ways that
   * have started arguments on calls this feature exists to prevent.
   */
  basis: string;
  /** Honest framing where a bare figure would mislead. */
  note: string | null;
  spark: number[];
}

export interface FunnelSlide {
  kind: "funnel";
  id: string;
  steps: DashboardData["funnel"];
}

export interface TrendSlide {
  kind: "trend";
  id: string;
  daily: DashboardData["daily"];
  prevDaily: DashboardData["prevDaily"];
}

export interface CampaignSlide {
  kind: "campaigns";
  id: string;
  rows: DashboardData["campaigns"];
  currency: string;
}

export interface AccountabilitySlide {
  kind: "accountability";
  id: string;
  month: string;
  accountability: Accountability;
  currency: string;
}

export interface ProseSlide {
  kind: "prose";
  id: string;
  heading: string;
  body: string;
}

export interface PlanSlide {
  kind: "plan";
  id: string;
  heading: string;
  commitments: Commitment[];
  currency: string;
}

export interface CloseSlide {
  kind: "close";
  id: string;
  brandName: string;
}

export type Slide =
  | TitleSlide
  | MetricSlide
  | FunnelSlide
  | TrendSlide
  | CampaignSlide
  | AccountabilitySlide
  | ProseSlide
  | PlanSlide
  | CloseSlide;

export interface SkippedSlide {
  label: string;
  why: string;
}

export interface Deck {
  slides: Slide[];
  /**
   * What was left out, and why. Shown to the presenter before they start —
   * never to the room.
   */
  skipped: SkippedSlide[];
  currency: string;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function formatValue(
  value: number | null,
  format: ValueFormat,
  currency = "USD",
): string {
  switch (format) {
    case "currency":
      return formatCurrency(value, currency);
    case "percent":
      return formatPercent(value, 1);
    case "multiple":
      return formatMultiple(value);
    default:
      return formatNumber(value);
  }
}

/* ------------------------------------------------------------------ *
 * Building
 * ------------------------------------------------------------------ */

interface MetricSpec {
  id: string;
  label: string;
  format: ValueFormat;
  value: number | null;
  deltaKey: string;
  polarityKey: string;
  basis: string;
  note?: string | null;
  spark: number[];
  /**
   * Which side of the funnel slide this metric sits on.
   *
   * 🔴 An explicit anchor, because the funnel used to be emitted from inside
   * the cost-per-lead branch of the metric loop — so on a client with no leads,
   * `cpLead` was null, the loop `continue`d, and the funnel vanished with no
   * reason recorded. A silently missing slide is the one thing this builder
   * exists to prevent, and it was doing it.
   */
  group: "head" | "tail";
  /**
   * A reason this metric cannot be presented at all, independent of its value.
   *
   * Distinct from a null figure: this covers the cases where a number EXISTS and
   * would still mislead — revenue reading $0 because nobody types deal values
   * into GHL is the one that motivated it.
   */
  suppress?: string | null;
}

export function buildDeck(
  data: DashboardData,
  opts: {
    brandName: string;
    platformLabel: string;
    commentary: CommentaryForReport | null;
  },
): Deck {
  const { current, deltas, daily, prevDaily, funnel, campaigns } = data;
  const currency = data.client.currency;
  const slides: Slide[] = [];
  const skipped: SkippedSlide[] = [];

  const sparkOf = (pick: (d: DashboardData["daily"][number]) => number) =>
    daily.map(pick);

  slides.push({
    kind: "title",
    id: "title",
    brandName: opts.brandName,
    periodLabel: data.range.label,
    platformLabel: opts.platformLabel,
    timezone: data.client.timezone,
  });

  /*
   * Last month's plan comes second, before any number. The same argument as the
   * report: a meeting that opens with new promises and never revisits the old
   * ones is a sales call. This is the slide that makes it a review.
   */
  if (opts.commentary?.accountability) {
    slides.push({
      kind: "accountability",
      id: "accountability",
      month: opts.commentary.month,
      accountability: opts.commentary.accountability,
      currency,
    });
  }

  const wonWithValue = current.revenue?.wonWithValue ?? 0;
  const wonOpps = current.revenue?.wonOpps ?? 0;
  /*
   * 🔴 The deal-value gap. When nothing carries a value, `revenue` is a
   * confident $0 rather than a null — so the guard has to be on the coverage,
   * not on the figure. Presenting "$0 revenue" to a client who closed two deals
   * is worse than presenting nothing.
   */
  const noDealValues =
    wonWithValue === 0
      ? wonOpps > 0
        ? `${formatNumber(wonOpps)} closed, but no deal value is set on any of them in the CRM`
        : "no closed deals in this period"
      : null;

  const specs: MetricSpec[] = [
    {
      id: "spend",
      group: "head",
      label: "Spend",
      format: "currency",
      value: current.ads.spend,
      deltaKey: "spend",
      polarityKey: "spend",
      basis: `${opts.platformLabel} spend over ${data.range.label}`,
      note: current.ads.spend === 0 ? "No spend in this period." : null,
      spark: sparkOf((d) => d.ads.spend),
    },
    {
      id: "leads",
      group: "head",
      label: "Leads",
      format: "count",
      value: current.funnel.new_lead,
      deltaKey: "new_lead",
      polarityKey: "new_lead",
      basis: "Paid leads that entered the pipeline in this period",
      note:
        current.funnel.new_lead === 0
          ? "No leads entered the pipeline in this period."
          : null,
      spark: sparkOf((d) => d.funnel.new_lead),
    },
    {
      id: "cpLead",
      group: "head",
      label: "Cost per lead",
      format: "currency",
      value: current.derived.cpLead,
      deltaKey: "cpLead",
      polarityKey: "cpLead",
      basis: `${formatCurrency(current.ads.spend, currency)} spend ÷ ${formatNumber(current.funnel.new_lead)} paid leads`,
      spark: sparkOf((d) => d.derived.cpLead ?? 0),
    },
    {
      id: "appts",
      group: "tail",
      label: "Appointments",
      format: "count",
      value: current.funnel.appointment_booked,
      deltaKey: "appointment_booked",
      polarityKey: "appointment_booked",
      basis: "Distinct leads that reached Appointment Booked in this period",
      spark: sparkOf((d) => d.funnel.appointment_booked),
    },
    {
      id: "cpAppt",
      group: "tail",
      label: "Cost per appointment",
      format: "currency",
      value: current.derived.cpAppt,
      deltaKey: "cpAppt",
      polarityKey: "cpAppt",
      basis: `${formatCurrency(current.ads.spend, currency)} spend ÷ ${formatNumber(current.funnel.appointment_booked)} appointments`,
      spark: sparkOf((d) => d.derived.cpAppt ?? 0),
    },
    {
      id: "shows",
      group: "tail",
      label: "Shows",
      format: "count",
      value: current.funnel.showed,
      deltaKey: "showed",
      polarityKey: "showed",
      basis: "Appointments that were actually attended",
      spark: sparkOf((d) => d.funnel.showed),
      /*
       * 🔴 A "Shows: 0" slide beside "Appointments: 14" reads as a catastrophe
       * when it is almost always a CRM gap — nobody moves the card after the
       * appointment happens. The funnel slide still carries the number, in a
       * context that shows the whole chain, so nothing is hidden by dropping
       * the dedicated one.
       */
      suppress:
        current.funnel.showed === 0 && current.funnel.appointment_booked > 0
          ? "no appointment has been marked as attended — the Showed stage may not be in use"
          : null,
    },
    {
      id: "won",
      group: "tail",
      label: "Closed won",
      format: "count",
      value: current.funnel.closed_won,
      deltaKey: "closed_won",
      polarityKey: "closed_won",
      basis: "Deals closed in this period",
      spark: sparkOf((d) => d.funnel.closed_won),
    },
    {
      id: "revenue",
      group: "tail",
      label: "Revenue",
      format: "currency",
      value: current.revenue?.revenue ?? null,
      deltaKey: "revenue",
      polarityKey: "revenue",
      basis: "Value of deals closed in this period",
      spark: [],
      suppress: noDealValues,
    },
    {
      id: "roas",
      group: "tail",
      label: "Return on ad spend",
      format: "multiple",
      value: current.derived.roas,
      deltaKey: "roas",
      polarityKey: "roas",
      basis: `Revenue ÷ ${formatCurrency(current.ads.spend, currency)} spend`,
      spark: [],
      suppress: noDealValues,
    },
  ];

  const emit = (group: "head" | "tail") => {
    for (const spec of specs) {
      if (spec.group !== group) continue;
      if (spec.suppress) {
        skipped.push({ label: spec.label, why: spec.suppress });
        continue;
      }
      if (spec.value === null || !Number.isFinite(spec.value)) {
        // A slide reading "–" in 96pt tells a room nothing and costs the
        // presenter an explanation.
        skipped.push({ label: spec.label, why: "no figure for this period" });
        continue;
      }
      slides.push({
        kind: "metric",
        id: spec.id,
        label: spec.label,
        value: spec.value,
        format: spec.format,
        delta: deltas[spec.deltaKey] ?? null,
        polarityKey: spec.polarityKey,
        basis: spec.basis,
        note: spec.note ?? null,
        spark: spec.spark,
      });
    }
  };

  // What a lead costs, then what happens to them. The funnel sits between the
  // two groups unconditionally, so no metric's absence can move or lose it.
  emit("head");
  if (current.funnel.new_lead > 0) {
    slides.push({ kind: "funnel", id: "funnel", steps: funnel });
  } else {
    skipped.push({
      label: "Funnel",
      why: "no leads entered the pipeline, so there is no funnel to walk",
    });
  }
  emit("tail");

  /*
   * Two days is the minimum a trend can mean anything over. One point is not a
   * line, and a chart with a single dot invites a question about the chart
   * rather than the business.
   */
  if (daily.length >= 2) {
    slides.push({ kind: "trend", id: "trend", daily, prevDaily });
  } else {
    skipped.push({
      label: "Trend",
      why: "the selected range is a single day, so there is nothing to plot",
    });
  }

  const spending = campaigns.filter((c) => c.spend > 0);
  if (spending.length > 0) {
    slides.push({ kind: "campaigns", id: "campaigns", rows: spending, currency });
  } else {
    skipped.push({
      label: "Campaigns",
      why: "no campaign recorded spend in this period",
    });
  }

  if (opts.commentary) {
    if (opts.commentary.did.trim() !== "") {
      slides.push({
        kind: "prose",
        id: "did",
        heading: "What we did",
        body: opts.commentary.did,
      });
    }
    if (opts.commentary.commitments.length > 0) {
      slides.push({
        kind: "plan",
        id: "plan",
        heading: "What's next",
        commitments: opts.commentary.commitments,
        currency,
      });
    }
  } else {
    /*
     * Not an error, and worth saying plainly: the deck has no "what we did" or
     * "what's next" because nothing was published for the month. The presenter
     * finds out here rather than when the slide does not arrive.
     */
    skipped.push({
      label: "Commentary",
      why: "no commentary has been published for this month",
    });
  }

  slides.push({ kind: "close", id: "close", brandName: opts.brandName });

  return { slides, skipped, currency };
}

/**
 * Clamp an index onto a deck.
 *
 * Its own function because the index arrives from a URL — a presenter reloading
 * mid-call must land where they were, and `?slide=99` must not blank the screen
 * in front of a client.
 */
export function clampSlide(index: number, total: number): number {
  if (!Number.isFinite(index) || total <= 0) return 0;
  return Math.min(Math.max(Math.floor(index), 0), total - 1);
}
