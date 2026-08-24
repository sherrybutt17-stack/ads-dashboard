import { describe, it, expect } from "vitest";
import {
  classifyWebhookUrl,
  composeBody,
  composeLines,
  decideAlert,
  FRESH_HOURS,
  MAX_PER_HOUR,
  type AlertContext,
  type AlertLead,
} from "./compose";

/**
 * An alert is read once, out of context, on a phone. Two things ruin it and
 * both are here as fixtures.
 *
 * **Volume.** A backfill re-upserts every contact a client has ever had — 1,600
 * on this deployment — and without an age bound that is 1,600 pings and an
 * abandoned channel by lunchtime.
 *
 * **A URL the server is made to fetch.** This is an SSRF primitive sitting
 * behind a staff form in a public repository, so the allowlist gets more tests
 * than the message does.
 */

const NOW = new Date("2026-08-14T18:00:00.000Z");

const lead = (o: Partial<AlertLead> = {}): AlertLead => ({
  contactId: "c1",
  firstName: "Sarah",
  lastName: "Mitchell",
  email: "sarah@example.com",
  phone: "+15550142",
  leadAt: "2026-08-14T17:45:00.000Z",
  campaignName: "Botox Retargeting — Aug",
  attributed: true,
  nthToday: 3,
  daysSincePrevious: 0.4,
  ...o,
});

const ctx: AlertContext = {
  clientName: "Parfaire",
  clientSlug: "parfaire",
  dashboardUrl: "https://app.example.com/c/parfaire",
};

const decide = (o: Partial<Parameters<typeof decideAlert>[0]> = {}) =>
  decideAlert({
    enabled: true,
    hasDestination: true,
    isPaidLead: true,
    leadAt: "2026-08-14T17:45:00.000Z",
    sentInLastHour: 0,
    now: NOW,
    ...o,
  });

/* ------------------------------------------------------------------ *
 * Where a message may be sent
 * ------------------------------------------------------------------ */

describe("the destination allowlist", () => {
  it("accepts a Slack incoming webhook", () => {
    const r = classifyWebhookUrl("https://hooks.slack.com/services/T0/B0/xyz");
    expect(r.ok).toBe(true);
    expect(r.target).toBe("slack");
  });

  it("accepts a Discord webhook", () => {
    expect(classifyWebhookUrl("https://discord.com/api/webhooks/1/abc").target).toBe(
      "discord",
    );
    expect(classifyWebhookUrl("https://discordapp.com/api/webhooks/1/abc").ok).toBe(true);
  });

  it("🔴 refuses a cloud metadata address", () => {
    /*
     * The canonical SSRF target. An unrestricted webhook field lets whoever can
     * write it make the server fetch this and, through timing or an echoed
     * body, read instance credentials.
     */
    expect(classifyWebhookUrl("https://169.254.169.254/latest/meta-data/").ok).toBe(false);
  });

  it("🔴 refuses loopback and internal hosts", () => {
    for (const u of [
      "https://127.0.0.1/hook",
      "https://localhost:3000/hook",
      "https://10.0.0.5/hook",
      "https://internal.svc.cluster.local/hook",
    ]) {
      expect(classifyWebhookUrl(u).ok).toBe(false);
    }
  });

  it("🔴 refuses a lookalike host", () => {
    /*
     * The reason this is an allowlist of exact hostnames rather than a suffix
     * or substring match: `hooks.slack.com.evil.test` contains the real host and
     * ends in a domain somebody else controls.
     */
    expect(classifyWebhookUrl("https://hooks.slack.com.evil.test/x").ok).toBe(false);
    expect(classifyWebhookUrl("https://evil.test/hooks.slack.com").ok).toBe(false);
    expect(classifyWebhookUrl("https://nothooks.slack.com/x").ok).toBe(false);
  });

  it("🔴 refuses plain http", () => {
    // Lead names and phone numbers in the clear, and the door to internal
    // http-only addresses at the same time.
    expect(classifyWebhookUrl("http://hooks.slack.com/services/T0/B0/xyz").ok).toBe(false);
  });

  it("refuses other schemes outright", () => {
    for (const u of ["file:///etc/passwd", "ftp://hooks.slack.com/x", "javascript:alert(1)"]) {
      expect(classifyWebhookUrl(u).ok).toBe(false);
    }
  });

  it("ignores case and surrounding whitespace in the host", () => {
    const r = classifyWebhookUrl("  https://Hooks.Slack.Com/services/T0/B0/xyz  ");
    expect(r.ok).toBe(true);
  });

  it("explains itself rather than failing silently", () => {
    // Pasted by a person into a form. "Invalid" with no reason is a support
    // ticket; naming the rule is not.
    expect(classifyWebhookUrl("").error).toMatch(/paste/i);
    expect(classifyWebhookUrl("not a url").error).toMatch(/valid/i);
    expect(classifyWebhookUrl("http://hooks.slack.com/x").error).toMatch(/https/i);
    expect(classifyWebhookUrl("https://zapier.com/hooks/x").error).toMatch(/Slack and Discord/);
  });
});

