import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";
import type { Client } from "@/db/schema";

/**
 * The per-client pipe read, and its agreement with the batched one.
 *
 * ── Why "agreement" is the subject ────────────────────────────────────
 *
 * There are two readers of the same question. `getAdPipeStatus` answers it for
 * one client on the dashboard; `getBookPipeStates` answers it for every client
 * at once on the portfolio screen. They ran different SQL — ten rows in one,
 * fourteen days in the other — and so gave different answers about the same
 * client at the same moment:
 *
 *     client page ->  stale         lastSuccessAt: 2026-07-31
 *     book panel  ->  never_synced  lastSuccessAt: null
 *
 * Neither of those is a rounding difference. `never_synced` says "nothing was
 * ever pulled, start it" about a client holding ninety days of data, and
 * `spendTrusted` in `book-pacing-load.ts` accepts `live` and `stale` only — so
 * the pacing verdict was withheld for exactly the clients that needed one,
 * giving a reason that was not true.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let mod: typeof import("./pipe-status");

const CLIENT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const AGENCY = "aaaaaaaa-0000-4000-8000-00000000000a";

/*
 * Anchored to the real clock, deliberately.
 *
 * Both readers take an explicit `now` for the state machine, so the arithmetic
 * is deterministic either way. But any date filter inside the SQL is evaluated
 * against the DATABASE's `now()`, which no parameter reaches — so a fixture
 * pinned to a fixed calendar date sits an ever-growing distance from it, and a
 * query that wrongly bounds its window stops being caught the day after this
 * file is written.
 */
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const client = (id = CLIENT) =>
  ({ id, slug: "acme", timezone: "UTC", agencyId: AGENCY }) as Client;

async function addRun(kind: string, status: string, at: Date, clientId = CLIENT) {
  await run(
    `INSERT INTO sync_runs (client_id, kind, status, started_at, error)
     VALUES ('${clientId}', '${kind}', '${status}', '${at.toISOString()}',
             ${status === "failed" ? "'boom'" : "NULL"})`,
  );
}

async function addMetaAccount(clientId = CLIENT, status = "active") {
  await run(
    `INSERT INTO meta_ad_accounts (client_id, ad_account_id, status)
     VALUES ('${clientId}', 'act_${Math.abs(status.length * 7 + clientId.length)}${clientId.slice(0, 4)}', '${status}')`,
  );
}

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./pipe-status");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(
    `TRUNCATE sync_runs, meta_ad_accounts, google_ad_accounts, tiktok_ad_accounts
       RESTART IDENTITY CASCADE`,
  );
});

/* ------------------------------------------------------------------ *
 * The two defects
 * ------------------------------------------------------------------ */

