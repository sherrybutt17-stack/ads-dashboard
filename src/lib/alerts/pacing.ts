import type { MonthPacing } from "@/lib/budgets";
import type { AlertTarget } from "./compose";

/**
 * Deciding when a budget drift is worth interrupting someone for.
 *
 * The dashboard panel is passive: it is right whenever somebody looks at it,
 * and an agency running a dozen accounts does not look at twelve dashboards
 * every morning. An underspend is only fixable while the month still has days
 * in it, so the value of this alert decays to nothing as the month closes —
 * which is why the guards below are mostly about NOT sending.
 *
 * ── 🔴 The four ways an alert like this destroys its own channel ──────
 *
 * **1 · Alerting too late to matter.** "Projected to underspend by £1,200" on
 * the 30th is a post-mortem wearing an alarm's clothing. `MIN_DAYS_TO_ACT`
 * stops it: with fewer days left than that, there is no move left to make and
 * the message is pure noise.
 *
 * **2 · Alerting on the same thing every day.** A client 20% underspent on the
 * 8th is still 20% underspent on the 9th. Repeating it daily is how a channel
 * gets muted, and a muted channel loses the lead alerts too.
 * `COOLDOWN_DAYS` holds a repeat of the SAME verdict.
 *
 * **3 · Sitting silent through a reversal.** The mirror of the above, and the
 * expensive one: a client that was underspending and is now overspending has a
 * genuinely new problem, and a naive time-based cooldown would swallow it for a
 * week. The recorded STATUS is compared, not just the clock — a change of
 * direction always sends.
 *
 * **4 · Crying underspend over a broken sync.** Pacing divides RECORDED spend
 * by the agreed budget, so a pipe that cannot be reached records nothing and
 * looks exactly like an account that stopped delivering. Waking someone at 9am
 * to tell them a client is underspending, when the truth is that we could not
 * read Meta, is the worst message this feature could send: it is confident, it
 * is actionable, and acting on it means raising budgets on an account that was
 * already spending. `spendTrusted` gates the whole thing.
 *
 * **5 · Firing at the edge of the dashboard's own tolerance.** Pacing calls
 * anything outside ±10% off-pace, which is the right band for a panel someone
 * is deliberately reading. Pushing at that threshold would ping on ordinary
 * delivery lumpiness, so the alert needs a wider one — `ALERT_THRESHOLD`.
 * Between the two lies a deliberate buffer: visible on the dashboard, silent in
 * the channel.
 *
 * Pure and clock-free: every temporal fact arrives as an argument.
 */

/** Days that must remain in the month for an alert to still be actionable. */
export const MIN_DAYS_TO_ACT = 5;

/** Days before the SAME verdict is repeated. */
export const COOLDOWN_DAYS = 7;

/**
 * How far off budget the projection must be to push.
 *
 * Wider than `PACE_TOLERANCE` (0.1) on purpose — see reason 4 above. A drift
 * between the two shows on the dashboard and stays out of the channel.
 */
export const ALERT_THRESHOLD = 0.2;

export type PacingAlertKind =
  /** Projected to finish materially under the agreed budget. */
  | "under"
  /** Projected to finish materially over it. */
  | "over"
  /** The whole budget is already spent with days still to run. */
  | "exhausted";

export type PacingSkipReason =
  | "disabled"
  | "no_destination"
  /** The spend behind the verdict cannot be trusted — see reason 4. */
  | "data_untrusted"
  | "no_budget"
  | "on_pace"
  | "too_early"
  | "too_late"
  | "within_threshold"
  | "cooldown";

export interface PacingAlertDecision {
  send: boolean;
  kind: PacingAlertKind | null;
  reason: PacingSkipReason | null;
}

export interface PacingAlertState {
  /** When the last pacing alert for this client went out. */
  at: Date | null;
  /** What that alert said — compared, so a reversal is never suppressed. */
  status: string | null;
}