/* ------------------------------------------------------------------ *
 * Whether to send
 * ------------------------------------------------------------------ */

describe("deciding to send", () => {
  it("sends for a fresh paid lead", () => {
    expect(decide().send).toBe(true);
  });

  it("🔴 will not send for a lead that arrived days ago", () => {
    /*
     * The guard against the catastrophic case. A backfill or a reconnection
     * re-upserts every contact the client has, and each one reaches this
     * function — 1,600 of them here. The age bound is what stops that being
     * 1,600 messages.
     */
    const r = decide({ leadAt: "2026-08-10T17:45:00.000Z" });
    expect(r.send).toBe(false);
    expect(r.reason).toBe("stale");
  });

  it("holds the freshness bound exactly", () => {
    const at = (hours: number) =>
      new Date(NOW.getTime() - hours * 3_600_000).toISOString();
    expect(FRESH_HOURS).toBe(6);
    expect(decide({ leadAt: at(FRESH_HOURS - 0.01) }).send).toBe(true);
    expect(decide({ leadAt: at(FRESH_HOURS + 0.01) }).send).toBe(false);
  });

  it("🔴 will not send for a lead dated in the future", () => {
    // Clock skew between GHL and us. A negative age passing an upper-bound-only
    // check would let a badly-stamped historical import through the guard.
    expect(decide({ leadAt: "2026-08-14T19:00:00.000Z" }).send).toBe(false);
  });

  it("treats an unparseable arrival time as stale", () => {
    // NaN fails both comparisons, which is the safe direction: no arrival time
    // is not evidence that something just arrived.
    expect(decide({ leadAt: "not a date" }).send).toBe(false);
  });

  it("🔴 only alerts on leads the dashboard would count", () => {
    /*
     * The same paid-lead definition every figure on the dashboard divides by.
     * An alert for a lead that will not appear in the numbers is a message
     * about something the reader then cannot find — and a client's own
     * referrals are not news the agency needs pushed at them.
     */
    const r = decide({ isPaidLead: false });
    expect(r.send).toBe(false);
    expect(r.reason).toBe("not_paid");
  });

  it("caps the hourly volume", () => {
    /*
     * Ten is asserted literally as well as by the constant. A cap that adapts
     * to whatever the constant happens to be tests nothing, and the number is
     * the whole point: a channel taking a hundred pings an hour is a channel
     * somebody mutes, and then the one that mattered is gone too.
     */
    expect(MAX_PER_HOUR).toBe(10);
    expect(decide({ sentInLastHour: 9 }).send).toBe(true);
    const r = decide({ sentInLastHour: 10 });
    expect(r.send).toBe(false);
    expect(r.reason).toBe("rate_limited");
  });

  it("respects the mute switch and a missing destination", () => {
    expect(decide({ enabled: false }).reason).toBe("disabled");
    expect(decide({ hasDestination: false }).reason).toBe("no_destination");
  });

  it("🔴 checks being switched off before anything else", () => {
    // A muted client must produce no reason to look at their data at all —
    // ordering matters because every other branch below runs a query.
    expect(decide({ enabled: false, isPaidLead: false, leadAt: "x" }).reason).toBe(
      "disabled",
    );
  });
});

/* ------------------------------------------------------------------ *
 * The message
 * ------------------------------------------------------------------ */

