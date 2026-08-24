import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Client } from "@/db/schema";
import type { AdPipeStatus } from "@/lib/metrics/pipe-state";

/**
 * The import that fires the moment an ad account is attached.
 *
 * Connecting an account used to succeed into silence — the nightly
 * reconciliation might be twelve hours away, so the operator finished the
 * wizard, opened the dashboard, and could not tell whether they had done
 * something wrong or simply needed to wait. This closes that gap.
 *
 * ── Why the guard is the part worth testing ───────────────────────────
 *
 * A 90-day pull is a large number of API calls against a rate limit shared with
 * the nightly cron. Firing one per connect is right exactly once; firing it
 * again when someone re-attaches an account, fixes a typo, or adds a second ad
 * account to a client with three months of history buys no new information and
 * competes with the job that keeps every other client current.
 */

const getAdPipeStatus = vi.fn();
const backfillClientMetrics = vi.fn();
const backfillClientGoogleMetrics = vi.fn();
const syncClientTiktokMetrics = vi.fn();

vi.mock("@/lib/metrics/pipe-status", () => ({ getAdPipeStatus }));
vi.mock("@/lib/meta/sync", () => ({ backfillClientMetrics }));
vi.mock("@/lib/google/sync", () => ({ backfillClientGoogleMetrics }));
vi.mock("@/lib/tiktok/sync", () => ({ syncClientTiktokMetrics }));

const { kickFirstSync, FIRST_SYNC_DAYS } = await import("./first-sync");

const client = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "acme",
  timezone: "America/Los_Angeles",
} as Client;

const pipe = (over: Partial<AdPipeStatus> = {}): AdPipeStatus =>
  ({
    platform: "meta",
    state: "never_synced",
    accounts: 1,
    lastSuccessAt: null,
    lastError: null,
    hoursSinceSuccess: null,
    runningForMinutes: null,
    ...over,
  }) as AdPipeStatus;

beforeEach(() => {
  vi.clearAllMocks();
  getAdPipeStatus.mockResolvedValue(pipe());
});

describe("when it runs", () => {
  it("imports on a genuinely fresh connection", async () => {
    await expect(kickFirstSync(client, "meta")).resolves.toBe("started");
    expect(backfillClientMetrics).toHaveBeenCalledWith(client, FIRST_SYNC_DAYS);
  });

  it.each([
    ["meta", () => backfillClientMetrics],
    ["google", () => backfillClientGoogleMetrics],
    ["tiktok", () => syncClientTiktokMetrics],
  ] as const)("routes %s to its own importer", async (platform, getFn) => {
    /*
     * One assertion per platform because the ancestor of this function branched
     * with a ternary and TikTok fell through into Meta's arm — a client's
     * TikTok tab rendering Meta's data, green, over a table with no rows.
     */
    await kickFirstSync(client, platform);
    expect(getFn()).toHaveBeenCalled();

    for (const other of [
      backfillClientMetrics,
      backfillClientGoogleMetrics,
      syncClientTiktokMetrics,
    ]) {
      if (other !== getFn()) expect(other).not.toHaveBeenCalled();
    }
  });

  it("asks about the platform it was given, not a default", async () => {
    await kickFirstSync(client, "tiktok");
    expect(getAdPipeStatus).toHaveBeenCalledWith(client, "tiktok");
  });

  it("gives TikTok an explicit window, since it has no backfill of its own", async () => {
    // The ordinary sync takes a window, which is all a backfill is here — and
    // it records `tiktok_daily`, which the pipe reader already counts as a full
    // pull. So the status machine sees it exactly as it sees the other two.
    await kickFirstSync(client, "tiktok");
    const [, opts] = syncClientTiktokMetrics.mock.calls[0];
    expect(opts).toMatchObject({
      since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(opts.since < opts.until).toBe(true);
  });
});

describe("🔴 when it must NOT run", () => {
  it("skips a pipe that has already completed a full pull", async () => {
    /*
     * `lastSuccessAt`, not "are there rows": a client can hold metric rows from
     * a since-detached account, and re-importing on top of those is the
     * needless re-pull this guard exists to prevent.
     */
    getAdPipeStatus.mockResolvedValue(
      pipe({ state: "live", lastSuccessAt: new Date().toISOString() }),
    );
    await expect(kickFirstSync(client, "meta")).resolves.toBe("skipped");
    expect(backfillClientMetrics).not.toHaveBeenCalled();
  });

  it("skips a pipe whose success is old but real", async () => {
    // `stale` still means we reached the platform and pulled a window. The
    // nightly reconciliation catches it up; a 90-day re-pull is not needed.
    getAdPipeStatus.mockResolvedValue(
      pipe({
        state: "stale",
        lastSuccessAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      }),
    );
    await expect(kickFirstSync(client, "meta")).resolves.toBe("skipped");
    expect(backfillClientMetrics).not.toHaveBeenCalled();
  });

  it("skips while an import is already in flight", async () => {
    // Two concurrent 90-day imports race each other into the same unique index.
    getAdPipeStatus.mockResolvedValue(pipe({ state: "backfilling" }));
    await expect(kickFirstSync(client, "meta")).resolves.toBe("skipped");
    expect(backfillClientMetrics).not.toHaveBeenCalled();
  });

  it("skips when nothing is connected", async () => {
    getAdPipeStatus.mockResolvedValue(pipe({ state: "not_connected", accounts: 0 }));
    await expect(kickFirstSync(client, "meta")).resolves.toBe("skipped");
    expect(backfillClientMetrics).not.toHaveBeenCalled();
  });

  it("🔴 still imports for a pipe that is failing but never succeeded", async () => {
    /*
     * The other side of the guard, and the reason it keys on `lastSuccessAt`
     * rather than on state. A brand-new account whose first attempt errored has
     * no data at all — skipping it would leave the dashboard permanently empty
     * with nothing scheduled to fill it.
     */
    getAdPipeStatus.mockResolvedValue(
      pipe({ state: "unreachable", lastError: "boom", lastSuccessAt: null }),
    );
    await expect(kickFirstSync(client, "meta")).resolves.toBe("started");
    expect(backfillClientMetrics).toHaveBeenCalled();
  });
});

describe("🔴 when something goes wrong", () => {
  it("reports failure instead of throwing", async () => {
    /*
     * This is called inside `after()`, with the HTTP response already sent and
     * no caller left to catch anything. Throwing would only add an unhandled
     * rejection — and the sync writes its own `sync_runs` row either way, so
     * the failure is already recorded where the health checklist and the
     * dashboard's pipe status will both find it.
     */
    backfillClientMetrics.mockRejectedValue(new Error("meta is down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(kickFirstSync(client, "meta")).resolves.toBe("failed");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("survives the status read itself failing", async () => {
    getAdPipeStatus.mockRejectedValue(new Error("db unavailable"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(kickFirstSync(client, "meta")).resolves.toBe("failed");
    expect(backfillClientMetrics).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
