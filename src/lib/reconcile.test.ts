import { describe, it, expect, vi } from "vitest";
import { isReconcileOverdue, fitsBeforeDeadline, dispatchReconciles } from "./reconcile";
import { lastLocalHourBoundary } from "./dates";

const LA = "America/Los_Angeles";
const KARACHI = "Asia/Karachi"; // UTC+5, no DST
const KOLKATA = "Asia/Kolkata"; // UTC+5:30 — half-hour offset
const SYDNEY = "Australia/Sydney";



/** LA is UTC-7 in summer, so 10:00 UTC = 03:00 local on the same date. */
const AUG_5_LOCAL_10AM = new Date("2026-08-05T17:00:00Z"); // 10:00 LA
const AUG_5_LOCAL_1AM = new Date("2026-08-05T08:00:00Z"); //  01:00 LA

describe("lastLocalHourBoundary", () => {
  it("resolves to today's boundary once local time has passed it", () => {
    // 10:00 local → the most recent 03:00 local was earlier the same day.
    expect(lastLocalHourBoundary(3, LA, AUG_5_LOCAL_10AM).toISOString()).toBe(
      "2026-08-05T10:00:00.000Z",
    );
  });

  it("falls back to yesterday's boundary when local time is before it", () => {
    // 01:00 local on Aug 5 → the most recent 03:00 local was Aug 4.
    expect(lastLocalHourBoundary(3, LA, AUG_5_LOCAL_1AM).toISOString()).toBe(
      "2026-08-04T10:00:00.000Z",
    );
  });

  it("is exactly at the boundary, not after it", () => {
    const at3am = new Date("2026-08-05T10:00:00Z"); // 03:00:00 LA exactly
    expect(lastLocalHourBoundary(3, LA, at3am).toISOString()).toBe(
      "2026-08-05T10:00:00.000Z",
    );
  });

  it("handles a half-hour offset zone, once per local day", () => {
    // Kolkata is UTC+5:30, so 03:00 local = 21:30 UTC the previous day.
    const now = new Date("2026-08-05T06:00:00Z"); // 11:30 local Aug 5
    expect(lastLocalHourBoundary(3, KOLKATA, now).toISOString()).toBe(
      "2026-08-04T21:30:00.000Z",
    );
  });

  it("still resolves a boundary on a spring-forward day at hour 3", () => {
    // US clocks jump 02:00 → 03:00 on 2027-03-14. Hour 3 exists; hour 2 does not.
    const afterJump = new Date("2027-03-14T18:00:00Z"); // 11:00 LA (PDT)
    const boundary = lastLocalHourBoundary(3, LA, afterJump);
    expect(boundary.toISOString()).toBe("2027-03-14T10:00:00.000Z");
    expect(boundary.getTime()).toBeLessThanOrEqual(afterJump.getTime());
  });
});

describe("isReconcileOverdue", () => {
  it("treats a client that has never been reconciled as overdue", () => {
    expect(isReconcileOverdue(LA, null, 3, AUG_5_LOCAL_10AM)).toBe(true);
  });

  it("is not overdue when reconciled after today's boundary", () => {
    const at330 = new Date("2026-08-05T10:30:00Z"); // 03:30 LA
    expect(isReconcileOverdue(LA, at330, 3, AUG_5_LOCAL_10AM)).toBe(false);
  });

  it("is overdue when the last reconcile was before today's boundary", () => {
    const yesterday330 = new Date("2026-08-04T10:30:00Z"); // 03:30 LA, Aug 4
    expect(isReconcileOverdue(LA, yesterday330, 3, AUG_5_LOCAL_10AM)).toBe(
      true,
    );
  });

  it("is NOT overdue before the local boundary, even a full day after the last run", () => {
    // 01:00 local Aug 5. Yesterday's 03:30 reconcile still satisfies the most
    // recent boundary (Aug 4 03:00) — firing again now would be a duplicate.
    const yesterday330 = new Date("2026-08-04T10:30:00Z");
    expect(isReconcileOverdue(LA, yesterday330, 3, AUG_5_LOCAL_1AM)).toBe(
      false,
    );
  });

  it("judges clients in different timezones independently at the same instant", () => {
    // 2026-08-05T17:00Z — 10:00 in LA, 22:00 in Karachi, 03:00 next day in Sydney.
    const lastRun = new Date("2026-08-05T09:00:00Z");
    const now = new Date("2026-08-05T17:00:00Z");
    // LA boundary (Aug 5 03:00 = 10:00Z) is AFTER lastRun → overdue.
    expect(isReconcileOverdue(LA, lastRun, 3, now)).toBe(true);
    // Karachi boundary (Aug 5 03:00 = Aug 4 22:00Z) is BEFORE lastRun → done.
    expect(isReconcileOverdue(KARACHI, lastRun, 3, now)).toBe(false);
  });

  it("becomes overdue again after the next local boundary passes", () => {
    const run = new Date("2026-08-05T10:30:00Z"); // 03:30 LA Aug 5
    const nextDayNoon = new Date("2026-08-06T19:00:00Z"); // 12:00 LA Aug 6
    expect(isReconcileOverdue(LA, run, 3, nextDayNoon)).toBe(true);
  });

  it("works in a southern-hemisphere zone across the date line", () => {
    // 2026-08-05T17:00Z is 03:00 on Aug 6 in Sydney (UTC+10 in August).
    const now = new Date("2026-08-05T17:00:00Z");
    const beforeBoundary = new Date("2026-08-05T16:00:00Z");
    expect(isReconcileOverdue(SYDNEY, beforeBoundary, 3, now)).toBe(true);
    const afterBoundary = new Date("2026-08-05T17:00:00Z");
    expect(isReconcileOverdue(SYDNEY, afterBoundary, 3, now)).toBe(false);
  });

  it("defaults to hour 3 when no target hour is given", () => {
    const at330 = new Date("2026-08-05T10:30:00Z");
    expect(isReconcileOverdue(LA, at330, undefined, AUG_5_LOCAL_10AM)).toBe(
      false,
    );
  });
});

