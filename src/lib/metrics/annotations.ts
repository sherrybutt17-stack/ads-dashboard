/**
 * Trend annotations — the pure half.
 *
 * Split from `queries.ts` for the same reason `pipe-state.ts` is split from
 * `pipe-status.ts`: `queries.ts` imports the database client at module scope, so
 * importing anything from it in a unit test opens a connection and fails with
 * "DATABASE_URL is not set". The derivation below is arithmetic over rows and
 * deserves plain tests, not a database.
 */

export type AnnotationKind =
  | "stage_remap"
  | "account_added"
  | "account_removed"
  | "spend_jump"
  | "campaign_launched"
  | "campaign_paused";

export interface TrendAnnotation {
  /** `YYYY-MM-DD` in the client's timezone — the chart's own x key. */
  dateKey: string;
  kind: AnnotationKind;
  label: string;
  /** Longer explanation, shown on hover. */
  detail?: string;
}

/** How much a campaign's daily spend must multiply to be worth marking. */
const SPEND_JUMP_FACTOR = 3;
/**
 * Days of history the jump is measured against.
 *
 * 🔴 A single previous day is the wrong baseline, and this was measured rather
 * than assumed. A live account here oscillates between $8 and $57 a day on one
 * campaign at a steady budget — ordinary delivery variance. Compared day to day
 * that produces 3–6× "jumps" repeatedly, so the chart fills with marks for an
 * account where nothing happened, and the layer becomes wallpaper the reader
 * learns to skip.
 *
 * A trailing mean absorbs that variance and still catches what the annotation is
 * for: a budget that was actually changed, which moves the mean and keeps it
 * moved.
 */
export const SPEND_BASELINE_DAYS = 3;
/**
 * Below this baseline, a 3× jump is noise — $2 to $6 is not an event.
 *
 * Modest, because the trailing mean is now doing most of the noise rejection.
 * A high floor here would instead silence small accounts entirely, which is the
 * opposite failure: for a client spending $40 a day, a jump to $120 is genuinely
 * the most significant thing that happened that month.
 */
const SPEND_JUMP_FLOOR = 20;


/** Campaign launches, pauses and ≥3× spend jumps. Pure, so it is testable. */
export function deriveSpendAnnotations(
  rows: Array<{
    date: string;
    campaign_id: string;
    campaign_name: string | null;
    spend: string | number;
  }>,
  windowStartKey: string,
): TrendAnnotation[] {
  const byCampaign = new Map<
    string,
    Array<{ date: string; spend: number; name: string | null }>
  >();
  for (const r of rows) {
    const list = byCampaign.get(r.campaign_id) ?? [];
    list.push({
      date: r.date,
      spend: Number(r.spend) || 0,
      name: r.campaign_name,
    });
    byCampaign.set(r.campaign_id, list);
  }

  const out: TrendAnnotation[] = [];
  for (const [campaignId, daysRaw] of byCampaign) {
    if (!campaignId) continue; // the unattributed bucket is not a campaign
    const days = [...daysRaw].sort((a, b) => a.date.localeCompare(b.date));
    const name = days.find((d) => d.name)?.name ?? campaignId;

    for (let i = 0; i < days.length; i++) {
      const today = days[i];
      const yesterday = i > 0 ? days[i - 1] : null;
      // The lead-in day exists only to give day one a comparison; it is outside
      // the visible range and must never carry a mark of its own.
      if (today.date < windowStartKey) continue;

      if (today.spend > 0 && (!yesterday || yesterday.spend === 0)) {
        // Only call it a launch when we actually saw the silent day before it.
        // Otherwise this is just the first day we have data for, which says
        // nothing about the campaign.
        if (yesterday) {
          out.push({
            dateKey: today.date,
            kind: "campaign_launched",
            label: `${name} started`,
          });
        }
        continue;
      }

      if (today.spend === 0 && yesterday && yesterday.spend > 0) {
        out.push({
          dateKey: today.date,
          kind: "campaign_paused",
          label: `${name} stopped`,
        });
        continue;
      }

      // Measured against the trailing mean, not against yesterday — see
      // SPEND_BASELINE_DAYS for why a single day is the wrong comparison.
      const priorDays = days.slice(Math.max(0, i - SPEND_BASELINE_DAYS), i);
      if (priorDays.length < SPEND_BASELINE_DAYS) continue;
      const baseline =
        priorDays.reduce((s, d) => s + d.spend, 0) / priorDays.length;

      if (baseline >= SPEND_JUMP_FLOOR && today.spend >= baseline * SPEND_JUMP_FACTOR) {
        out.push({
          dateKey: today.date,
          kind: "spend_jump",
          label: `${name} spend ×${(today.spend / baseline).toFixed(1)}`,
          detail: `Daily spend rose from a ${SPEND_BASELINE_DAYS}-day average of ${baseline.toFixed(2)} to ${today.spend.toFixed(2)}.`,
        });
      }
    }
  }
  return out;
}

