import type { DashboardData } from "@/lib/metrics/dashboard";
import type { Insight } from "@/lib/metrics/insights";
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatMultiple,
  formatChange,
  DASH,
} from "@/lib/metrics/compute";

/**
 * The facts a generated summary is allowed to be built from.
 *
 * Pure — no I/O, no model call. This is the half of the AI summary that decides
 * whether the output can be trusted, and it deserves to be readable and testable
 * without a network.
 *
 * ---
 *
 * TWO JOBS, AND THE SECOND IS THE POINT
 *
 * **1 · Give the model the period's facts**, already formatted the way the
 * dashboard formats them, so prose and page cannot disagree about whether cost
 * per lead was $43.71 or $43.7.
 *
 * **2 · Enumerate every number that may legitimately appear in the prose.** A
 * weekly summary is the artefact most likely to be forwarded to a client
 * unread — and a language model writing about advertising performance will
 * cheerfully produce a plausible figure that appears nowhere in the data. There
 * is no prompt that reliably prevents this. `verifyFigures` checks the finished
 * text against this list, so a fabricated number is caught by arithmetic rather
 * than by hoping someone notices.
 *
 * `allowed` is therefore not decoration. Anything omitted from it becomes a
 * number the model cannot use without being flagged, so it is built generously
 * from everything the brief states — and nothing else.
 *
 * ---
 *
 * `caveats` is the other half of honesty: what the model must NOT claim. The
 * dashboard already knows when revenue is unattributable, when spend exists with
 * no attributed leads, and which leads are being counted. Without those in the
 * brief, "the campaigns generated no revenue" is exactly the sentence a model
 * writes about a client whose deal values were simply never entered.
 */

export type FigureKind = "money" | "count" | "percent" | "multiple";

export interface AllowedFigure {
  value: number;
  kind: FigureKind;
  /** What it is, for the flag message when something close-but-wrong appears. */
  label: string;
}

export interface BriefFact {
  label: string;
  display: string;
  /** Period-over-period change, already rendered ("+12.4%"). */
  change: string | null;
}

export interface ReportBrief {
  clientName: string;
  periodLabel: string;
  platformLabel: string;
  currency: string;
  facts: BriefFact[];
  funnel: string[];
  campaigns: string[];
  /** Already-written sentences from the deterministic engines. */
  anomalies: string[];
  insights: string[];
  /** What the data cannot support. The model is told not to go past these. */
  caveats: string[];
  allowed: AllowedFigure[];
}

/** Collects figures without repeating the same value twice. */
class FigureSet {
  private seen = new Set<string>();
  readonly list: AllowedFigure[] = [];