describe("fitsBeforeDeadline", () => {
  it("🔴 refuses a client whose usual run would outlast the function", () => {
    // King LASIK, 1 Nov 2026: about 95 s, started 238 s in, killed at 300 s.
    expect(fitsBeforeDeadline(238_000, 95_000)).toBe(false);
    // The same client earlier in the run finishes in time: 150 + 95 × 1.25 = 268.75 s.
    expect(fitsBeforeDeadline(150_000, 95_000)).toBe(true);
  });

  it("allows a quarter more than usual, for a slow night", () => {
    expect(fitsBeforeDeadline(180_000, 80_000)).toBe(true); // 180 + 100 = 280, just in
    expect(fitsBeforeDeadline(180_001, 80_000)).toBe(false);
  });

  it("assumes a minute for a client with no recent success", () => {
    expect(fitsBeforeDeadline(205_000, undefined)).toBe(true); // 205 + 75 = 280
    expect(fitsBeforeDeadline(206_000, undefined)).toBe(false);
  });
});

describe("dispatchReconciles", () => {
  const queue = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));
  const opts = (over: Partial<Parameters<typeof dispatchReconciles>[1]> = {}) => ({
    concurrency: 3,
    budgetMs: 240_000,
    usualMs: new Map<string, number>(),
    startedAt: 0,
    now: () => 0,
    busy: async () => false,
    sync: async () => 1,
    ...over,
  });
  const statuses = (res: Awaited<ReturnType<typeof dispatchReconciles>>) =>
    Object.fromEntries(res.map((r) => [r.item.id, r.status]));

  it("runs up to `concurrency` clients at once, and every one of them", async () => {
    let inFlight = 0;
    let peak = 0;
    const sync = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 1;
    };
    const res = await dispatchReconciles(queue(7), opts({ sync }));
    expect(peak).toBe(3);
    expect(res.filter((r) => r.status === "synced")).toHaveLength(7);
  });

  it("starts clients in queue order, longest waiting first", async () => {
    const order: string[] = [];
    await dispatchReconciles(
      queue(5),
      opts({ concurrency: 2, sync: async (c) => (order.push(c.id), 0) }),
    );
    expect(order).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  it("defers a client that cannot finish in time, and still starts a smaller one after it", async () => {
    let t = 0;
    const usualMs = new Map([["c0", 10_000], ["c1", 250_000], ["c2", 10_000]]);
    const sync = async () => ((t += 10_000), 1);
    const res = await dispatchReconciles(
      queue(3),
      opts({ concurrency: 1, usualMs, now: () => t, sync }),
    );
    expect(statuses(res)).toEqual({ c0: "synced", c1: "deferred", c2: "synced" });
  });

  it("always starts a run's first client, however long it usually takes", async () => {
    const res = await dispatchReconciles(queue(1), opts({ usualMs: new Map([["c0", 400_000]]) }));
    expect(res[0].status).toBe("synced");
  });

  it("🔴 lets only one worker take the first-client exemption", async () => {
    // All three workers reach a client at the same moment. Had each counted as
    // "the first", three clients too long for the run would start and be killed.
    const usualMs = new Map(queue(3).map((c) => [c.id, 400_000]));
    const res = await dispatchReconciles(queue(3), opts({ usualMs }));
    expect(res.filter((r) => r.status === "synced")).toHaveLength(1);
    expect(res.filter((r) => r.status === "deferred")).toHaveLength(2);
  });

  it("defers everything once the budget is spent, without asking who is busy", async () => {
    const busy = vi.fn(async () => false);
    const res = await dispatchReconciles(queue(3), opts({ now: () => 241_000, busy }));
    expect(res.every((r) => r.status === "deferred")).toBe(true);
    expect(busy).not.toHaveBeenCalled();
  });

  it("leaves a client another run is reconciling to that run", async () => {
    const sync = vi.fn(async () => 1);
    const res = await dispatchReconciles(
      queue(2),
      opts({ busy: async (c) => c.id === "c0", sync }),
    );
    expect(statuses(res)).toEqual({ c0: "skipped", c1: "synced" });
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("treats a failed busy check as not busy", async () => {
    const busy = async () => {
      throw new Error("connection lost");
    };
    const res = await dispatchReconciles(queue(1), opts({ busy }));
    expect(res[0].status).toBe("synced");
  });

  it("records one client's failure and carries on with the rest", async () => {
    const sync = async (c: { id: string }) => {
      if (c.id === "c1") throw new Error("token expired");
      return 5;
    };
    const res = await dispatchReconciles(queue(3), opts({ sync }));
    expect(statuses(res)).toEqual({ c0: "synced", c1: "failed", c2: "synced" });
    expect(res.find((r) => r.item.id === "c1")?.error).toBe("token expired");
    expect(res.find((r) => r.item.id === "c0")?.rows).toBe(5);
  });

  it("returns nothing for an empty queue", async () => {
    expect(await dispatchReconciles([], opts())).toEqual([]);
  });
});
