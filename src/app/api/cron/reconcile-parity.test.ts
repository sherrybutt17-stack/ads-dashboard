import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 Every ad platform must have something that re-pulls the past, not just today.
 *
 * TikTok shipped without one. Its only caller was the on-load
 * stale-while-revalidate refresh, which syncs the CURRENT day and nothing else,
 * so every earlier day froze at whatever TikTok had reported the last time
 * somebody opened that particular dashboard — and a day nobody opened was never
 * corrected at all. TikTok credits click-through conversions for up to 28 days,
 * so those numbers were still moving after the page view that captured them, and
 * the dashboard drifted away from TikTok Ads Manager in one direction, silently,
 * behind a green health check.
 *
 * Nothing about that was visible to a typechecker, a lint rule, or any unit
 * test: a platform with no cron is not a broken call site, it is an ABSENT one.
 * The only way to catch it is to assert the set — so this file walks every
 * platform the app supports and requires the whole reconciliation contract of
 * each, and a platform added to `AD_PLATFORMS` without one fails here.
 *
 * Source-level, deliberately: these routes iterate live clients and call the ad
 * APIs, so exercising them needs a database and three sets of credentials.
 */

const CRON = __dirname;
const SRC = join(CRON, "..", "..", "..");

const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

const PLATFORMS = read(SRC, "lib", "platforms.ts");
const WORKFLOW = read(SRC, "..", ".github", "workflows", "reconcile.yml");
const SCHEMA = read(SRC, "db", "schema.ts");

/**
 * One entry per ad platform. `route` is its cron, `marker` the `clients` column
 * that records the last full reconciliation, `column` that marker's SQL name,
 * and `sync` the module that stamps it.
 */
const RECONCILERS = [
  {
    platform: "meta",
    route: "meta-sync/route.ts",
    marker: "lastMetaReconciledAt",
    column: "last_meta_reconciled_at",
    sync: ["lib", "meta", "sync.ts"],
    endpoint: "/api/cron/meta-sync",
  },
  {
    platform: "google",
    route: "google-sync/route.ts",
    marker: "lastGoogleReconciledAt",
    column: "last_google_reconciled_at",
    sync: ["lib", "google", "sync.ts"],
    endpoint: "/api/cron/google-sync",
  },
  {
    platform: "tiktok",
    route: "tiktok-sync/route.ts",
    marker: "lastTiktokReconciledAt",
    column: "last_tiktok_reconciled_at",
    sync: ["lib", "tiktok", "sync.ts"],
    endpoint: "/api/cron/tiktok-sync",
  },
] as const;

describe("every ad platform reconciles", () => {
  it("🔴 the covered set is the supported set", () => {
    /*
     * The assertion the whole file turns on. `AD_PLATFORMS` is what the toggle
     * renders and what the query layer accepts; anything in it that is missing
     * from `RECONCILERS` is a platform whose history cannot self-heal.
     */
    const declared = PLATFORMS.match(/AD_PLATFORMS = \[([^\]]*)\]/)?.[1] ?? "";
    const supported = [...declared.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(supported.length).toBeGreaterThan(0);
    expect(new Set(RECONCILERS.map((r) => r.platform))).toEqual(new Set(supported));
  });

  it.each(RECONCILERS)("$platform has a cron that re-pulls a window", ({ route }) => {
    const src = read(CRON, route);
    // A trailing window, not just today — the entire point of a reconciliation.
    expect(src).toMatch(/trailingWindowInclusive\([A-Z_]*RECONCILE_DAYS/);
    expect(src).toMatch(/isReconcile: true/);
  });

  it.each(RECONCILERS)("$platform gates on its OWN marker", ({ route, marker }) => {
    /*
     * One column per platform. A shared one would let whichever cron ran first
     * mark the client reconciled and make the others skip it permanently — the
     * bug that a single `lastReconciledAt` invites and that no test would show,
     * because each cron in isolation would look perfectly correct.
     */
    const src = read(CRON, route);
    expect(src).toContain(`client.${marker}`);
    for (const other of RECONCILERS) {
      if (other.marker === marker) continue;
      expect(src).not.toContain(`client.${other.marker}`);
    }
  });

  it.each(RECONCILERS)("$platform's marker exists in the schema", ({ marker, column }) => {
    expect(SCHEMA).toContain(marker);
    expect(SCHEMA).toContain(`"${column}"`);
  });

  it.each(RECONCILERS)("$platform stamps the marker only on success", ({ marker, sync }) => {
    /*
     * Stamping before the pull, or in a `finally`, would record a failed run as
     * reconciled and skip the client until the next local day — turning a
     * transient API error into 24 hours of stale figures.
     */
    const src = read(SRC, ...sync);
    expect(src).toMatch(new RegExp(`${marker}: finishedAt`));
    const stamp = src.indexOf(marker);
    const success = src.indexOf('status: "success"');
    expect(stamp).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(-1);
    // The stamp sits inside the success path, above the sync_runs update.
    expect(stamp).toBeLessThan(success);
    expect(src).toMatch(/if \(opts\.isReconcile\)|opts\.isReconcile \?/);
  });

  it.each(RECONCILERS)("$platform's cron requires the secret", ({ route }) => {
    // These endpoints are outside the session gate by design, so the bearer
    // check is the only thing standing in front of every client's data.
    const src = read(CRON, route);
    expect(src).toContain("CRON_SECRET");
    expect(src).toMatch(/safeEqual\(bearer, secret\)/);
    expect(src).toContain("unauthorized");
  });

  it.each(RECONCILERS)("$platform's cron defers rather than dies mid-loop", ({ route }) => {
    // A hard kill at maxDuration runs neither the try nor the catch, stranding
    // sync_runs rows in "running" forever. Reported deferrals are how a client
    // count that has outgrown one invocation becomes visible.
    const src = read(CRON, route);
    expect(src).toContain("DISPATCH_BUDGET_MS");
    expect(src).toMatch(/status: "deferred"/);
    expect(src).toContain("reapAbandonedSyncRuns");
  });
});

describe("the schedule actually calls them", () => {
  /*
   * The routes above can all be perfect and still never run. Vercel's Hobby tier
   * allows two cron jobs, which Meta and Google occupy, so TikTok's ONLY trigger
   * is this workflow — a fact invisible from any TypeScript file.
   */
  it.each(RECONCILERS)("$platform is curled by the reconcile workflow", ({ endpoint }) => {
    expect(WORKFLOW).toContain(endpoint);
  });

  it("every response is checked for deferred clients", () => {
    for (const { platform } of RECONCILERS) {
      expect(WORKFLOW).toContain(`/tmp/${platform}.json`);
    }
    const loop = WORKFLOW.match(/for f in ([^;]*);/)?.[1] ?? "";
    for (const { platform } of RECONCILERS) {
      expect(loop).toContain(`/tmp/${platform}.json`);
    }
  });

  it("fails loudly on an HTTP error rather than ticking green", () => {
    /*
     * `curl -f`: without it a 401 from a rotated CRON_SECRET is a successful
     * workflow run that reconciled nothing.
     *
     * Asserted as "no BARE curl anywhere" rather than as a count of `-fsS`,
     * deliberately. A count has to be edited every time a step is added, and
     * the edit that keeps it passing is the same edit that would hide a step
     * added without the flag.
     */
    const bare = [...WORKFLOW.matchAll(/curl(?! -fsS)([^\n]*)/g)].map((m) => m[0]);
    expect(bare).toEqual([]);
    expect((WORKFLOW.match(/curl -fsS/g) ?? []).length).toBeGreaterThanOrEqual(
      RECONCILERS.length,
    );
  });
});
