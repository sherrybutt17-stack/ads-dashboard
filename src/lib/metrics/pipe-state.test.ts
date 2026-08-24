import { describe, it, expect } from "vitest";
import {
  deriveAdPipeState,
  deriveCrmPipeState,
  RECONCILE_SLA_HOURS,
  SYNC_ASSUMED_DEAD_MINUTES,
  CRM_SILENT_AFTER_DAYS,
  type CrmPipeStatus,
  type SyncRunSummary,
} from "./pipe-state";
import { adPipeState, crmPipeState } from "@/components/DataState";

const NOW = new Date("2026-08-12T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

const run = (
  status: SyncRunSummary["status"],
  h: number,
  error: string | null = null,
): SyncRunSummary => ({ status, startedAt: hoursAgo(h), error });

/*
 * The distinction these tests defend is the whole point of the component: an
 * empty panel must say which KIND of nothing it is. The old spreadsheet showed
 * `SHOWN = 0` for its entire history and nobody could tell that from a real
 * zero. Every case below is one of those confusions, made impossible.
 */
describe("deriveAdPipeState", () => {
  it("reports no accounts as not_connected, never as a failure", () => {
    // Even with a stale failed run left behind by a since-removed account.
    const s = deriveAdPipeState("meta", 0, [run("failed", 100, "boom")], NOW);
    expect(s.state).toBe("not_connected");
    expect(s.lastError).toBeNull();
  });

  it("reports a connected account with no runs as never_synced", () => {
    expect(deriveAdPipeState("meta", 1, [], NOW).state).toBe("never_synced");
  });

  it("reports a failure with no current success as unreachable, carrying the error", () => {
    const s = deriveAdPipeState(
      "meta",
      1,
      [run("failed", 2, "(#190) Invalid OAuth token"), run("success", 200)],
      NOW,
    );
    expect(s.state).toBe("unreachable");
    expect(s.lastError).toBe("(#190) Invalid OAuth token");
  });

  it("does NOT cry unreachable when a recent run succeeded", () => {
    /*
     * Taken from the production log: successes and reaped-abandoned failures
     * interleave hour by hour, because a killed invocation and an unreachable
     * platform both land as `failed`. The figures on screen synced fine; saying
     * "missing, not zero" over them in critical red would be a false alarm.
     */
    const s = deriveAdPipeState(
      "meta",
      1,
      [
        run("failed", 4, "abandoned — no terminal status recorded within 30m"),
        run("success", 8),
      ],
      NOW,
    );
    expect(s.state).toBe("live");
  });

  it("does NOT call an in-progress run a failure", () => {
    // A dashboard opened while the nightly cron is mid-run must not flash red.
    const s = deriveAdPipeState(
      "meta",
      1,
      [run("running", 0.1), run("success", 24)],
      NOW,
    );
    expect(s.state).toBe("live");
  });

  it("sees past an in-progress run to the last terminal failure", () => {
    const s = deriveAdPipeState(
      "meta",
      1,
      [run("running", 0.1), run("failed", 24, "429 rate limited")],
      NOW,
    );
    expect(s.state).toBe("unreachable");
  });
});

/*
 * The post-connect wait.
 *
 * Connecting an ad account used to succeed into silence — the nightly
 * reconciliation might be hours away, so the dashboard rendered a bare empty
 * state and the operator could not tell whether they had done something wrong.
 * `backfilling` splits that into the two situations that want opposite
 * responses: something is happening, wait; versus nothing is scheduled, start
 * it.
 */
describe("deriveAdPipeState — backfilling", () => {
  it("reports a first pull in flight as backfilling, with its age", () => {
    const s = deriveAdPipeState("meta", 1, [run("running", 0.05)], NOW);
    expect(s.state).toBe("backfilling");
    expect(s.runningForMinutes).toBeCloseTo(3, 1);
  });

  it("🔴 a retry after a failure is unreachable, NOT backfilling", () => {
    /*
     * The ordering judgement, pinned. A run in flight after a previous attempt
     * died is a retry, and dressing it as "fetching your history, usually two
     * or three minutes" puts a hopeful spinner over a pipe whose last completed
     * attempt failed. The failure has to win.
     */
    const s = deriveAdPipeState(
      "meta",
      1,
      [run("running", 0.05), run("failed", 1, "(#17) User request limit reached")],
      NOW,
    );
    expect(s.state).toBe("unreachable");
    expect(s.lastError).toBe("(#17) User request limit reached");
  });

  it("🔴 stops believing a running row once it is old enough to be dead", () => {
    /*
     * The reaper only fires at the top of a cron run, so on a nightly schedule
     * a process killed at 02:04 leaves a `running` row that sits there for
     * hours. Trusting the row would show "fetching your data" all night over a
     * job that is not running at all.
     */
    const dead = SYNC_ASSUMED_DEAD_MINUTES / 60 + 0.1;
    expect(deriveAdPipeState("meta", 1, [run("running", dead)], NOW).state).toBe(
      "never_synced",
    );
  });

  it("does not call an ordinary nightly run backfilling once data exists", () => {
    // Only the FIRST fill is a wait worth narrating. A refresh over data that
    // is already on screen must not blank the panel into a progress notice.
    const s = deriveAdPipeState("meta", 1, [run("running", 0.05), run("success", 2)], NOW);
    expect(s.state).toBe("live");
  });

  it("leaves runningForMinutes null in every other state", () => {
    // It is only meaningful while something is in flight; a stale value here
    // would let the copy print a duration for a run that ended.
    expect(deriveAdPipeState("meta", 1, [run("success", 2)], NOW).runningForMinutes).toBeNull();
    expect(deriveAdPipeState("meta", 0, [], NOW).runningForMinutes).toBeNull();
  });
});

describe("deriveAdPipeState — SLA windows and precedence", () => {
  it("is live inside the reconciliation SLA and stale past it", () => {
    expect(
      deriveAdPipeState("meta", 1, [run("success", RECONCILE_SLA_HOURS - 1)], NOW)
        .state,
    ).toBe("live");
    expect(
      deriveAdPipeState("meta", 1, [run("success", RECONCILE_SLA_HOURS + 1)], NOW)
        .state,
    ).toBe("stale");
  });

  it("prefers unreachable over stale — a live fault outranks an old success", () => {
    const s = deriveAdPipeState(
      "meta",
      1,
      [run("failed", 1, "timeout"), run("success", 200)],
      NOW,
    );
    expect(s.state).toBe("unreachable");
  });

  it("is stale, not unreachable, when the only story is an old success", () => {
    const s = deriveAdPipeState("meta", 1, [run("success", 200)], NOW);
    expect(s.state).toBe("stale");
    expect(Math.round(s.hoursSinceSuccess ?? 0)).toBe(200);
  });
});

describe("adPipeState copy", () => {
  const status = (over: Partial<ReturnType<typeof deriveAdPipeState>>) => ({
    ...deriveAdPipeState("meta", 1, [run("success", 1)], NOW),
    ...over,
  });

  it("returns null when the pipe is live, so an empty range may mean paused", () => {
    expect(adPipeState(status({}), { staff: true, slug: "x" })).toBeNull();
  });

  it("🔴 names the right platform — TikTok must never read as Meta", () => {
    /*
     * This copy used to come from `platform === "google" ? "Google Ads" :
     * "Meta"`, so a TikTok panel announced "Meta isn't connected" and "Waiting
     * for the first Meta sync". Wrong platform on the one surface whose entire
     * job is explaining why a region is blank — it would send someone to fix a
     * Facebook connection that was working perfectly.
     */
    for (const [platform, expected] of [
      ["meta", "Meta"],
      ["google", "Google Ads"],
      ["tiktok", "TikTok Ads"],
    ] as const) {
      const copy = adPipeState(status({ platform, state: "not_connected", accounts: 0 }), {
        staff: true,
        slug: "x",
      });
      expect(copy?.title, platform).toBe(`${expected} isn't connected`);
    }
  });

  it("promises a duration while a first import is young", () => {
    const copy = adPipeState(
      status({ state: "backfilling", runningForMinutes: 1 }),
      { staff: true, slug: "x" },
    );
    expect(copy?.tone).toBe("neutral");
    expect(copy?.detail).toMatch(/two or three minutes/);
  });

  it("🔴 stops promising a duration it has already blown past", () => {
    // A progress message still claiming "two or three minutes" at minute twelve
    // reads as a frozen screen, which is the opposite of what it is for.
    const copy = adPipeState(
      status({ state: "backfilling", runningForMinutes: 12 }),
      { staff: true, slug: "x" },
    );
    expect(copy?.detail).not.toMatch(/two or three minutes/);
    expect(copy?.detail).toMatch(/longer than usual/);
  });

  it("offers no fix link while fetching — there is nothing to fix", () => {
    // Every other non-live state links to setup. This one must not: sending
    // someone to press "import" over an import already running invites a
    // duplicate, and implies they did something wrong when they did not.
    const copy = adPipeState(
      status({ state: "backfilling", runningForMinutes: 1 }),
      { staff: true, slug: "acme" },
    );
    expect(copy?.fixHref).toBeUndefined();
  });

  it("says 'missing, not zero' for an unreachable pipe, in BOTH registers", () => {
    const s = status({ state: "unreachable", lastError: "(#190) bad token" });
    for (const staff of [true, false]) {
      const copy = adPipeState(s, { staff, slug: "x" });
      expect(copy?.tone).toBe("critical");
      expect(
        `${copy?.title} ${copy?.detail}`.toLowerCase(),
      ).toContain("missing, not zero");
    }
  });

  it("🔴 diagnoses the failure for an operator without quoting the platform at them", () => {
    /*
     * This used to assert the RAW string reached staff verbatim, which was
     * right while `staff` meant us. Since tenancy it means `isAgencyOperator`,
     * which includes agency owners — customers — and `sync_runs.error` holds
     * whatever killed the job: a Graph error naming our app id, a Google
     * payload carrying our manager account, a Postgres failure written for
     * nobody. So the operator now gets the classified cause and the action,
     * and the raw text lives only behind the superadmin gate in the health
     * checklist. See `health-errors.ts`.
     */
    const s = status({
      state: "unreachable",
      lastError:
        "Error validating access token: The user has not authorized application 1234567890123456.",
    });
    const staffCopy = adPipeState(s, { staff: true, slug: "x" })?.diagnostic ?? "";
    expect(staffCopy).toMatch(/sign-in is no longer valid/);
    expect(staffCopy).toMatch(/Continue with Facebook/);
    expect(staffCopy).not.toMatch(/1234567890123456/);

    // The client register is unchanged: no diagnostic at all.
    expect(adPipeState(s, { staff: false, slug: "x" })?.diagnostic).toBeUndefined();
  });

  it("stays quiet when the stored error means nothing to us", () => {
    // An unclassifiable error yields the generic cause rather than a guess —
    // and never the raw text, which is the whole point of the change above.
    const s = status({ state: "unreachable", lastError: "ORA-06512: at line 1" });
    const copy = adPipeState(s, { staff: true, slug: "x" })?.diagnostic ?? "";
    expect(copy).toMatch(/rejected the request/);
    expect(copy).not.toMatch(/ORA-06512/);
  });

  it("offers a setup link only to staff — a client cannot open that page", () => {
    const s = status({ state: "not_connected", accounts: 0 });
    expect(adPipeState(s, { staff: true, slug: "acme" })?.fixHref).toBe(
      "/c/acme/setup",
    );
    expect(adPipeState(s, { staff: false, slug: "acme" })?.fixHref).toBeUndefined();
  });

  it("keeps 'not connected' calm and 'unreachable' loud — they are not the same event", () => {
    expect(
      adPipeState(status({ state: "not_connected", accounts: 0 }), {
        staff: true,
        slug: "x",
      })?.tone,
    ).toBe("neutral");
    expect(
      adPipeState(status({ state: "stale", hoursSinceSuccess: 50 }), {
        staff: true,
        slug: "x",
      })?.tone,
    ).toBe("warning");
  });
});

describe("deriveCrmPipeState", () => {
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

  it("is never_connected until the first webhook has ever landed", () => {
    expect(deriveCrmPipeState(null, null, NOW).state).toBe("never_connected");
  });

  it("goes silent only past the threshold, not on a normal quiet week", () => {
    const first = daysAgo(200);
    expect(
      deriveCrmPipeState(first, daysAgo(CRM_SILENT_AFTER_DAYS - 1), NOW).state,
    ).toBe("live");
    expect(
      deriveCrmPipeState(first, daysAgo(CRM_SILENT_AFTER_DAYS + 1), NOW).state,
    ).toBe("silent");
  });
});

describe("crmPipeState copy", () => {
  const crm = (over: Partial<CrmPipeStatus>): CrmPipeStatus => ({
    state: "live",
    firstWebhookAt: "2026-01-01T00:00:00Z",
    lastWebhookAt: "2026-08-12T00:00:00Z",
    daysSinceEvent: 0.5,
    ...over,
  });

  it("warns that history cannot be backfilled when no webhook has ever fired", () => {
    const copy = crmPipeState(crm({ state: "never_connected", firstWebhookAt: null }), {
      staff: true,
      slug: "x",
      emptyPanel: true,
    });
    expect(copy?.tone).toBe("warning");
    expect(copy?.detail).toContain("forward");
  });

  it("stays quiet about a silent CRM when the panel actually has data", () => {
    // A quiet fortnight is not a fault; raising it next to a populated panel
    // would be noise, and noise is how a real warning gets ignored.
    const s = crm({ state: "silent", daysSinceEvent: 30 });
    expect(crmPipeState(s, { staff: true, slug: "x", emptyPanel: false })).toBeNull();
    expect(
      crmPipeState(s, { staff: true, slug: "x", emptyPanel: true })?.tone,
    ).toBe("warning");
  });

  it("returns null for a live CRM, so 'no leads' may mean no leads", () => {
    expect(
      crmPipeState(crm({}), { staff: true, slug: "x", emptyPanel: true }),
    ).toBeNull();
  });
});
