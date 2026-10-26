import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * A workflow without its comments, for the checks on what it DOES. Its
 * comments quote the very `| tee` it no longer runs, which is the point of
 * them.
 */
const withoutComments = (yml: string) => yml.replace(/(^|\s)#.*$/gm, "$1");

const PLATFORMS = read(SRC, "lib", "platforms.ts");
const WORKFLOWS_DIR = join(SRC, "..", ".github", "workflows");
const WORKFLOW = read(WORKFLOWS_DIR, "reconcile.yml");
const WORKFLOW_CODE = withoutComments(WORKFLOW);
/**
 * Every workflow in the repository, for the rules that hold for all of them:
 * each one's log is as public as the next, and a call that fails must fail its
 * step wherever it is made.
 */
const WORKFLOWS = readdirSync(WORKFLOWS_DIR)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, code: withoutComments(read(WORKFLOWS_DIR, name)) }));
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

  it("calls each of them with `curl -fsS`", () => {
    // What that flag buys, and the rest of what every call here must do, is
    // held for every workflow in the repository below.
    expect((WORKFLOW_CODE.match(/curl -fsS/g) ?? []).length).toBeGreaterThanOrEqual(
      RECONCILERS.length,
    );
  });

  it("🔴 one platform's failure does not skip the others", () => {
    /*
     * A failed step skips everything after it unless told otherwise, and this
     * schedule is TikTok's ONLY reconciliation — a Meta timeout must not cost
     * TikTok its night. Every step after the secret check runs on
     * `!cancelled()`, gated on that check alone.
     */
    const steps = WORKFLOW_CODE.split(/\n\s*- name: /).slice(1);
    expect(steps.length).toBeGreaterThan(RECONCILERS.length);
    expect(steps[0]).toMatch(/\n\s*id: secret\n/);
    for (const step of steps.slice(1)) {
      expect(step, step.split("\n")[0]).toContain(
        "if: ${{ !cancelled() && steps.secret.outcome == 'success' }}",
      );
    }
  });
});

describe("every workflow is held to the same rules", () => {
  /*
   * Learned on reconcile.yml, and it was not the only workflow that broke
   * them: the hourly reports.yml piped into `tee` as well, so its send step
   * went green over a 401 too, and it printed every scheduled client, with
   * the email provider's error text, into a log just as public. Asserted per
   * file, so that a workflow added later is held to them the day it lands
   * rather than the day it leaks.
   */
  it("finds the workflows it is checking", () => {
    expect(WORKFLOWS.map((w) => w.name)).toEqual(
      expect.arrayContaining(["reconcile.yml", "reports.yml"]),
    );
  });
});

