import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Client } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * Emailing a client their report.
 *
 * ── Why this one is worth the setup ───────────────────────────────────
 *
 * It is the only thing in this system that reaches a real person outside the
 * agency, and its failures are not recoverable by fixing code afterwards. A
 * client who receives the same report three times has already received it three
 * times. A period that is silently never sent is a report nobody notices is
 * missing until someone asks for it.
 *
 * The whole idempotency story is one ordering decision: the `report_sends` row
 * is INSERTED BEFORE the email goes out, and its unique index decides who wins.
 * Two cron invocations racing — which happens on every retry — both compute the
 * same period, and exactly one claims it. Sending first and recording afterwards
 * would send twice and record once.
 *
 * 🔴 The index is PARTIAL: `WHERE status <> 'failed'`. That predicate is the
 * retry story, and it is modelled faithfully in the harness for that reason —
 * as a plain unique index these tests would "prove" the opposite behaviour.
 *
 * Only `./email` is mocked. `isDue`, `mintShareLink`, the branding read and the
 * template all run for real, because the interesting bugs live in how they fit
 * together rather than inside any one of them.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let configured = true;
let sendError: Error | null = null;
const sent: { to: string[]; subject: string; html: string }[] = [];

vi.mock("./email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./email")>();
  return {
    ...actual,
    emailConfigured: () => configured,
    sendEmail: async (msg: { to: string[]; subject: string; html: string }) => {
      if (sendError) throw sendError;
      sent.push(msg);
      return { id: "provider-msg-1" };
    },
  };
});

let mod: typeof import("./send");
let EmailError: typeof import("./email").EmailError;

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const AGENCY = "aaaaaaaa-0000-4000-8000-00000000000a";
const SCHED = "dddddddd-0000-4000-8000-000000000001";
const TZ = "America/Los_Angeles";

/** Well past the send hour, with July 2026 complete — so a monthly is due. */
const NOW = new Date("2026-08-05T18:00:00Z");

const client = (over: Partial<Client> = {}): Client =>
  ({ id: CLIENT_ID, agencyId: AGENCY, slug: "acme", name: "Acme", timezone: TZ, ...over }) as Client;

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const schedule = (over: Record<string, unknown> = {}) =>
  ({
    id: SCHED,
    clientId: CLIENT_ID,
    platform: "meta",
    enabled: true,
    cadence: "monthly",
    sendHour: 8,
    recipients: ["owner@example.com"],
    lastSentPeriod: null,
    linkTtlDays: 30,
    ...over,
  }) as never;

const sends = async () =>
  (
    await run(
      `SELECT period_key, status, error, provider_id, share_link_id, recipients
         FROM report_sends ORDER BY created_at`,
    )
  ).rows;

const schedRow = async () =>
  (
    await run(
      `SELECT last_sent_period, last_sent_at, last_error FROM report_schedules WHERE id = '${SCHED}'`,
    )
  ).rows[0];

beforeAll(async () => {
  harness = await createTestDb();
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.NEXT_PUBLIC_APP_URL = "https://dash.example.com/";
  ({ EmailError } = await import("./email"));
  mod = await import("./send");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  configured = true;
  sendError = null;
  sent.length = 0;
  await run(
    `TRUNCATE report_sends, report_schedules, share_links, client_branding, clients RESTART IDENTITY CASCADE`,
  );
  await run(
    `INSERT INTO clients (id, name, slug, agency_id, timezone) VALUES ('${CLIENT_ID}', 'Acme', 'acme', '${AGENCY}', '${TZ}')`,
  );
  await run(
    `INSERT INTO report_schedules (id, client_id, platform, enabled, cadence, send_hour, recipients)
     VALUES ('${SCHED}', '${CLIENT_ID}', 'meta', true, 'monthly', 8, ARRAY['owner@example.com'])`,
  );
});

/* ------------------------------------------------------------------ *
 * The happy path
 * ------------------------------------------------------------------ */

