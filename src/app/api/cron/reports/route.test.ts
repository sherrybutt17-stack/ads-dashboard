import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import type { SendOutcome } from "@/lib/reports/send";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * The hourly report cron's answer, as the workflow reads it.
 *
 * 🔴 `failed` is the whole of what the workflow warns on. Its log is public,
 * so it prints counts and never `results`, which name every client — and a
 * count is only worth printing if it is right in both directions: every send
 * that went wrong, and none of the refusals an ordinary hour is full of. It
 * used to be worked out in the YAML, from a list of harmless reasons that
 * nothing kept in step with this route, so a paused client warned every hour.
 *
 * `@/lib/reports/send` is replaced: what each outcome IS, and which of them is
 * a failure, is `send.test.ts`'s to prove. This file is about how the route
 * adds them up. The clients are real rows, read by the route's own query.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

vi.mock("@/lib/reports/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reports/email")>()),
  emailConfigured: () => true,
}));

/** Runs inside the domain refresh: after the route reads its start time, before any send. */
let duringDomainRefresh: () => void = () => {};

vi.mock("@/lib/email-domains/refresh", () => ({
  refreshDomains: async () => {
    duringDomainRefresh();
    return { checked: 0, verified: 0, expired: 0, errors: 0 };
  },
}));

type Schedule = { id: string; clientId: string; platform: string };

/** Every enabled schedule this run sees. */
let schedules: Schedule[] = [];
/** What each schedule's send returns, or throws, by schedule id. */
let outcomes: Record<string, SendOutcome | Error> = {};

vi.mock("@/lib/reports/send", () => ({
  dueSchedules: async () => schedules,
  sendScheduledReport: async (_client: unknown, schedule: Schedule) => {
    const outcome = outcomes[schedule.id];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  },
}));

let GET: typeof import("./route").GET;

const SECRET = "test-cron-secret";
const PERIOD = { key: "2026-07-31", startKey: "2026-07-01", endKey: "2026-07-31", label: "July 2026" };

const call = async () =>
  (
    await GET(
      new NextRequest("https://dash.example.com/api/cron/reports", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    )
  ).json();

/** One client with one schedule, and what sending it will do. */
async function given(
  slug: string,
  outcome: SendOutcome | Error | null,
  status: "active" | "paused" | "archived" = "active",
) {
  const clientId = randomUUID();
  await harness.db.execute(
    sql.raw(
      `INSERT INTO clients (id, name, slug, status) VALUES ('${clientId}', '${slug}', '${slug}', '${status}')`,
    ),
  );
  schedules.push({ id: `schedule-${slug}`, clientId, platform: "meta" });
  if (outcome) outcomes[`schedule-${slug}`] = outcome;
}

beforeAll(async () => {
  harness = await createTestDb();
  process.env.CRON_SECRET = SECRET;
  ({ GET } = await import("./route"));
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  schedules = [];
  outcomes = {};
  await harness.db.execute(sql.raw(`TRUNCATE clients RESTART IDENTITY CASCADE`));
});

describe("GET /api/cron/reports — the failed count", () => {
  it("🔴 counts every send that went wrong, and no refusal", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await given("sent-co", { sent: true, period: PERIOD, recipients: 2, shareLinkId: "link-1" });
      // Due, claimed, and not sent: recorded on the schedule's panel.
      await given("bounced-co", { sent: false, failed: true, reason: "mailbox unavailable" });
      // Threw before anything was recorded.
      await given("threw-co", new Error("connection reset"));
      // The refusals an ordinary hour is made of.
      await given("early-co", { sent: false, reason: "too_early" });
      await given("done-co", { sent: false, reason: "already_sent" });
      await given("raced-co", { sent: false, reason: "already claimed by another run" });
      await given("nobody-co", { sent: false, reason: "no recipients" });
      // Refused by the route itself, never offered to the send — the two the
      // workflow's own list of harmless reasons never had.
      await given("paused-co", null, "paused");
      await given("archived-co", null, "archived");

      const body = await call();

      expect(body).toMatchObject({ ok: true, schedules: 9, sent: 1, failed: 2, deferred: 0 });
      expect(body.results.map((r: { reason?: string }) => r.reason)).toEqual(
        expect.arrayContaining(["client is paused", "client is archived"]),
      );
      // The warning sends a throw's reader to the function logs, so it is there.
      expect(logged.mock.calls.some(([line]) => String(line).includes("threw-co"))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it("🔴 answers with every count the workflow warns on, even when it is 0", async () => {
    /*
     * The workflow reads each count by name and takes an absent one as 0. So a
     * renamed key would fail nothing: it would stop the warning, and an hour
     * with a failed send would read as a quiet one.
     */
    const workflow = readFileSync(
      join(__dirname, "..", "..", "..", "..", "..", ".github", "workflows", "reports.yml"),
      "utf8",
    );
    const keys = [...workflow.matchAll(/\.get\('([a-z]+)',\s*0\)/g)].map((m) => m[1]);
    expect(keys).toEqual(expect.arrayContaining(["deferred", "failed"]));

    await given("early-co", { sent: false, reason: "too_early" });
    const body = await call();

    for (const key of keys) expect(body[key], key).toBe(0);
  });

  it("counts a schedule the run had no time left for as deferred, never failed", async () => {
    // A budget cut is "next hour", not "went wrong": counted as failed, it
    // would raise the failed-sends warning over reports that will still go out.
    await given("late-co", { sent: false, failed: true, reason: "would have bounced" });
    await given("later-co", { sent: true, period: PERIOD, recipients: 1, shareLinkId: "link-2" });
    const real = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    duringDomainRefresh = () => {
      skew = 241_000; // past the route's 240 s budget
    };
    try {
      expect(await call()).toMatchObject({ ok: true, schedules: 2, sent: 0, failed: 0, deferred: 2 });
    } finally {
      clock.mockRestore();
      duringDomainRefresh = () => {};
    }
  });
});
