import { describe, it, expect } from "vitest";
import { isDue, lastCompletePeriod, periodsSince } from "./schedule";

const TZ = "America/Los_Angeles";
/** 9am Pacific on Monday 2026-08-03. August 2026 starts on a Saturday. */
const MON_9AM = new Date("2026-08-03T16:00:00Z");

describe("lastCompletePeriod — weekly", () => {
  it("on Monday morning, returns the week that just ended", () => {
    const p = lastCompletePeriod("weekly", TZ, MON_9AM);
    expect(p.startKey).toBe("2026-07-27"); // Monday
    expect(p.endKey).toBe("2026-08-02"); // Sunday
  });

  it("🔴 runs Monday to Sunday, not Sunday to Saturday", () => {
    /*
     * Not a preference. A Sunday-start week splits every weekend across two
     * reports, which makes the weekday-vs-weekend comparison §6.18 shows is
     * real impossible to read — and a business says "last week" meaning the
     * working week that just finished.
     */
    const p = lastCompletePeriod("weekly", TZ, MON_9AM);
    const start = new Date(`${p.startKey}T00:00:00Z`).getUTCDay();
    const end = new Date(`${p.endKey}T00:00:00Z`).getUTCDay();
    expect(start).toBe(1); // Monday
    expect(end).toBe(0); // Sunday
  });

  it("🔴 never returns a period that has not finished", () => {
    // Midweek, the answer is still last week — not "this week so far", which
    // would be three days wearing a week's label.
    const wed = new Date("2026-08-05T16:00:00Z");
    const p = lastCompletePeriod("weekly", TZ, wed);
    expect(p.endKey).toBe("2026-08-02");
    expect(p.endKey < "2026-08-05").toBe(true);
  });

  it("on Sunday, the week that just ended is the PREVIOUS one", () => {
    // Sunday is still in progress until it ends, so it cannot be reported on.
    const sun = new Date("2026-08-02T16:00:00Z");
    const p = lastCompletePeriod("weekly", TZ, sun);
    expect(p.endKey).toBe("2026-07-26");
  });

  it("spans exactly seven days", () => {
    const p = lastCompletePeriod("weekly", TZ, MON_9AM);
    const days =
      (Date.parse(`${p.endKey}T00:00:00Z`) - Date.parse(`${p.startKey}T00:00:00Z`)) /
        86_400_000 +
      1;
    expect(days).toBe(7);
  });

  it("🔴 resolves the week in the CLIENT's timezone, not the server's", () => {
    /*
     * 06:00Z on Monday is still Sunday evening in Los Angeles, so the two zones
     * disagree about which week just ended. Getting this wrong sends a report
     * a day early to half the book.
     */
    const earlyMon = new Date("2026-08-03T06:00:00Z");
    expect(lastCompletePeriod("weekly", "Europe/London", earlyMon).endKey).toBe(
      "2026-08-02",
    );
    expect(lastCompletePeriod("weekly", TZ, earlyMon).endKey).toBe("2026-07-26");
  });
});

describe("lastCompletePeriod — monthly", () => {
  it("returns the whole previous calendar month", () => {
    const p = lastCompletePeriod("monthly", TZ, MON_9AM);
    expect(p.startKey).toBe("2026-07-01");
    expect(p.endKey).toBe("2026-07-31");
    expect(p.label).toBe("July 2026");
  });

  it("handles a short month", () => {
    const march = new Date("2026-03-04T16:00:00Z");
    const p = lastCompletePeriod("monthly", TZ, march);
    expect(p.startKey).toBe("2026-02-01");
    expect(p.endKey).toBe("2026-02-28");
  });

  it("crosses a year boundary", () => {
    const jan = new Date("2026-01-05T16:00:00Z");
    const p = lastCompletePeriod("monthly", TZ, jan);
    expect(p.startKey).toBe("2025-12-01");
    expect(p.endKey).toBe("2025-12-31");
  });

  it("on the last day of a month, still reports the month before", () => {
    const eom = new Date("2026-08-31T16:00:00Z");
    expect(lastCompletePeriod("monthly", TZ, eom).endKey).toBe("2026-07-31");
  });
});