describe("sendScheduledReport — sending", () => {
  it("sends a link and records the send", async () => {
    const res = await mod.sendScheduledReport(client(), schedule(), NOW);

    expect(res.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["owner@example.com"]);

    const [row] = await sends();
    expect(row).toMatchObject({ status: "sent", provider_id: "provider-msg-1" });
    expect(row.share_link_id).not.toBeNull();
  });

  it("🔴 emails a LINK, never an attachment", async () => {
    await mod.sendScheduledReport(client(), schedule(), NOW);

    /*
     * A PDF in an inbox has no expiry, no revocation, and no way to correct a
     * figure Meta later restates — and Meta restates for up to 28 days, so a
     * monthly report sent on the 1st is provisional for most of its life. The
     * link expires, can be revoked, and resolves at view time.
     */
    expect(sent[0].html).toContain("https://dash.example.com/r/");
    const [link] = (await run(`SELECT expires_at, created_by FROM share_links`)).rows;
    expect(link.expires_at).not.toBeNull();
    expect(link.created_by).toBe("schedule");
  });

  it("advances the schedule pointer and clears any stale error", async () => {
    await run(`UPDATE report_schedules SET last_error = 'a previous failure'`);

    await mod.sendScheduledReport(client(), schedule(), NOW);

    const s = await schedRow();
    expect(s.last_sent_period).toBeTruthy();
    expect(s.last_sent_at).not.toBeNull();
    // Otherwise a fixed fault sits on the settings UI forever.
    expect(s.last_error).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Idempotency — the part that cannot be undone
 * ------------------------------------------------------------------ */

describe("sendScheduledReport — never twice", () => {
  it("🔴 a second run for the same period sends nothing", async () => {
    const first = await mod.sendScheduledReport(client(), schedule(), NOW);
    expect(first.sent).toBe(true);

    /*
     * Passing the ORIGINAL schedule row, with `lastSentPeriod` still null — the
     * shape of a genuine race, where the second invocation read the row before
     * the first one updated it. `isDue` cannot save us here; the unique claim
     * has to.
     */
    const second = await mod.sendScheduledReport(client(), schedule(), NOW);

    expect(second.sent).toBe(false);
    expect(sent).toHaveLength(1);
    expect(await sends()).toHaveLength(1);
  });

  it("🔴 claims the period BEFORE sending, so a crash cannot double-send", async () => {
    sendError = new EmailError("provider exploded", 500, false);

    await mod.sendScheduledReport(client(), schedule(), NOW);

    /*
     * The row exists even though no email went out. That is the right way
     * round: a missing report is visible on the schedule and fixable by hand,
     * whereas a client receiving the same report three times is not
     * recoverable at all.
     */
    expect(sent).toHaveLength(0);
    expect(await sends()).toHaveLength(1);
  });

  it("does not re-send a period the schedule already recorded", async () => {
    const first = await mod.sendScheduledReport(client(), schedule(), NOW);
    if (!first.sent) throw new Error("expected the first send to go out");

    // The ordinary next cron tick: the pointer has advanced, so `isDue` stops
    // it before any claim is attempted.
    const again = await mod.sendScheduledReport(
      client(),
      schedule({ lastSentPeriod: first.period.key }),
      NOW,
    );
    expect(again).toMatchObject({ sent: false, reason: "already_sent" });
    expect(await sends()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Failure and retry
 * ------------------------------------------------------------------ */

describe("sendScheduledReport — failure", () => {
  it("records the failure on both the send and the schedule", async () => {
    sendError = new EmailError("mailbox unavailable", 550, false);

    const res = await mod.sendScheduledReport(client(), schedule(), NOW);

    expect(res).toMatchObject({ sent: false });
    const [row] = await sends();
    expect(row.status).toBe("failed");
    expect(String(row.error)).toMatch(/mailbox unavailable/);
    expect(String((await schedRow()).last_error)).toMatch(/mailbox unavailable/);
  });

  it("🔴 does NOT advance the pointer, so the next run retries the period", async () => {
    sendError = new EmailError("temporary blip", 503, false);
    await mod.sendScheduledReport(client(), schedule(), NOW);

    // Advance the pointer and the report is never sent at all.
    expect((await schedRow()).last_sent_period).toBeNull();
  });

  it("🔴 the failed claim stops blocking, so the retry can actually send", async () => {
    sendError = new EmailError("temporary blip", 503, false);
    await mod.sendScheduledReport(client(), schedule(), NOW);

    sendError = null;
    const retry = await mod.sendScheduledReport(client(), schedule(), NOW);

    /*
     * This is what the partial index buys. If the failed row kept its claim,
     * one provider blip would lose that period permanently — the retry would
     * read "already claimed" forever and the client would never get the report.
     * The failed row stays as history; a fresh claim sits beside it.
     */
    expect(retry.sent).toBe(true);
    expect(sent).toHaveLength(1);
    const rows = await sends();
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "sent"]);
  });

  it("does not leak provider internals into the stored message", async () => {
    sendError = new Error("connect ECONNREFUSED 10.0.0.7:587");

    await mod.sendScheduledReport(client(), schedule(), NOW);

    // Only an EmailError's message is trusted through; anything else becomes a
    // generic line rather than putting infrastructure detail on a settings page.
    const [row] = await sends();
    expect(String(row.error)).not.toMatch(/10\.0\.0\.7/);
    expect(String(row.error)).toMatch(/Could not send/i);
  });
});

/* ------------------------------------------------------------------ *
 * Refusals before anything is claimed
 * ------------------------------------------------------------------ */

describe("sendScheduledReport — refusals", () => {
  it("does nothing when email is not configured", async () => {
    configured = false;
    expect(await mod.sendScheduledReport(client(), schedule(), NOW)).toMatchObject({
      sent: false,
      reason: "email not configured",
    });
    // Claiming a period we cannot possibly send would block the real send once
    // the credentials are added.
    expect(await sends()).toHaveLength(0);
  });

  it("🔴 does nothing when the recipient list is empty", async () => {
    for (const recipients of [[], [""], [null]]) {
      const res = await mod.sendScheduledReport(
        client(),
        schedule({ recipients }),
        NOW,
      );
      expect(res).toMatchObject({ sent: false, reason: "no recipients" });
    }
    expect(await sends()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("does nothing for a disabled schedule", async () => {
    const res = await mod.sendScheduledReport(client(), schedule({ enabled: false }), NOW);
    expect(res).toMatchObject({ sent: false, reason: "disabled" });
    expect(await sends()).toHaveLength(0);
  });

  it("🔴 does nothing before the local send hour", async () => {
    // 13:00Z is 06:00 in LA, before the 08:00 send hour. (06:00Z would be 23:00
    // the previous LOCAL day — already past it, which is how this test first
    // got written the wrong way round.)
    const tooEarly = new Date("2026-08-05T13:00:00Z");

    const res = await mod.sendScheduledReport(client(), schedule({ sendHour: 8 }), tooEarly);

    // The hour is in the CLIENT's timezone, so a report scheduled for 08:00
    // must not go out overnight for them because the server's day has turned.
    expect(res).toMatchObject({ sent: false, reason: "too_early" });
    expect(await sends()).toHaveLength(0);
  });
});

describe("dueSchedules", () => {
  it("returns only enabled schedules", async () => {
    await run(
      `INSERT INTO report_schedules (client_id, platform, enabled) VALUES ('${CLIENT_ID}', 'google', false)`,
    );
    const rows = await mod.dueSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe("meta");
  });
});
