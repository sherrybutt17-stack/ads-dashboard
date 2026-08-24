import type { DashboardData } from "./dashboard";
import { changeSentiment } from "./compute";

/**
 * "What changed" — plain-English headlines derived from the deltas the
 * dashboard already computes.
 *
 * This is the layer that makes the numbers feel read rather than merely
 * displayed: instead of leaving the viewer to scan six tiles and reconstruct
 * the story, it names the story. Every claim is polarity-aware (a falling
 * cost-per-lead is good) and traces to a real period-over-period delta — no
 * invented significance.
 *
 * Pure and deterministic: same DashboardData in, same insights out.
 *
 * ---
 *
 * TWO BUGS WERE FIXED HERE TOGETHER, AND THEY HAD TO BE.
 *
 * `pctChange` returns a RATIO (0.12 = up 12%), but every threshold in this file
 * was written as though it were a percentage — `>= 5`, `> 3`, `> 8`. Only a
 * 500% move cleared the bar, so **every client read "Steady period" forever**.
 * `pct()` compounded it by rounding the raw ratio, so a real 12% move would have
 * printed "0%" even if it had qualified.
 *
 * Fixing the comparison ALONE would have made things worse, not better. At this
 * product's volumes a client can go from 3 leads to 5 in a week — a 67% rise
 * that is pure noise — and a naive fix would have promoted that to a headline
 * every single week. The bug was accidentally suppressing a louder problem.
 *
 * So the multiply ships with a VOLUME GATE: a metric is only called out when
 * both periods carry enough absolute activity for a percentage to mean anything
 * (§ MIN_COUNT / MIN_SPEND). And when volume is what's missing, the fallback
 * says so rather than claiming the period was steady — those are different
 * facts, and conflating them is exactly the kind of confident-but-hollow
 * statement this dashboard exists to replace.
 */

export interface Insight {
  text: string;
  tone: "good" | "bad" | "neutral";
}

/** Percentage-point thresholds. Deltas are ratios, so compare against `d * 100`. */
const NOTABLE = 5; // below this a metric isn't worth calling out
const RISE = 3; // "leads rose" / "spend held" boundary
const SPEND_JUMP = 8; // spend moving enough to question efficiency

/**
 * Volume floors, evaluated on BOTH periods.
 *
 * Five conversions is the smallest count where a percentage starts describing
 * behaviour rather than coincidence; below it, one extra lead swings the figure
 * by 20% or more. $250 is the equivalent for spend-derived metrics — under that
 * a single day's budget shift dominates the comparison.
 */
const MIN_COUNT = 5;
const MIN_SPEND = 250;

function pct(ratio: number): string {
  return `${Math.abs(Math.round(ratio * 100))}%`;
}

/** A delta in percentage points, or null when it doesn't exist. */
function points(delta: number | null | undefined): number | null {
  return delta == null || !Number.isFinite(delta) ? null : delta * 100;
}

function tone(metric: string, delta: number): Insight["tone"] {
  return changeSentiment(metric, delta);
}