describe("getAdPipeStatus", () => {
  it("🔴 finds the last success behind a wall of newer failures", async () => {
    /*
     * The old query was `ORDER BY started_at DESC LIMIT 10`, and the state
     * machine looks for the newest SUCCESS anywhere in what it is handed. Ten
     * newer failures therefore pushed the success off the end and
     * `lastSuccessAt` came back null for a pipe that worked last week.
     *
     * `kickFirstSync` guards on exactly that field, so re-attaching an account
     * after ten failed nights fired a fresh 90-day backfill over data already
     * held — on a rate limit shared with the cron, against a pipe that was
     * failing anyway. Its own comment forbids that.
     */
    await addMetaAccount();
    for (let i = 1; i <= 10; i++) await addRun("meta_daily", "failed", daysAgo(i));
    await addRun("meta_daily", "success", daysAgo(12));

    const pipe = await mod.getAdPipeStatus(client(), "meta", NOW.getTime());
    expect(pipe.lastSuccessAt).not.toBeNull();
    expect(new Date(pipe.lastSuccessAt!).toISOString()).toBe(
      daysAgo(12).toISOString(),
    );
  });

  it("still reports the pipe as unreachable while it is failing", async () => {
    // Finding the old success must not soften the verdict: the newest terminal
    // run failed and no success is current, so the numbers are not trustworthy.
    await addMetaAccount();
    for (let i = 1; i <= 10; i++) await addRun("meta_daily", "failed", daysAgo(i));
    await addRun("meta_daily", "success", daysAgo(12));

    const pipe = await mod.getAdPipeStatus(client(), "meta", NOW.getTime());
    expect(pipe.state).toBe("unreachable");
    expect(pipe.lastError).toBe("boom");
  });

  it("counts a backfill as a full pull", async () => {
    await addMetaAccount();
    await addRun("meta_backfill", "success", daysAgo(0));
    expect((await mod.getAdPipeStatus(client(), "meta", NOW.getTime())).state).toBe("live");
  });

  it("🔴 ignores the intraday refresh", async () => {
    // It fires on any page view and can be killed with the invocation that
    // spawned it, so counting it would let opening a page stand in for a
    // reconciliation that never ran.
    await addMetaAccount();
    await addRun("meta_refresh", "success", daysAgo(0));
    expect((await mod.getAdPipeStatus(client(), "meta", NOW.getTime())).state).toBe("never_synced");
  });

  it("never reads another platform's runs", async () => {
    await addMetaAccount();
    await addRun("google_daily", "success", daysAgo(0));
    expect((await mod.getAdPipeStatus(client(), "meta", NOW.getTime())).state).toBe("never_synced");
  });

  it("never reads another client's runs", async () => {
    await addMetaAccount();
    await addRun("meta_daily", "success", daysAgo(0), OTHER);
    expect((await mod.getAdPipeStatus(client(), "meta", NOW.getTime())).state).toBe("never_synced");
  });

  it("reports no accounts as not_connected, whatever the runs say", async () => {
    await addRun("meta_daily", "failed", daysAgo(1));
    const pipe = await mod.getAdPipeStatus(client(), "meta", NOW.getTime());
    expect(pipe.state).toBe("not_connected");
    expect(pipe.lastError).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Agreement — the property that stops them drifting again
 * ------------------------------------------------------------------ */

describe("🔴 the two readers agree", () => {
  interface Scenario {
    name: string;
    runs: Array<[kind: string, status: string, days: number]>;
    accounts?: number;
  }

  const scenarios: Scenario[] = [
    { name: "never connected", runs: [], accounts: 0 },
    { name: "connected, nothing pulled", runs: [] },
    { name: "synced this morning", runs: [["meta_daily", "success", 0]] },
    { name: "synced three days ago", runs: [["meta_daily", "success", 3]] },
    {
      name: "🔴 last success twenty days ago — the fourteen-day cliff",
      runs: [["meta_daily", "success", 20]],
    },
    {
      name: "last success ninety days ago",
      runs: [["meta_daily", "success", 90]],
    },
    {
      name: "🔴 ten failures on top of an older success",
      runs: [
        ...Array.from(
          { length: 10 },
          (_, i) => ["meta_daily", "failed", i + 1] as [string, string, number],
        ),
        ["meta_daily", "success", 12],
      ],
    },
    {
      /*
       * The only shape that needs the newest-SUCCESS arm on its own merits.
       * With the last success older than any window a query might impose AND
       * newer rows in front of it, a bounded read loses it entirely — while the
       * newest-run and newest-terminal arms both return a failure and cover
       * nothing. This is what a pipe that broke three weeks ago looks like.
       */
      name: "🔴 failures in front of a success older than any plausible window",
      runs: [
        ...Array.from(
          { length: 10 },
          (_, i) => ["meta_daily", "failed", i + 1] as [string, string, number],
        ),
        ["meta_daily", "success", 25],
      ],
    },
    {
      /*
       * And the only shape that needs the newest-TERMINAL arm. The newest row
       * is `running`, so without an older terminal row to compare against, the
       * machine reads a fresh connect and renders "fetching your history" over
       * a pipe whose last completed attempt failed — the hopeful spinner
       * `pipe-state.ts` orders its branches to prevent.
       */
      name: "🔴 a retry running on top of an earlier failure",
      runs: [
        ["meta_daily", "running", 0.005],
        ["meta_daily", "failed", 2],
      ],
    },
    {
      name: "failing now, but a success within the SLA",
      runs: [
        ["meta_daily", "failed", 0],
        ["meta_daily", "success", 0.5],
      ],
    },
    {
      name: "a backfill in flight",
      runs: [["meta_backfill", "running", 0.005]],
    },
    {
      name: "a run stuck running for hours",
      runs: [["meta_backfill", "running", 1]],
    },
    {
      name: "old failure, since removed from view by a newer success",
      runs: [
        ["meta_daily", "success", 1],
        ["meta_daily", "failed", 30],
      ],
    },
  ];

  it.each(scenarios)("$name", async ({ runs, accounts = 1 }) => {
    /*
     * Both readers, same fixture, same clock. This is the assertion that has to
     * survive: the SQL may differ — one client needs a bounded read, a book of
     * forty cannot afford a query each — but the ANSWER may not. A portfolio
     * screen and a client page describing the same pipe differently is not a
     * cosmetic inconsistency; it is two numbers that cannot both be acted on.
     */
    for (let i = 0; i < accounts; i++) await addMetaAccount();
    for (const [kind, status, days] of runs) await addRun(kind, status, daysAgo(days));

    const single = await mod.getAdPipeStatus(client(), "meta", NOW.getTime());
    const batched = (await mod.getBookPipeStates([CLIENT], NOW.getTime())).get(
      `${CLIENT}:meta`,
    );

    expect(batched).toBeDefined();
    expect(batched!.state).toBe(single.state);
    expect(batched!.lastSuccessAt).toBe(single.lastSuccessAt);
    expect(batched!.accounts).toBe(single.accounts);
  });
});
