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
 */

export interface Insight {
  text: string;
  tone: "good" | "bad" | "neutral";
}

const NOTABLE = 5; // percent; below this a metric isn't worth calling out

function pct(v: number): string {
  return `${Math.abs(Math.round(v))}%`;
}

function tone(metric: string, delta: number): Insight["tone"] {
  return changeSentiment(metric, delta);
}

export function buildInsights(d: DashboardData): Insight[] {
  const out: Insight[] = [];
  const used = new Set<string>();
  const D = d.deltas;

  const leads = D.new_lead;
  const spend = D.spend;
  const cpl = D.cpLead;

  // 1) Combined narratives first — they carry more meaning than a lone delta.
  if (leads != null && cpl != null && leads > 3 && cpl < -3) {
    out.push({
      tone: "good",
      text: `More leads at a lower cost — leads up ${pct(leads)}, cost per lead down ${pct(cpl)}.`,
    });
    used.add("new_lead").add("cpLead");
  } else if (spend != null && leads != null && spend > 8 && leads < 3) {
    out.push({
      tone: "bad",
      text: `Ad spend rose ${pct(spend)} but leads ${
        leads < -3 ? `fell ${pct(leads)}` : "stayed flat"
      } — watch efficiency.`,
    });
    used.add("spend").add("new_lead");
  }

  // 2) Fill the remaining slots with the largest individual moves.
  const candidates: Array<{ key: string; label: string; delta: number | null }> = [
    { key: "new_lead", label: "Leads", delta: leads },
    { key: "cpLead", label: "Cost per lead", delta: cpl },
    { key: "appointment_booked", label: "Appointments", delta: D.appointment_booked },
    { key: "closed_won", label: "Closed deals", delta: D.closed_won },
    { key: "showed", label: "Shows", delta: D.showed },
    { key: "spend", label: "Ad spend", delta: spend },
  ]
    .filter((c) => c.delta != null && Math.abs(c.delta) >= NOTABLE && !used.has(c.key))
    .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!));

  for (const c of candidates) {
    if (out.length >= 2) break;
    out.push({
      tone: tone(c.key, c.delta!),
      text: `${c.label} ${c.delta! > 0 ? "up" : "down"} ${pct(c.delta!)} vs the previous period.`,
    });
    used.add(c.key);
  }

  // 3) A genuinely quiet period is itself the headline.
  if (out.length === 0) {
    out.push({
      tone: "neutral",
      text: "Steady period — no headline metric moved more than 5% versus the previous one.",
    });
  }

  return out.slice(0, 2);
}