export function buildInsights(d: DashboardData): Insight[] {
  const out: Insight[] = [];
  const used = new Set<string>();
  const D = d.deltas;
  const cur = d.current;
  const prev = d.previous;

  // Percentage-point views of the deltas actually used in prose below.
  const leads = points(D.new_lead);
  const spend = points(D.spend);
  const cpl = points(D.cpLead);

  /*
   * Is a percentage worth quoting at all?
   *
   * Counts gate on the smaller of the two periods: 2 → 6 leads is +200% and
   * means nothing, while 40 → 52 is +30% and means something real.
   */
  const countVolume = (a: number, b: number) => Math.min(a, b) >= MIN_COUNT;
  const spendVolume =
    Math.min(cur.ads.spend, prev.ads.spend) >= MIN_SPEND;

  const leadVolume = countVolume(cur.funnel.new_lead, prev.funnel.new_lead);
  // Cost per lead is a ratio of spend to leads — it needs both to be substantial.
  const cplVolume = leadVolume && spendVolume;

  // 1) Combined narratives first — they carry more meaning than a lone delta.
  if (leads != null && cpl != null && leadVolume && cplVolume && leads > RISE && cpl < -RISE) {
    out.push({
      tone: "good",
      text: `More leads at a lower cost — leads up ${pct(D.new_lead!)}, cost per lead down ${pct(D.cpLead!)}.`,
    });
    used.add("new_lead").add("cpLead");
  } else if (
    spend != null &&
    leads != null &&
    spendVolume &&
    leadVolume &&
    spend > SPEND_JUMP &&
    leads < RISE
  ) {
    out.push({
      tone: "bad",
      text: `Ad spend rose ${pct(D.spend!)} but leads ${
        leads < -RISE ? `fell ${pct(D.new_lead!)}` : "stayed flat"
      } — watch efficiency.`,
    });
    used.add("spend").add("new_lead");
  }

  // 2) Fill the remaining slots with the largest individual moves that clear
  //    BOTH the significance threshold and their metric's volume floor.
  const candidates: Array<{
    key: string;
    label: string;
    delta: number | null;
    hasVolume: boolean;
  }> = [
    { key: "new_lead", label: "Leads", delta: D.new_lead, hasVolume: leadVolume },
    { key: "cpLead", label: "Cost per lead", delta: D.cpLead, hasVolume: cplVolume },
    {
      key: "appointment_booked",
      label: "Appointments",
      delta: D.appointment_booked,
      hasVolume: countVolume(
        cur.funnel.appointment_booked,
        prev.funnel.appointment_booked,
      ),
    },
    {
      key: "closed_won",
      label: "Closed deals",
      delta: D.closed_won,
      hasVolume: countVolume(cur.funnel.closed_won, prev.funnel.closed_won),
    },
    {
      key: "showed",
      label: "Shows",
      delta: D.showed,
      hasVolume: countVolume(cur.funnel.showed, prev.funnel.showed),
    },
    { key: "spend", label: "Ad spend", delta: D.spend, hasVolume: spendVolume },
    {
      key: "revenue",
      label: "Revenue",
      delta: D.revenue,
      // Revenue is only quotable when both periods actually recorded deal
      // values — otherwise the move describes data entry, not performance.
      hasVolume:
        (cur.revenue?.wonWithValue ?? 0) > 0 &&
        (prev.revenue?.wonWithValue ?? 0) > 0,
    },
  ]
    .filter((c) => {
      const p = points(c.delta);
      return p != null && Math.abs(p) >= NOTABLE && c.hasVolume && !used.has(c.key);
    })
    .sort((a, b) => Math.abs(points(b.delta)!) - Math.abs(points(a.delta)!));

  for (const c of candidates) {
    if (out.length >= 2) break;
    out.push({
      tone: tone(c.key, c.delta!),
      text: `${c.label} ${c.delta! > 0 ? "up" : "down"} ${pct(c.delta!)} vs the previous period.`,
    });
    used.add(c.key);
  }

  /*
   * 3) Nothing to report — but say WHICH nothing.
   *
   * "Steady period" is a claim about performance. "Too little volume" is a claim
   * about the sample. Printing the first when the second is true tells a client
   * their ads were stable when the honest answer is that a handful of leads
   * cannot support the word "stable".
   */
  if (out.length === 0) {
    const thin = !leadVolume && !spendVolume;
    out.push(
      thin
        ? {
            tone: "neutral",
            text: `Too little activity this period to call a trend — ${cur.funnel.new_lead} leads vs ${prev.funnel.new_lead} previously.`,
          }
        : {
            tone: "neutral",
            text: `Steady period — no headline metric moved more than ${NOTABLE}% versus the previous one.`,
          },
    );
  }

  return out.slice(0, 2);
}
