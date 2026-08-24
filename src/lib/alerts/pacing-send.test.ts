import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Client } from "@/db/schema";
import type { MonthPacing } from "@/lib/budgets";

/**
 * The sender's orchestration, against a real Postgres.
 *
 * `pacing.ts` decides WHETHER to send and is pure; this file covers the part
 * with side effects, and specifically the ordering that cannot be seen from
 * either module alone:
 *
 * 🔴 **a failed request still records the claim.** A timeout says nothing about
 * what the far end did, so a request that may have been delivered has to be
 * recorded as delivered. Skip the claim on failure and a flapping webhook
 * produces one message per run, forever — a channel that gets muted, taking the
 * lead alerts with it.
 *
 * Stated as an outcome rather than as statement order, deliberately. The source
 * writes the claim before the POST, but moving it after — while still ahead of
 * the failure return — is behaviourally identical, and a test that pinned the
 * line order would fail on a refactor that changed nothing. What must not
 * change is that `ok: false` leaves the claim recorded; a mutation making the
 * write conditional on success fails the case below.
 *
 * The decision, the pacing figures and the outbound POST are all mocked: what
 * is under test is the sequence, not their contents.
 */

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";

const DDL = `
CREATE TABLE clients (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  meta_currency text,
  alert_webhook_encrypted text,
  alerts_enabled boolean NOT NULL DEFAULT false,
  last_pacing_alert_at timestamptz,
  last_pacing_alert_status text
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

vi.mock("@/lib/crypto", () => ({
  decryptNullable: (s: string | null) => (s === null ? null : s.replace(/^enc:/, "")),
}));

/** The outbound request. Captured, never made. */
const post = vi.fn<(url: string, body: unknown) => Promise<{ ok: boolean; detail?: string }>>(
  async () => ({ ok: true }),
);
vi.mock("./send", () => ({
  post: (url: string, body: unknown) => post(url, body),
}));

const loadPacing = vi.fn();
vi.mock("@/lib/budgets", () => ({
  loadPacing: (...args: unknown[]) => loadPacing(...args),
}));

const { alertPacing } = await import("./pacing-send");

const NOW = new Date("2026-08-10T16:00:00Z");

/** Materially underspending, so the pure decision says send. */
function underspending(): MonthPacing {
  return {
    status: "under",
    budget: 3100,
    spendToDate: 500,
    spendThroughYesterday: 495,
    completeDays: 9,
    daysInMonth: 31,
    daysRemaining: 22,
    expectedToDate: 900,
    paceRatio: 0.55,
    projectedSpend: 1705,
    projectionSource: "forecast",
    projectedVariance: -1395,
    remainingBudget: 2600,
    dailyTargetRemaining: 118,
    monthKey: "2026-08",
    currency: "GBP",
    isCurrentMonth: true,
    pipeState: "live",
    spendTrusted: true,
  };
}

const client = (over: Partial<Client> = {}): Client =>
  ({
    id: CLIENT_ID,
    name: "Growth Guild",
    slug: "gg",
    timezone: "America/Los_Angeles",
    metaCurrency: "GBP",
    alertWebhookEncrypted: "enc:https://hooks.slack.com/services/T/B/X",
    alertsEnabled: true,
    lastPacingAlertAt: null,
    lastPacingAlertStatus: null,
    ...over,
  }) as Client;

async function claimRow() {
  const { rows } = (await db.execute(
    sql`SELECT last_pacing_alert_at, last_pacing_alert_status FROM clients WHERE id = ${CLIENT_ID}`,
  )) as unknown as {
    rows: Array<{ last_pacing_alert_at: string | null; last_pacing_alert_status: string | null }>;
  };
  return rows[0];
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
  post.mockClear();
  post.mockResolvedValue({ ok: true });
  loadPacing.mockReset();
  loadPacing.mockResolvedValue(underspending());
  await db.execute(sql`DELETE FROM clients`);
  await db.execute(sql`
    INSERT INTO clients (id, name, slug, timezone, meta_currency, alerts_enabled)
    VALUES (${CLIENT_ID}, 'Growth Guild', 'gg', 'America/Los_Angeles', 'GBP', true)
  `);
});

describe("the cheap gates come first", () => {
  it("costs no queries when alerts are switched off", async () => {
    const out = await alertPacing(client({ alertsEnabled: false }), "meta", NOW);
    expect(out).toEqual({ sent: false, reason: "disabled" });
    expect(loadPacing).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("costs no queries when there is no destination", async () => {
    const out = await alertPacing(client({ alertWebhookEncrypted: null }), "meta", NOW);
    expect(out).toEqual({ sent: false, reason: "no_destination" });
    expect(loadPacing).not.toHaveBeenCalled();
  });

  it("does not post when the pure decision declines", async () => {
    loadPacing.mockResolvedValue({ ...underspending(), status: "on_pace" });
    const out = await alertPacing(client(), "meta", NOW);
    expect(out).toEqual({ sent: false, reason: "on_pace" });
    expect(post).not.toHaveBeenCalled();
    expect((await claimRow()).last_pacing_alert_at).toBeNull();
  });
});

describe("sending", () => {
  it("posts to the destination and records what it said", async () => {
    const out = await alertPacing(client(), "meta", NOW);
    expect(out).toEqual({ sent: true, kind: "under" });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    // The decrypted URL, not the stored ciphertext.
    expect(url).toBe("https://hooks.slack.com/services/T/B/X");
    // Slack shape, and the figures are in it.
    const text = JSON.stringify(body);
    expect(text).toContain("Underspending");
    expect(text).toContain("Growth Guild");

    const row = await claimRow();
    expect(row.last_pacing_alert_status).toBe("under");
    expect(row.last_pacing_alert_at).not.toBeNull();
  });

  it("🔴 records the claim even when the request fails", async () => {
    /*
     * The outcome this file exists for. A timeout says nothing about what the
     * far end did, so a possibly-delivered message must not be retried on every
     * subsequent run. Verified by mutation: making the claim conditional on
     * `result.ok` fails here.
     */
    post.mockResolvedValue({ ok: false, detail: "502" });
    const out = await alertPacing(client(), "meta", NOW);
    expect(out).toMatchObject({ sent: false, reason: "failed" });

    const row = await claimRow();
    expect(row.last_pacing_alert_status).toBe("under");
    expect(row.last_pacing_alert_at).not.toBeNull();
  });

  it("🔴 does NOT burn the claim on a rejected destination", async () => {
    /*
     * The mirror case, and it must behave the opposite way. A URL that is not
     * an allowed host is a configuration error, not a delivery: recording it as
     * an alert sent would silence the real one for a week after the operator
     * fixes the setting.
     */
    const out = await alertPacing(
      client({ alertWebhookEncrypted: "enc:https://evil.example.com/hook" }),
      "meta",
      NOW,
    );
    expect(out).toMatchObject({ sent: false, reason: "bad_destination" });
    expect(post).not.toHaveBeenCalled();
    expect((await claimRow()).last_pacing_alert_at).toBeNull();
  });

  it("respects a cooldown recorded on the client", async () => {
    const yesterday = new Date(NOW.getTime() - 86_400_000);
    const out = await alertPacing(
      client({ lastPacingAlertAt: yesterday, lastPacingAlertStatus: "under" }),
      "meta",
      NOW,
    );
    expect(out).toEqual({ sent: false, reason: "cooldown" });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("nothing here may throw", () => {
  it("reports a failure instead of propagating one", async () => {
    /*
     * This runs inside a cron loop over the whole book. One client's broken
     * pacing query must not abort the run for everyone after them.
     */
    loadPacing.mockRejectedValue(new Error("relation ad_budgets does not exist"));
    const out = await alertPacing(client(), "meta", NOW);
    expect(out).toMatchObject({ sent: false, reason: "failed" });
    expect(String((out as { detail?: string }).detail)).toContain("ad_budgets");
  });
});
