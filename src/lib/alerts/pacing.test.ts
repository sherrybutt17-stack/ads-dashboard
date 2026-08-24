import { describe, it, expect } from "vitest";
import {
  decidePacingAlert,
  composePacingLines,
  ALERT_THRESHOLD,
  COOLDOWN_DAYS,
  MIN_DAYS_TO_ACT,
  type PacingAlertState,
} from "./pacing";
import { PACE_TOLERANCE } from "@/lib/metrics/pacing";
import type { MonthPacing } from "@/lib/budgets";

/**
 * What this alert must NOT do is most of what it does, so most of these tests
 * assert silence. A channel that pings daily about the same drift gets muted,
 * and it is the lead alerts — the ones with a five-minute half-life — that are
 * lost when it does.
 */

const NOW = new Date("2026-08-10T16:00:00Z");

/** A £3,100 August, mid-month, drifting by whatever `variance` says. */
function pacing(over: Partial<MonthPacing> = {}): MonthPacing {
  const budget = 3100;
  const projected = over.projectedSpend ?? 3100;
  return {
    status: "on_pace",
    budget,
    spendToDate: 908,
    spendThroughYesterday: 900,
    completeDays: 9,
    daysInMonth: 31,
    daysRemaining: 22,
    expectedToDate: 900,
    paceRatio: 1,
    projectedSpend: projected,
    projectionSource: "forecast",
    projectedVariance: projected - budget,
    remainingBudget: budget - 908,
    dailyTargetRemaining: 100,
    monthKey: "2026-08",
    currency: "USD",
    isCurrentMonth: true,
    pipeState: "live",
    spendTrusted: true,
    ...over,
  };
}

const NEVER: PacingAlertState = { at: null, status: null };

function decide(p: MonthPacing, last: PacingAlertState = NEVER, now = NOW) {
  return decidePacingAlert({
    pacing: p,
    alertsEnabled: true,
    hasDestination: true,
    last,
    now,
  });
}

describe("when it stays quiet", () => {
  it("says nothing about a client on pace", () => {
    expect(decide(pacing()).send).toBe(false);
    expect(decide(pacing()).reason).toBe("on_pace");
  });

  it("says nothing when there is no budget to pace against", () => {
    // A settings task, not an operational alarm.
    const p = pacing({ status: "no_budget", budget: null, projectedVariance: null });
    expect(decide(p).reason).toBe("no_budget");
  });

  it("says nothing before the month can be judged", () => {
    expect(decide(pacing({ status: "too_early" })).reason).toBe("too_early");
  });

  it("🔴 says nothing once it is too late to act", () => {
    /*
     * "Projected to underspend by £1,200" on the 30th is a post-mortem wearing
     * an alarm's clothing — there is no move left to make, and the message
     * spends the channel's credibility on nothing.
     */
    const p = pacing({
      status: "under",
      projectedSpend: 2000,
      projectedVariance: -1100,
      daysRemaining: MIN_DAYS_TO_ACT - 1,
    });
    expect(decide(p).reason).toBe("too_late");
  });

  it("🔴 leaves a buffer between the dashboard's band and the channel's", () => {
    /*
     * Pacing calls anything past ±10% off-pace, which is right for a panel
     * someone is deliberately reading. Pushing at that threshold would ping on
     * ordinary delivery lumpiness, so a drift between the two is visible on the
     * dashboard and silent here.
     */
    expect(ALERT_THRESHOLD).toBeGreaterThan(PACE_TOLERANCE);
    const justOffPace = pacing({
      status: "under",
      projectedSpend: 3100 * (1 - (ALERT_THRESHOLD - 0.02)),
    });
    justOffPace.projectedVariance = justOffPace.projectedSpend! - 3100;
    expect(decide(justOffPace).reason).toBe("within_threshold");
  });

  it("🔴 does not repeat the same verdict daily", () => {
    // The client 20% underspent on the 8th is still 20% underspent on the 9th.
    const p = pacing({ status: "under", projectedSpend: 2000, projectedVariance: -1100 });
    const yesterday = { at: new Date(NOW.getTime() - 86_400_000), status: "under" };
    expect(decide(p, yesterday).reason).toBe("cooldown");
  });

  it("respects the destination being switched off", () => {
    const p = pacing({ status: "under", projectedSpend: 2000, projectedVariance: -1100 });
    expect(
      decidePacingAlert({
        pacing: p,
        alertsEnabled: false,
        hasDestination: true,
        last: NEVER,
        now: NOW,
      }).reason,
    ).toBe("disabled");
    expect(
      decidePacingAlert({
        pacing: p,
        alertsEnabled: true,
        hasDestination: false,
        last: NEVER,
        now: NOW,
      }).reason,
    ).toBe("no_destination");
  });
});