describe.each(WORKFLOWS)("$name — whose log is public", ({ code }) => {
  const curls = (code.match(/\bcurl\b/g) ?? []).length;

  it("fails loudly on an HTTP error rather than ticking green", () => {
    /*
     * `curl -f`: without it a 401 from a rotated CRON_SECRET is a successful
     * workflow run that did nothing.
     *
     * Necessary, not sufficient — `-f` only sets an exit status, and the next
     * test is about whether anything hears it.
     *
     * Asserted as "no BARE curl anywhere" rather than as a count of `-fsS`,
     * deliberately. A count has to be edited every time a step is added, and
     * the edit that keeps it passing is the same edit that would hide a step
     * added without the flag.
     */
    const bare = [...code.matchAll(/curl(?! -fsS)([^\n]*)/g)].map((m) => m[0]);
    expect(bare).toEqual([]);
  });

  it("🔴 runs every step under pipefail, so that exit status reaches the step", () => {
    /*
     * GitHub runs a step with no `shell` as `bash -e`, without pipefail. Every
     * call used to be piped into `tee`, and a pipeline's status is its last
     * command's — so `-f` failed inside the pipe, tee succeeded, and the step
     * went green. That is how a Meta timeout on 22 Oct finished as a passing
     * run, and how a 401 on the hourly reports run would have surfaced two
     * steps later as a JSONDecodeError. Naming the shell makes GitHub run
     * `bash -eo pipefail`.
     */
    expect(code).toMatch(/\n\s*defaults:\s*\n\s*run:\s*\n\s*shell:\s*bash\s*\n/);
  });

  it("🔴 never prints a response into the log of a public repository", () => {
    /*
     * The responses list every client by slug, and a failure carries the
     * upstream error text — a Graph or Google error, a Resend rejection.
     * `tee` printed them whole into Actions logs that anyone can read. Each
     * body now goes to a file, and the step prints a line of counts read from
     * it.
     */
    expect(code).not.toMatch(/\btee\b/);
    expect(code).not.toMatch(/\bcat\s+\/tmp\//);
    expect((code.match(/-o \/tmp\/[a-z]+\.json/g) ?? []).length).toBe(curls);
  });

  it("🔴 reads only counts, statuses and the fixed note out of a response", () => {
    /*
     * The test above is about how a body reaches the log; this one is about
     * what the workflow's own code then takes out of it. A step that printed
     * `r['client']` and `r.get('reason')` — the very annotations reports.yml
     * used to write — passed the rule above, because it reads the file rather
     * than teeing it. So: every key read is a count, a status or the fixed
     * `skipped` note; `results` is read only to be counted; and nothing dumps
     * a response whole.
     */
    const SAFE = new Set([
      "status", "results", "skipped", "deferred", "sent", "failed", "schedules",
      "domains", "checked", "verified", "expired", "errors",
    ]);
    const keys = [...code.matchAll(/\.get\(\s*['"]([a-z_]+)['"]|\[\s*['"]([a-z_]+)['"]\s*\]/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !SAFE.has(k))).toEqual([]);
    for (const line of code.split("\n").filter((l) => /['"]results['"]/.test(l))) {
      expect(line).toContain("Counter(");
    }
    expect(code).not.toMatch(/\bjq\b|json\.dumps|print\(\s*[a-z]\s*[),]/);
  });

  it("🔴 and no step drops back to a shell without pipefail", () => {
    // A step's own `shell:` overrides the job's `defaults` — `shell: sh` on one
    // step would quietly undo the rule above for that step alone.
    const shells = [...code.matchAll(/^\s*shell:\s*(\S+)/gm)].map((m) => m[1]);
    expect(shells.length).toBeGreaterThan(0);
    expect(shells.filter((s) => s !== "bash")).toEqual([]);
  });

  it("gives the job time for every call in it to run out its own clock", () => {
    // Four 300-second calls cannot fit in a 15-minute job; a job killed by its
    // own timeout reports nothing about the steps it never reached. Every call
    // carries its own limit, or the sum below would leave one out.
    const limits = [...code.matchAll(/--max-time (\d+)/g)].map((m) => Number(m[1]));
    expect(limits).toHaveLength(curls);
    const minutes = Number(code.match(/timeout-minutes:\s*(\d+)/)?.[1]);
    expect(minutes * 60).toBeGreaterThan(limits.reduce((s, n) => s + n, 0));
  });
});

describe("🔴 what the public logs print", () => {
  /*
   * A summary line prints counts, and exactly one string: a response's
   * whole-run `skipped` note — "Google: google not configured" — in place of
   * the counts a skipped run does not have. That is safe only while the note
   * is text fixed in the source. Anything a route fills in at run time, such
   * as an error message, an account id or a client's name, would be
   * published to anyone who looks.
   */
  const ROUTES = readdirSync(CRON).filter((dir) => existsSync(join(CRON, dir, "route.ts")));
  /** Whatever each `skipped:` in a route's source is set to, to the line's end. */
  const notes = (dir: string) =>
    [...read(CRON, dir, "route.ts").matchAll(/\bskipped\s*:(.*)$/gm)].map((m) => m[1].trim());
  const called = (code: string) => [...code.matchAll(/\/api\/cron\/([a-z-]+)/g)].map((m) => m[1]);

  it("reads every route a workflow calls", () => {
    const calls = WORKFLOWS.flatMap(({ name, code }) => called(code).map((dir) => ({ name, dir })));
    expect(calls.length).toBeGreaterThan(0);
    for (const { name, dir } of calls) expect(ROUTES, name).toContain(dir);
  });

  it("🔴 every cron's whole-run skipped note is a fixed string literal", () => {
    const found = ROUTES.flatMap((dir) => notes(dir).map((note) => ({ dir, note })));
    expect(found.length).toBeGreaterThan(0);
    for (const { dir, note } of found) {
      // A plain literal and nothing after it — no template, no variable, no
      // `+ err.message`, no call.
      expect(note, dir).toMatch(/^("[^"\\]*"|'[^'\\]*')\s*([,})]|$)/);
    }
  });

  it("🔴 and no route sets `skipped` any other way", () => {
    /*
     * The literal check above reads `skipped:` and its value on one line, so a
     * shorthand `{ ok: true, skipped }` — whatever the variable held, an error
     * message included — would get past it. Outside quotes (where "skipped" is
     * a per-client status, never printed by name), `skipped` may appear only
     * as a key with a fixed string after it.
     */
    for (const dir of ROUTES) {
      const code = read(CRON, dir, "route.ts")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const m of code.matchAll(/(?<!["'\w])skipped(?![\w"'])/g)) {
        const after = code.slice(m.index! + m[0].length);
        expect(after.slice(0, 60), dir).toMatch(/^\s*:\s*("[^"\\]*"|'[^'\\]*')\s*[,})\n]/);
      }
    }
  });

  it("prints the note, and only as a string, wherever a route can answer with one", () => {
    // The other half of the rule above. "no clients processed" would be wrong
    // for a run that never looked at a client, and only a string is printed.
    for (const { name, code } of WORKFLOWS) {
      if (!called(code).some((dir) => notes(dir).length > 0)) continue;
      expect(code, name).toContain('isinstance(d.get("skipped"), str)');
    }
  });
});