describe("what the message says", () => {
  it("leads with the name and carries the phone number", () => {
    // The whole point of the interruption is that somebody rings them, so the
    // number cannot be below the fold or behind a link.
    const lines = composeLines(lead(), ctx);
    expect(lines[0]).toBe("New lead — Sarah Mitchell");
    expect(lines.join("\n")).toContain("+15550142");
  });

  it("falls back through email and phone for an unnamed lead", () => {
    expect(composeLines(lead({ firstName: null, lastName: null }), ctx)[0]).toBe(
      "New lead — sarah@example.com",
    );
    expect(
      composeLines(lead({ firstName: null, lastName: null, email: null }), ctx)[0],
    ).toBe("New lead — +15550142");
    expect(
      composeLines(
        lead({ firstName: null, lastName: null, email: null, phone: null }),
        ctx,
      )[0],
    ).toBe("New lead — Unnamed lead");
  });

  it("🔴 says so when there is no way to contact them", () => {
    // Silence here reads as "the details are in the CRM". They are not, and a
    // lead with no phone and no email is a lead-form problem worth seeing.
    const lines = composeLines(lead({ phone: null, email: null }), ctx);
    expect(lines.join("\n")).toContain("No phone or email");
  });

  it("🔴 names an unattributed lead rather than omitting the campaign", () => {
    /*
     * A blank where the campaign goes reads as "unimportant". A lead with no
     * campaign usually means the ad URL parameters are missing, which is a real
     * setup fault and the panel elsewhere spends a whole section on it.
     */
    const lines = composeLines(lead({ campaignName: null, attributed: false }), ctx);
    expect(lines.join("\n")).toContain("no campaign attributed");
  });

  it("🔴 does not call an attributed lead unattributed just because it has no name", () => {
    /*
     * A lead carrying campaign id 1203… whose name has not synced yet IS
     * attributed. Reporting it as unattributed would announce a working UTM
     * setup as a broken one, in a message read once and never revisited.
     */
    const lines = composeLines(lead({ campaignName: null, attributed: true }), ctx);
    expect(lines.join("\n")).toContain("campaign name not synced");
    expect(lines.join("\n")).not.toContain("no campaign attributed");
  });

  it("counts the lead's place in the day", () => {
    expect(composeLines(lead({ nthToday: 1 }), ctx).join("\n")).toContain("1st today");
    expect(composeLines(lead({ nthToday: 2 }), ctx).join("\n")).toContain("2nd today");
    expect(composeLines(lead({ nthToday: 3 }), ctx).join("\n")).toContain("3rd today");
    expect(composeLines(lead({ nthToday: 4 }), ctx).join("\n")).toContain("4th today");
    // The English exceptions, which a naive suffix table gets wrong.
    expect(composeLines(lead({ nthToday: 11 }), ctx).join("\n")).toContain("11th today");
    expect(composeLines(lead({ nthToday: 12 }), ctx).join("\n")).toContain("12th today");
    expect(composeLines(lead({ nthToday: 13 }), ctx).join("\n")).toContain("13th today");
    expect(composeLines(lead({ nthToday: 21 }), ctx).join("\n")).toContain("21st today");
  });

  it("🔴 flags a pipeline restarting after silence", () => {
    /*
     * The one thing here a CRM notification cannot say. A lead after six quiet
     * days deserves more attention than the fourth of a busy Tuesday, and the
     * gap is the only part of the message that varies with anything the reader
     * does not already know.
     */
    expect(composeLines(lead({ daysSincePrevious: 6.2 }), ctx).join("\n")).toContain(
      "First lead in 6 days",
    );
    expect(composeLines(lead({ daysSincePrevious: null }), ctx).join("\n")).toContain(
      "First lead ever",
    );
  });

  it("stays quiet about the gap on an ordinary day", () => {
    // Said every time, it becomes furniture and stops being read at all.
    expect(composeLines(lead({ daysSincePrevious: 0.4 }), ctx).join("\n")).not.toContain(
      "First lead",
    );
    expect(composeLines(lead({ daysSincePrevious: 2.9 }), ctx).join("\n")).not.toContain(
      "First lead",
    );
  });

  it("🔴 carries no cost figure", () => {
    /*
     * At the instant a lead arrives, today's spend is a partial day and the
     * campaign's lead count is one. A cost per lead computed from that is noise
     * with a decimal point, and an alert is the worst place to put an unstable
     * number: read once, out of context, never revisited.
     */
    const text = composeLines(lead(), ctx).join("\n");
    expect(text).not.toMatch(/\$|cost|CPL/i);
  });

  it("links to the dashboard, and copes without a base URL", () => {
    expect(composeLines(lead(), ctx).join("\n")).toContain(
      "https://app.example.com/c/parfaire",
    );
    const noUrl = composeLines(lead(), { ...ctx, dashboardUrl: null });
    expect(noUrl.join("\n")).not.toContain("http");
  });
});

describe("the body each destination expects", () => {
  it("builds Slack blocks with a plain-text fallback", () => {
    // `text` is what a notification preview and a screen reader use; a blocks
    // payload without it renders as an empty message in both.
    const body = composeBody("slack", lead(), ctx) as {
      text: string;
      blocks: { type: string }[];
    };
    expect(body.text).toContain("Sarah Mitchell");
    expect(body.text).toContain("Parfaire");
    expect(body.blocks[0].type).toBe("section");
  });

  it("builds Discord content", () => {
    const body = composeBody("discord", lead(), ctx) as { content: string };
    expect(body.content).toContain("**New lead — Sarah Mitchell**");
    expect(body.content).toContain("+15550142");
  });

  it("🔴 does not send one body shaped for both", () => {
    /*
     * Sending `text` and `content` together happens to work, because each side
     * ignores the other's key. It is exactly the sort of thing that stops
     * working without an error — a message that silently posts blank.
     */
    expect(composeBody("slack", lead(), ctx)).not.toHaveProperty("content");
    expect(composeBody("discord", lead(), ctx)).not.toHaveProperty("text");
  });

  it("names the client, since one channel may carry several", () => {
    const slack = composeBody("slack", lead(), ctx) as { text: string };
    expect(slack.text).toContain("Parfaire");
  });
});