export function decidePacingAlert(opts: {
  pacing: MonthPacing;
  alertsEnabled: boolean;
  hasDestination: boolean;
  last: PacingAlertState;
  now: Date;
}): PacingAlertDecision {
  const { pacing, last, now } = opts;
  const skip = (reason: PacingSkipReason): PacingAlertDecision => ({
    send: false,
    kind: null,
    reason,
  });

  if (!opts.alertsEnabled) return skip("disabled");
  if (!opts.hasDestination) return skip("no_destination");

  /*
   * Before any figure is looked at. A verdict computed from spend we could not
   * fetch is not a weaker signal, it is a wrong one pointing the opposite way.
   */
  if (!pacing.spendTrusted) return skip("data_untrusted");

  // Nothing to pace against, and "no budget set" is a settings task rather than
  // an operational alarm — it belongs on the dashboard, not in a channel.
  if (pacing.budget === null) return skip("no_budget");
  if (pacing.status === "no_budget") return skip("no_budget");
  if (pacing.status === "too_early") return skip("too_early");

  /*
   * The budget spent with days still to run is urgent regardless of the
   * projection, and is checked BEFORE the on-pace test: a client can be inside
   * the pace band on the day the money runs out, and "on pace" is not the thing
   * to say about an account that is about to stop delivering.
   */
  const exhausted =
    pacing.remainingBudget === 0 && pacing.daysRemaining > 0 && pacing.spendToDate > 0;

  if (!exhausted && pacing.status === "on_pace") return skip("on_pace");

  // Too late to act on. Deliberately after the exhausted check — money already
  // gone is worth saying on any day of the month, because the account has
  // stopped spending whether or not there is time to change it.
  if (!exhausted && pacing.daysRemaining < MIN_DAYS_TO_ACT) return skip("too_late");

  if (!exhausted) {
    const variance = pacing.projectedVariance;
    // No projection means no claim to make.
    if (variance === null || pacing.budget === 0) return skip("within_threshold");
    if (Math.abs(variance) / pacing.budget < ALERT_THRESHOLD) {
      return skip("within_threshold");
    }
  }

  const kind: PacingAlertKind = exhausted
    ? "exhausted"
    : pacing.status === "over"
      ? "over"
      : "under";

  /*
   * Cooldown, but only for a REPEAT of the same verdict. A change of direction
   * — or a drift that has become an exhausted budget — always gets through.
   */
  if (last.status === kind && last.at) {
    const days = (now.getTime() - last.at.getTime()) / 86_400_000;
    if (days < COOLDOWN_DAYS) return skip("cooldown");
  }

  return { send: true, kind, reason: null };
}

/* ------------------------------------------------------------------ *
 * The message
 * ------------------------------------------------------------------ */

function money(n: number | null, currency: string): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}

export interface PacingAlertContext {
  clientName: string;
  monthLabel: string;
  currency: string;
  /** Absolute dashboard URL, or null when no base URL is configured. */
  dashboardUrl: string | null;
}

/**
 * The lines of the message, headline first.
 *
 * Every one of them carries a number the reader can act on rather than a
 * verdict they have to go and investigate: what is projected, what was agreed,
 * and — the actionable one — what to spend per day for the rest of the month to
 * land on it.
 */
export function composePacingLines(
  kind: PacingAlertKind,
  pacing: MonthPacing,
  ctx: PacingAlertContext,
): string[] {
  const c = ctx.currency;
  const lines: string[] = [];

  if (kind === "exhausted") {
    lines.push(`Budget spent with ${pacing.daysRemaining} days left — ${ctx.clientName}`);
    lines.push(
      `${money(pacing.spendToDate, c)} of a ${money(pacing.budget, c)} budget for ${ctx.monthLabel}.`,
    );
    lines.push("Delivery stops when the account runs dry unless the budget is raised.");
  } else {
    const variance = Math.abs(pacing.projectedVariance ?? 0);
    lines.push(
      `${kind === "under" ? "Underspending" : "Overspending"} — ${ctx.clientName}`,
    );
    lines.push(
      `${ctx.monthLabel}: ${money(pacing.spendToDate, c)} spent of ${money(pacing.budget, c)}, projected to finish ${money(pacing.projectedSpend, c)} — ${money(variance, c)} ${kind === "under" ? "under" : "over"}.`,
    );
    if (pacing.dailyTargetRemaining !== null && pacing.daysRemaining > 0) {
      lines.push(
        `${money(pacing.dailyTargetRemaining, c)}/day over the remaining ${pacing.daysRemaining} days lands on budget.`,
      );
    }
  }

  if (ctx.dashboardUrl) lines.push(ctx.dashboardUrl);
  return lines;
}

/** The same payload shapes the lead alert uses, so one destination serves both. */
export function composePacingBody(
  target: AlertTarget,
  kind: PacingAlertKind,
  pacing: MonthPacing,
  ctx: PacingAlertContext,
): Record<string, unknown> {
  const [headline, ...rest] = composePacingLines(kind, pacing, ctx);

  if (target === "discord") {
    return { content: [`**${headline}**`, ...rest].join("\n") };
  }
  return {
    text: `${headline}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: [`*${headline}*`, ...rest].join("\n") },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: ctx.clientName }] },
    ],
  };
}