describe("when it speaks", () => {
  const under = pacing({
    status: "under",
    projectedSpend: 2000,
    projectedVariance: -1100,
  });

  it("calls a material underspend", () => {
    const d = decide(under);
    expect(d.send).toBe(true);
    expect(d.kind).toBe("under");
  });

  it("calls a material overspend", () => {
    const over = pacing({ status: "over", projectedSpend: 4200, projectedVariance: 1100 });
    expect(decide(over).kind).toBe("over");
  });

  it("🔴 breaks the cooldown when the drift REVERSES", () => {
    /*
     * The expensive silence. A client that was underspending and is now
     * overspending has a genuinely new problem, and a purely time-based
     * cooldown would swallow it for a week.
     */
    const over = pacing({ status: "over", projectedSpend: 4200, projectedVariance: 1100 });
    const yesterday = { at: new Date(NOW.getTime() - 86_400_000), status: "under" };
    expect(decide(over, yesterday).send).toBe(true);
  });

  it("repeats a standing verdict once the cooldown has passed", () => {
    const old = {
      at: new Date(NOW.getTime() - (COOLDOWN_DAYS + 1) * 86_400_000),
      status: "under",
    };
    expect(decide(under, old).send).toBe(true);
  });

  it("🔴 reports an exhausted budget even when the pace band says on-pace", () => {
    /*
     * A client can sit inside ±10% on the very day the money runs out, and "on
     * pace" is not the thing to say about an account that is about to stop
     * delivering.
     */
    const dry = pacing({ status: "on_pace", remainingBudget: 0, spendToDate: 3100 });
    const d = decide(dry);
    expect(d.send).toBe(true);
    expect(d.kind).toBe("exhausted");
  });

  it("reports an exhausted budget even late in the month", () => {
    // Money already gone is worth saying on any day: the account has stopped
    // spending whether or not there is time left to change it.
    const dry = pacing({
      status: "on_pace",
      remainingBudget: 0,
      spendToDate: 3100,
      daysRemaining: 2,
    });
    expect(decide(dry).kind).toBe("exhausted");
  });

  it("does not call a closed month exhausted", () => {
    // No days remaining: nothing is about to stop, the month simply ended.
    const done = pacing({
      status: "on_pace",
      remainingBudget: 0,
      spendToDate: 3100,
      daysRemaining: 0,
    });
    expect(decide(done).send).toBe(false);
  });
});

describe("what the message says", () => {
  const ctx = {
    clientName: "Growth Guild",
    monthLabel: "August 2026",
    currency: "USD",
    dashboardUrl: "https://example.com/c/gg",
  };

  it("leads with the client and carries the numbers to act on", () => {
    const p = pacing({
      status: "under",
      projectedSpend: 2000,
      projectedVariance: -1100,
      dailyTargetRemaining: 100,
    });
    const lines = composePacingLines("under", p, ctx);
    expect(lines[0]).toContain("Growth Guild");
    expect(lines[0]).toContain("Underspending");
    // The agreed figure, the projection and the gap — not just a verdict.
    expect(lines[1]).toContain("$3,100");
    expect(lines[1]).toContain("$2,000");
    expect(lines[1]).toContain("$1,100");
    // The one actionable instruction.
    expect(lines[2]).toContain("$100/day");
    expect(lines.at(-1)).toBe(ctx.dashboardUrl);
  });

  it("says what an exhausted budget means rather than only that it happened", () => {
    const p = pacing({ remainingBudget: 0, spendToDate: 3100, daysRemaining: 12 });
    const lines = composePacingLines("exhausted", p, ctx);
    expect(lines[0]).toContain("12 days left");
    expect(lines.join(" ")).toContain("Delivery stops");
  });

  it("omits the link rather than printing a broken one", () => {
    const lines = composePacingLines("under", pacing(), { ...ctx, dashboardUrl: null });
    expect(lines.some((l) => l.includes("http"))).toBe(false);
  });
});

describe("a broken sync is not an underspend", () => {
  /*
   * 🔴 The worst message this feature could send. Pacing divides RECORDED spend
   * by the agreed budget, so a pipe that cannot be reached records nothing and
   * looks exactly like an account that stopped delivering. Acting on it means
   * raising the budget on an account that was already spending.
   */
  const drifting = pacing({
    status: "under",
    projectedSpend: 2000,
    projectedVariance: -1100,
  });

  it.each(["unreachable", "never_synced", "backfilling", "not_connected"] as const)(
    "stays silent when the pipe is %s",
    (pipeState) => {
      const d = decide({ ...drifting, pipeState, spendTrusted: false });
      expect(d.send).toBe(false);
      expect(d.reason).toBe("data_untrusted");
    },
  );

  it("still speaks when the figures are merely a few hours behind", () => {
    /*
     * `stale` is trusted on purpose: the last sync succeeded, so the numbers are
     * real and a few hours old, and pacing over a whole month is not moved by
     * that. Withholding on it would blank the panel most of the time on the free
     * cron cadence.
     */
    const d = decide({ ...drifting, pipeState: "stale", spendTrusted: true });
    expect(d.send).toBe(true);
  });

  it("checks trust before it checks the budget", () => {
    // Otherwise a client with no budget and a dead pipe would be reported as a
    // budget problem, sending the operator to the wrong settings page.
    const d = decide({
      ...drifting,
      budget: null,
      status: "no_budget",
      spendTrusted: false,
      pipeState: "unreachable",
    });
    expect(d.reason).toBe("data_untrusted");
  });
});