  add(value: number | null | undefined, kind: FigureKind, label: string): void {
    if (value == null || !Number.isFinite(value)) return;
    const key = `${kind}:${value}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ value, kind, label });
  }

  /** A ratio, admitted both as itself and as its percentage. */
  addRatio(value: number | null | undefined, label: string): void {
    if (value == null || !Number.isFinite(value)) return;
    this.add(value * 100, "percent", label);
    this.add(Math.abs(value * 100), "percent", `${label} (magnitude)`);
  }
}

const STAGE_LABEL: Record<string, string> = {
  new_lead: "New leads",
  contacted: "Contacted",
  appointment_booked: "Appointments booked",
  showed: "Showed up",
  no_show: "No-shows",
  closed_won: "Closed won",
  lost: "Lost",
  disqualified: "Disqualified (never a real prospect)",
};

export function buildBrief(
  data: DashboardData,
  insights: Insight[],
): ReportBrief {
  const c = data.current;
  const currency = data.client.currency;
  const money = (v: number | null) => formatCurrency(v, currency);
  const figures = new FigureSet();

  const facts: BriefFact[] = [];
  const fact = (
    label: string,
    display: string,
    value: number | null,
    kind: FigureKind,
    deltaKey?: string,
  ) => {
    const change = deltaKey ? data.deltas[deltaKey] : null;
    figures.add(value, kind, label);
    if (change != null) figures.addRatio(change, `${label} change`);
    facts.push({
      label,
      display,
      change: change == null ? null : formatChange(change),
    });
  };

  fact("Ad spend", money(c.ads.spend), c.ads.spend, "money", "spend");
  fact("Impressions", formatNumber(c.ads.impressions), c.ads.impressions, "count");
  fact("Link clicks", formatNumber(c.ads.linkClicks), c.ads.linkClicks, "count", "linkClicks");
  fact("Leads", formatNumber(c.funnel.new_lead), c.funnel.new_lead, "count", "new_lead");
  fact("Cost per lead", money(c.derived.cpLead), c.derived.cpLead, "money", "cpLead");

  /*
   * Both cost-per-lead figures, never only the flattering one. The qualified
   * number divides by leads that were real prospects, and quoting it alone is
   * precisely the quiet massaging this product replaces.
   */
  if (c.derived.cpLeadQualified != null) {
    fact(
      "Cost per qualified lead (excluding disqualified)",
      money(c.derived.cpLeadQualified),
      c.derived.cpLeadQualified,
      "money",
    );
  }

  fact(
    "Appointments",
    formatNumber(c.funnel.appointment_booked),
    c.funnel.appointment_booked,
    "count",
    "appointment_booked",
  );
  fact("Cost per appointment", money(c.derived.cpAppt), c.derived.cpAppt, "money", "cpAppt");
  fact("Shows", formatNumber(c.funnel.showed), c.funnel.showed, "count", "showed");
  fact("Closed deals", formatNumber(c.funnel.closed_won), c.funnel.closed_won, "count", "closed_won");

  /*
   * 🔴 Revenue has THREE states and the brief must not flatten them.
   *
   * Caught on live data, in this file's own output: a client with no closed
   * deal was described as "Revenue: $0.00, ROAS 0.0×" directly above a caveat
   * saying revenue was unknown. The brief contradicted itself, which is worse
   * than either statement alone — the model gets to pick.
   *
   *   · no deal closed              → revenue really is zero for the period
   *   · deals closed, no values set → revenue is UNKNOWN, and $0 is a lie
   *   · some values set             → revenue is a floor, not a total
   *
   * Only the first is a number, so only the first is offered as one. In the
   * unknown case nothing is added to `allowed`, so a model writing "$0 in
   * revenue" is flagged rather than merely discouraged by a caveat.
   */
  const rev = c.revenue;
  const revenueUnknown = Boolean(rev && rev.wonOpps > 0 && rev.wonWithValue === 0);
  if (rev) {
    if (revenueUnknown) {
      facts.push({ label: "Revenue", display: `${DASH} (deal values not recorded)`, change: null });
      facts.push({ label: "Return on ad spend", display: `${DASH} (needs deal values)`, change: null });
    } else {
      fact("Revenue", money(rev.revenue), rev.revenue, "money", "revenue");
      figures.add(rev.wonWithValue, "count", "deals carrying a value");
      fact("Return on ad spend", formatMultiple(c.derived.roas), c.derived.roas, "multiple", "roas");
    }
  }

  for (const [key, label] of [
    ["bookPct", "Booking rate (appointments ÷ leads)"],
    ["showPct", "Show rate (shows ÷ appointments)"],
    ["closePct", "Close rate (wins ÷ shows)"],
    ["ctr", "Click-through rate"],
  ] as const) {
    const v = c.derived[key];
    figures.addRatio(v, label);
    facts.push({
      label,
      display: v == null ? DASH : formatPercent(v, 1),
      change: null,
    });
  }

  /* Funnel, as sentences rather than a table the model has to interpret. */
  const funnel = data.funnel.map((step) => {
    figures.add(step.count, "count", STAGE_LABEL[step.stage] ?? step.stage);
    figures.addRatio(step.conversionFromPrevious, `${step.stage} conversion`);
    figures.add(step.droppedFromPrevious, "count", `${step.stage} drop-off`);
    const conv =
      step.conversionFromPrevious == null
        ? ""
        : ` — ${formatPercent(step.conversionFromPrevious, 0)} of the previous stage`;
    return `${STAGE_LABEL[step.stage] ?? step.stage}: ${step.count}${conv}`;
  });

  /* Campaigns, biggest spender first — the model should lead with what matters. */
  const campaigns = [...data.campaigns]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 8)
    .map((cam) => {
      figures.add(cam.spend, "money", `${cam.campaignName} spend`);
      figures.add(cam.leads, "count", `${cam.campaignName} leads`);
      figures.add(cam.cpLead, "money", `${cam.campaignName} cost per lead`);
      return `${cam.campaignName}: ${money(cam.spend)} spend, ${cam.leads} leads, ${money(cam.cpLead)} per lead`;
    });
  figures.add(data.campaigns.length, "count", "number of campaigns");

  /* Anomalies arrive already written, and carry their own figures. */
  const anomalies = data.anomalies.findings.map((a) => {
    figures.add(a.value, a.metric === "spend" || a.metric === "cpLead" ? "money" : "count", a.label);
    figures.add(a.baseline, a.metric === "spend" || a.metric === "cpLead" ? "money" : "count", `${a.label} baseline`);
    if (a.baseline > 0) figures.add(a.value / a.baseline, "multiple", `${a.label} multiple`);
    figures.add(a.days, "count", "days in the unusual run");
    return a.text;
  });

  return {
    clientName: data.client.name,
    periodLabel: data.range.label,
    platformLabel: data.platform === "google" ? "Google Ads" : "Facebook / Meta",
    currency,
    facts,
    funnel,
    campaigns,
    anomalies,
    insights: insights.map((i) => i.text),
    caveats: buildCaveats(data),
    allowed: figures.list,
  };
}

/**
 * What the numbers cannot support — stated so the model does not fill the gap.
 *
 * Every entry here corresponds to a real, already-detected condition. None is a
 * generic disclaimer: a caveat that always fires trains the reader (and the
 * model) to skip the whole block.
 */
function buildCaveats(data: DashboardData): string[] {
  const out: string[] = [];
  const c = data.current;

  if (data.attributionGap) {
    out.push(
      "Spend was recorded but NOT ONE lead in this period is attributed to a campaign. Do not describe the advertising as having produced no leads — the leads may exist without their attribution. Say the attribution is missing.",
    );
  }

  /*
   * The three revenue states, said correctly. See the matching block in
   * `buildBrief` — a caveat that disagrees with the figures above it is not a
   * safeguard, it is a second story the model can choose between.
   */
  const rev = c.revenue;
  if (!rev || rev.wonOpps === 0) {
    out.push(
      "No deal reached closed-won in this period, so its revenue is genuinely zero — but deals from these leads can still close later, and a period's revenue keeps growing after the period ends. Do not present zero revenue as a final verdict on the advertising.",
    );
  } else if (rev.wonWithValue === 0) {
    out.push(
      "Deals closed in this period but NOT ONE carries a monetary value in the CRM, so revenue and return on ad spend are UNKNOWN, not zero. Do not state, imply or estimate a revenue figure.",
    );
  } else if (rev.wonWithValue < rev.wonOpps) {
    out.push(
      `Only ${rev.wonWithValue} of ${rev.wonOpps} closed deals carry a value, so the revenue figure is a floor rather than a total. Say so if you quote it.`,
    );
  }

  const cov = data.revenueCoverage;
  if (cov && cov.totalDeals > 0 && cov.attributedDeals === 0) {
    out.push(
      "No lead carries a Meta ad id, so revenue cannot be traced to any individual creative. Do not attribute a deal, or the absence of one, to a specific ad or video.",
    );
  }

  if (data.provisional.provisionalRows > 0 && data.provisional.since) {
    out.push(
      `Meta may still restate figures from ${data.provisional.since} onward as attribution windows fill, so the most recent days can move. Do not present them as final.`,
    );
  }

  const f = data.leadFilter;
  if (f.mode !== "all") {
    out.push(
      `These figures count ${f.paid} paid leads out of ${f.total} total leads in the CRM — the rest are not attributed to advertising and are excluded. Do not describe the paid figure as the client's total lead volume.`,
    );
  }

  if (data.anomalies.judgedDays === 0) {
    out.push(
      "There is not yet enough history to say whether any day was unusual. Do not describe the period as steady, consistent or stable on that basis.",
    );
  }

  if (data.creativesError) {
    out.push(
      "Creative-level data could not be read for this period. Do not comment on individual images or videos.",
    );
  }

  return out;
}