describe("isDue", () => {
  const base = {
    enabled: true,
    cadence: "weekly" as const,
    timezone: TZ,
    sendHour: 8,
    lastSentKey: null,
  };

  it("is due after the send hour, for a period never sent", () => {
    const v = isDue(base, MON_9AM);
    expect(v.due).toBe(true);
    if (v.due) expect(v.period.endKey).toBe("2026-08-02");
  });

  it("is not due before the send hour", () => {
    // 6am Pacific.
    const early = new Date("2026-08-03T13:00:00Z");
    expect(isDue(base, early)).toEqual({ due: false, reason: "too_early" });
  });

  it("🔴 uses >= on the hour, so an hourly cron cannot skip a week", () => {
    /*
     * A cron firing at 08:59 and again at 10:01 never observes hour 9. Sending
     * an hour late is a much smaller failure than never sending at all.
     */
    const late = new Date("2026-08-03T21:00:00Z"); // 2pm local
    expect(isDue(base, late).due).toBe(true);
  });

  it("is not due when disabled, whatever the clock says", () => {
    expect(isDue({ ...base, enabled: false }, MON_9AM)).toEqual({
      due: false,
      reason: "disabled",
    });
  });

  it("🔴 does not send the same period twice", () => {
    // The cron may fire many times in the window. Idempotency starts here.
    const v = isDue({ ...base, lastSentKey: "2026-08-02" }, MON_9AM);
    expect(v).toEqual({ due: false, reason: "already_sent" });
  });

  it("does not resend when the stored key is NEWER than the current period", () => {
    // Clock skew, or a manual send from the future. Never re-send backwards.
    expect(isDue({ ...base, lastSentKey: "2026-09-06" }, MON_9AM).due).toBe(false);
  });

  it("sends again once a new period completes", () => {
    const nextWeek = new Date("2026-08-10T16:00:00Z");
    const v = isDue({ ...base, lastSentKey: "2026-08-02" }, nextWeek);
    expect(v.due).toBe(true);
    if (v.due) expect(v.period.endKey).toBe("2026-08-09");
  });

  describe("🔴 a missed run sends ONE report, not a backlog", () => {
    it("names the periods it skipped rather than sending them", () => {
      /*
       * Three weeks of downtime. Sending all three puts two reports nobody can
       * act on into the inbox alongside the one that matters, and devalues it.
       * The gap is reported instead, so it is visible rather than papered over.
       */
      const threeWeeksLater = new Date("2026-08-24T16:00:00Z");
      const v = isDue({ ...base, lastSentKey: "2026-08-02" }, threeWeeksLater);
      expect(v.due).toBe(true);
      if (!v.due) return;
      expect(v.period.endKey).toBe("2026-08-23");
      expect(v.skipped.map((p) => p.endKey)).toEqual(["2026-08-09", "2026-08-16"]);
    });

    it("skips nothing when the schedule is running normally", () => {
      const v = isDue({ ...base, lastSentKey: "2026-07-26" }, MON_9AM);
      expect(v.due && v.skipped).toEqual([]);
    });

    it("skips nothing on a first-ever send", () => {
      // No history is not a backlog. A new client should not be told that
      // fifty-one weeks were missed.
      const v = isDue(base, MON_9AM);
      expect(v.due && v.skipped).toEqual([]);
    });
  });
});

describe("periodsSince", () => {
  it("is empty when the last send is the current period", () => {
    expect(periodsSince("weekly", TZ, MON_9AM, "2026-08-02")).toEqual([]);
  });

  it("returns oldest first", () => {
    const out = periodsSince("weekly", TZ, new Date("2026-08-24T16:00:00Z"), "2026-08-02");
    expect(out.map((p) => p.endKey)).toEqual([
      "2026-08-09",
      "2026-08-16",
      "2026-08-23",
    ]);
  });

  it("🔴 is bounded, so an abandoned schedule cannot walk back forever", () => {
    const out = periodsSince("weekly", TZ, MON_9AM, null);
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it("bounds monthly the same way", () => {
    const out = periodsSince("monthly", TZ, MON_9AM, null);
    expect(out.length).toBeLessThanOrEqual(12);
  });
});
