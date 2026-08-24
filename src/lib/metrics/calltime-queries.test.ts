import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "./__testdb__/harness";
import { windowFromKeys } from "@/lib/dates";
import { CONNECTED_SECONDS } from "./calltime";

/**
 * The call-timing query, against a real Postgres.
 *
 * Three things here can only be checked against a database:
 *
 *   · the two halves are UNIONed, not joined — an hour with arrivals and no
 *     calls, or calls and no arrivals, must both survive, and those are exactly
 *     the hours the panel is about
 *   · hours are bucketed in the CLIENT's timezone, not the server's
 *   · "connected" reads `callDuration`, not `callStatus`, and survives a
 *     non-numeric value without throwing
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let q: typeof import("./queries");

const TZ = "America/Los_Angeles";
/** August, so Los Angeles is UTC-7 and the arithmetic is stated in the tests. */
const WINDOW = windowFromKeys("2026-08-01", "2026-08-31", TZ);

beforeAll(async () => {
  harness = await createTestDb();
  q = await import("./queries");
  await seed();
});

afterAll(async () => {
  await harness?.close();
});

/** An outbound call event at an absolute instant. */
async function call(
  clientId: string,
  iso: string,
  duration: number | string | null,
  over: { messageType?: string; direction?: string; eventType?: string } = {},
) {
  const payload = {
    contactId: "x",
    messageType: over.messageType ?? "CALL",
    direction: over.direction ?? "outbound",
    callStatus: "completed",
    ...(duration === null ? {} : { callDuration: duration }),
  };
  await harness.db.execute(sql`
    INSERT INTO webhook_events (client_id, event_type, received_at, payload, status)
    VALUES (${clientId}, ${over.eventType ?? "OutboundMessage"}, ${iso}::timestamptz,
            ${JSON.stringify(payload)}::jsonb, 'processed')
  `);
}

async function lead(clientId: string, iso: string, ghlId: string) {
  await harness.db.execute(sql`
    INSERT INTO contacts (client_id, ghl_contact_id, tags, ghl_created_at)
    VALUES (${clientId}, ${ghlId}, ARRAY[]::text[], ${iso}::timestamptz)
  `);
}

async function seed() {
  // 9am local = 16:00Z. Three attempts, one of them long enough to count.
  await call(CLIENT_A, "2026-08-05T16:00:00Z", 45);
  await call(CLIENT_A, "2026-08-05T16:30:00Z", 5);
  await call(CLIENT_A, "2026-08-06T16:10:00Z", CONNECTED_SECONDS);

  // 5pm local = 2026-08-07T00:00:00Z — the NEXT day in UTC. One attempt.
  await call(CLIENT_A, "2026-08-07T00:00:00Z", 90);

  // 🔴 A call BEFORE the window. Without it the lower bound is never
  // exercised: every other seeded call is inside August, so an August query
  // excludes July by its upper bound alone and a missing `>=` goes unnoticed.
  await call(CLIENT_A, "2026-07-15T16:00:00Z", 120);

  // A failed call carries no duration at all.
  await call(CLIENT_A, "2026-08-05T16:45:00Z", null);
  // And one where the field is not a number, which must not throw.
  await call(CLIENT_A, "2026-08-05T16:50:00Z", "n/a");

  // Not calls: an SMS, an inbound call, and an inbound message.
  await call(CLIENT_A, "2026-08-05T17:00:00Z", 300, { messageType: "SMS" });
  await call(CLIENT_A, "2026-08-05T17:05:00Z", 300, { direction: "inbound" });
  await call(CLIENT_A, "2026-08-05T17:10:00Z", 300, { eventType: "InboundMessage" });

  // Another client's calls, at an hour A never uses.
  await call(CLIENT_B, "2026-08-05T21:00:00Z", 120);

  // Leads: two at 3pm local (22:00Z) — an hour with NO calls at all.
  await lead(CLIENT_A, "2026-08-05T22:00:00Z", "l1");
  await lead(CLIENT_A, "2026-08-06T22:30:00Z", "l2");
  // One at 9am local, an hour that does have calls.
  await lead(CLIENT_A, "2026-08-05T16:05:00Z", "l3");
  // One outside the window entirely.
  await lead(CLIENT_A, "2026-07-04T16:00:00Z", "l4");
  // And one belonging to another client.
  await lead(CLIENT_B, "2026-08-05T22:00:00Z", "l5");
}

