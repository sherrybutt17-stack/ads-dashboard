import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";

/**
 * The batched pipe read, against a real Postgres.
 *
 * 🔴 This query re-implements, in SQL, a rule that has already gone wrong once
 * in this codebase. `getAdPipeStatus` used to branch on `platform === "google"`
 * with an else, so TikTok fell into Meta's arm and a healthy Facebook sync
 * rendered a dead TikTok pipe green — a plausible wrong answer over a broken
 * pipe, which is strictly worse than an empty state.
 *
 * The batched version has three chances to reintroduce exactly that: one
 * `UNION ALL` arm per account table, a per-table status rule, and a join from
 * `sync_runs.kind` back to a platform. So this file's real subject is
 * cross-contamination — Meta's runs must never colour TikTok's state, and one
 * client's accounts must never colour another's.
 */

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

const DDL = `
CREATE TABLE meta_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE google_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE tiktok_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  error text
);
`;

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/db", () => ({
  get db() {
    return db;
  },
  schema: {},
}));

const { getBookPipeStates } = await import("./pipe-status");

const NOW = new Date("2026-08-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function addAccount(table: string, clientId: string, status = "active") {
  await db.execute(
    sql`INSERT INTO ${sql.raw(table)} (client_id, status) VALUES (${clientId}, ${status})`,
  );
}

async function addRun(
  clientId: string,
  kind: string,
  status: string,
  startedAt: Date,
) {
  await db.execute(sql`
    INSERT INTO sync_runs (client_id, kind, status, started_at)
    VALUES (${clientId}, ${kind}, ${status}, ${startedAt.toISOString()})
  `);
}

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec("SET timezone = 'UTC';");
  await pg.exec(DDL);
  db = drizzle(pg, { schema });
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  for (const t of [
    "meta_ad_accounts",
    "google_ad_accounts",
    "tiktok_ad_accounts",
    "sync_runs",
  ]) {
    await db.execute(sql`DELETE FROM ${sql.raw(t)}`);
  }
});

describe("which accounts count as connected", () => {
  it("counts only active Meta and Google accounts", async () => {
    await addAccount("meta_ad_accounts", A, "active");
    await addAccount("google_ad_accounts", A, "removed");

    const states = await getBookPipeStates([A], NOW.getTime());
    expect(states.get(`${A}:meta`)!.accounts).toBe(1);
    expect(states.get(`${A}:google`)!.state).toBe("not_connected");
  });

  it("🔴 counts a PAUSED TikTok advertiser as connected", async () => {
    /*
     * TikTok's own reader keeps anything that is not `removed`, while Meta and
     * Google keep an explicit `active`. Copying one rule to all three would
     * report a paused advertiser as disconnected — an empty tab where there is
     * a real, deliberately-paused account.
     */
    await addAccount("tiktok_ad_accounts", A, "paused");
    const states = await getBookPipeStates([A], NOW.getTime());
    expect(states.get(`${A}:tiktok`)!.accounts).toBe(1);
    expect(states.get(`${A}:tiktok`)!.state).not.toBe("not_connected");
  });

  it("drops a removed TikTok advertiser", async () => {
    await addAccount("tiktok_ad_accounts", A, "removed");
    expect((await getBookPipeStates([A], NOW.getTime())).get(`${A}:tiktok`)!.state).toBe(
      "not_connected",
    );
  });

  it("returns an entry for every platform, connected or not", async () => {
    const states = await getBookPipeStates([A], NOW.getTime());
    for (const p of ["meta", "google", "tiktok"]) {
      expect(states.get(`${A}:${p}`)!.state).toBe("not_connected");
    }
  });
});

describe("🔴 one platform's runs never colour another's", () => {
  it("does not let a healthy Meta sync make TikTok look live", async () => {
    /*
     * The exact bug this file exists for: a client with both platforms
     * connected, Meta syncing hourly, TikTok never pulled. TikTok must read
     * `never_synced`, not `live`.
     */
    await addAccount("meta_ad_accounts", A);
    await addAccount("tiktok_ad_accounts", A);
    await addRun(A, "meta_daily", "success", hoursAgo(1));

    const states = await getBookPipeStates([A], NOW.getTime());
    expect(states.get(`${A}:meta`)!.state).toBe("live");
    expect(states.get(`${A}:tiktok`)!.state).toBe("never_synced");
  });

  it("does not let a failing Google sync make Meta look broken", async () => {
    await addAccount("meta_ad_accounts", A);
    await addAccount("google_ad_accounts", A);
    await addRun(A, "meta_daily", "success", hoursAgo(2));
    await addRun(A, "google_daily", "failed", hoursAgo(1));

    const states = await getBookPipeStates([A], NOW.getTime());
    expect(states.get(`${A}:meta`)!.state).toBe("live");
    expect(states.get(`${A}:google`)!.state).toBe("unreachable");
  });

  it("counts a backfill as a full pull, like the per-client reader does", async () => {
    await addAccount("meta_ad_accounts", A);
    await addRun(A, "meta_backfill", "success", hoursAgo(3));
    expect((await getBookPipeStates([A], NOW.getTime())).get(`${A}:meta`)!.state).toBe(
      "live",
    );
  });

  it("ignores the intraday refresh entirely", async () => {
    /*
     * An intraday run fires on any page view, so counting it would let opening
     * a page stand in for a reconciliation that never ran.
     */
    await addAccount("meta_ad_accounts", A);
    await addRun(A, "meta_intraday", "success", hoursAgo(1));
    expect((await getBookPipeStates([A], NOW.getTime())).get(`${A}:meta`)!.state).toBe(
      "never_synced",
    );
  });
});

describe("one client never colours another", () => {
  it("keeps accounts and runs on their own client", async () => {
    await addAccount("meta_ad_accounts", A);
    await addRun(A, "meta_daily", "success", hoursAgo(1));
    await addAccount("meta_ad_accounts", B);
    // B has an account but has never synced.

    const states = await getBookPipeStates([A, B], NOW.getTime());
    expect(states.get(`${A}:meta`)!.state).toBe("live");
    expect(states.get(`${B}:meta`)!.state).toBe("never_synced");
  });
});

describe("freshness", () => {
  it("calls a sync older than the SLA stale, not broken", async () => {
    await addAccount("meta_ad_accounts", A);
    await addRun(A, "meta_daily", "success", hoursAgo(48));
    expect((await getBookPipeStates([A], NOW.getTime())).get(`${A}:meta`)!.state).toBe(
      "stale",
    );
  });

  it("does not call it broken when a failure is followed by a current success", async () => {
    /*
     * The production shape: reaped-abandoned failures interleaved with real
     * successes hour by hour. A failure only matters if nothing succeeded since
     * the data would otherwise have gone stale.
     */
    await addAccount("meta_ad_accounts", A);
    await addRun(A, "meta_daily", "failed", hoursAgo(3));
    await addRun(A, "meta_daily", "success", hoursAgo(1));
    expect((await getBookPipeStates([A], NOW.getTime())).get(`${A}:meta`)!.state).toBe(
      "live",
    );
  });

  it("returns nothing for an empty client list rather than querying", async () => {
    expect((await getBookPipeStates([], NOW.getTime())).size).toBe(0);
  });
});