/**
 * The brief as the plain text the model actually receives.
 *
 * Kept next to the builder so the shape the model sees and the shape the
 * validator is built from can never drift apart — they come from one object.
 */
export function renderBrief(b: ReportBrief): string {
  const lines: string[] = [
    `Client: ${b.clientName}`,
    `Advertising platform: ${b.platformLabel}`,
    `Reporting period: ${b.periodLabel}`,
    `Currency: ${b.currency}`,
    "",
    "HEADLINE FIGURES (value, then change vs the previous period of equal length):",
    ...b.facts.map(
      (f) => `  - ${f.label}: ${f.display}${f.change ? ` (${f.change} vs previous period)` : ""}`,
    ),
  ];

  if (b.funnel.length) {
    lines.push("", "FUNNEL — people entering each stage during the period:", ...b.funnel.map((s) => `  - ${s}`));
  }
  if (b.campaigns.length) {
    lines.push("", "CAMPAIGNS, highest spend first:", ...b.campaigns.map((s) => `  - ${s}`));
  }
  if (b.insights.length) {
    lines.push("", "PERIOD-OVER-PERIOD HEADLINES already derived from the data:", ...b.insights.map((s) => `  - ${s}`));
  }
  if (b.anomalies.length) {
    lines.push(
      "",
      "UNUSUAL INDIVIDUAL DAYS, measured against this account's own trailing 28 days:",
      ...b.anomalies.map((s) => `  - ${s}`),
    );
  }
  if (b.caveats.length) {
    lines.push(
      "",
      "WHAT THIS DATA CANNOT SUPPORT — treat each as a hard constraint on what you write:",
      ...b.caveats.map((s) => `  - ${s}`),
    );
  }

  return lines.join("\n");
}