const at = (rows: Awaited<ReturnType<typeof q.getCallTiming>>, hour: number) =>
  rows.find((r) => r.hour === hour);

describe("getCallTiming", () => {
  it("buckets calls by the client's local hour, not UTC", async () => {
    const rows = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    // 16:00Z is 9am in Los Angeles. Bucketed in UTC it would land at 16.
    expect(at(rows, 9)?.attempts).toBe(5);
    expect(at(rows, 16)).toBeUndefined();
  });

  it("🔴 keeps an evening call on its own local day's hour", async () => {
    // 00:00Z on the 7th is 5pm on the 6th in Los Angeles.
    const rows = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    expect(at(rows, 17)?.attempts).toBe(1);
    expect(at(rows, 0)).toBeUndefined();
  });

  it("counts connected from the duration, at the threshold inclusively", async () => {
    const rows = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    // 9am has 45s (yes), 5s (no), exactly the threshold (yes), null, "n/a".
    expect(at(rows, 9)?.connected).toBe(2);
    expect(at(rows, 17)?.connected).toBe(1);
  });

  it("survives a non-numeric or absent duration rather than throwing", async () => {
    const rows = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    // Both are still ATTEMPTS — the call was placed — just not connected ones.
    expect(at(rows, 9)?.attempts).toBe(5);
  });

  it("counts only outbound calls, not SMS or inbound", async () => {
    const rows = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    // 10am local = 17:00Z, where the three non-call events sit.
    expect(at(rows, 10)?.attempts ?? 0).toBe(0);
  });

  it("🔴 keeps an hour that has arrivals and no calls", async () => {
    /*
     * The reason the two halves are UNIONed rather than joined. This hour is
     * the entire point of the panel — leads land in it and nobody calls — and a
     * join on hour would drop it.
     */
    const rows = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    expect(at(rows, 15)).toEqual({ hour: 15, attempts: 0, connected: 0, arrivals: 2 });
  });

  it("keeps an hour that has calls and no arrivals", async () => {
    const rows = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    expect(at(rows, 17)?.arrivals).toBe(0);
    expect(at(rows, 17)?.attempts).toBe(1);
  });

  it("sums both halves onto one row where both exist", async () => {
    const rows = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    expect(at(rows, 9)).toEqual({ hour: 9, attempts: 5, connected: 2, arrivals: 1 });
  });

  it("does not leak another client's calls or leads", async () => {
    const rows = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    // CLIENT_B's call is at 2pm local, an hour A never uses.
    expect(at(rows, 14)).toBeUndefined();
    expect(rows.reduce((a, r) => a + r.arrivals, 0)).toBe(3);
  });

  it("🔴 respects the window at both ends, for calls and for arrivals", async () => {
    const july = windowFromKeys("2026-07-01", "2026-07-31", TZ);
    const jul = await q.getCallTiming(CLIENT_A, TZ, july);
    // July holds exactly one call and one lead; August holds neither of them.
    expect(jul.reduce((a, r) => a + r.attempts, 0)).toBe(1);
    expect(jul.reduce((a, r) => a + r.arrivals, 0)).toBe(1);

    const aug = await q.getCallTiming(CLIENT_A, TZ, WINDOW);
    expect(aug.reduce((a, r) => a + r.attempts, 0)).toBe(6);
    expect(aug.reduce((a, r) => a + r.arrivals, 0)).toBe(3);
  });

  it("reads the same hours through a different timezone", async () => {
    // New York is three hours ahead of Los Angeles, so every bucket shifts.
    const rows = await q.getCallTiming(CLIENT_A, "America/New_York", WINDOW);
    expect(at(rows, 12)?.attempts).toBe(5);
    expect(at(rows, 9)).toBeUndefined();
  });

  it("returns nothing at all for a client with no activity", async () => {
    const rows = await q.getCallTiming(
      "99999999-9999-9999-9999-999999999999",
      TZ,
      WINDOW,
    );
    expect(rows).toEqual([]);
  });
});
