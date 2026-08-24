import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EmailError, emailConfig, emailConfigured, senderProblem, sendEmail } from "./email";
import { renderReportEmail } from "./template";
import type { Period } from "./schedule";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.REPORT_FROM = "reports@growthguild.us";
  delete process.env.RESEND_API_URL;
  delete process.env.REPORT_REPLY_TO;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

const ok = (body: unknown = { id: "msg_1" }) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

const MSG = {
  to: ["owner@example.com"],
  subject: "s",
  html: "<p>h</p>",
  text: "t",
};

describe("configuration", () => {
  it("needs BOTH a key and a from address", () => {
    expect(emailConfigured()).toBe(true);
    delete process.env.REPORT_FROM;
    expect(emailConfigured()).toBe(false);
    process.env.REPORT_FROM = "reports@growthguild.us";
    delete process.env.RESEND_API_KEY;
    expect(emailConfigured()).toBe(false);
  });

  it("honours a URL override", () => {
    process.env.RESEND_API_URL = "https://relay.internal/send";
    expect(emailConfig()?.url).toBe("https://relay.internal/send");
  });
});

describe("senderProblem", () => {
  it("accepts an address on your own domain", () => {
    expect(senderProblem("reports@growthguild.us")).toBeNull();
    expect(senderProblem("Growth Guild <reports@growthguild.us>")).toBeNull();
  });

  it("🔴 refuses a free-mail sender", () => {
    /*
     * Gmail and the rest publish DMARC p=reject, so mail claiming to be from
     * them is REJECTED, not merely filtered. Someone setting this up will reach
     * for their own gmail address first, and the failure would otherwise look
     * like the feature is broken.
     */
    for (const d of ["gmail.com", "yahoo.com", "outlook.com", "icloud.com"]) {
      expect(senderProblem(`me@${d}`)).toMatch(/p=reject/);
    }
  });

  it("refuses something that is not an address", () => {
    expect(senderProblem("not an address")).toMatch(/valid email/);
    expect(senderProblem("")).toMatch(/valid email/);
  });

  it("reads the address out of a display-name form", () => {
    expect(senderProblem("Reports <me@gmail.com>")).toMatch(/p=reject/);
  });
});

describe("sendEmail", () => {
  it("posts to the provider with a bearer token", async () => {
    const spy = stubFetch(async () => ok());
    await sendEmail(MSG);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("resend.com");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
  });

  it("returns the provider's message id", async () => {
    stubFetch(async () => ok({ id: "msg_42" }));
    expect(await sendEmail(MSG)).toEqual({ id: "msg_42" });
  });

  it("🔴 always includes a plain-text part", async () => {
    /*
     * HTML-only mail scores badly with every spam filter, and a client report
     * landing in junk is the failure this feature exists to avoid. It also
     * covers watches, screen readers and text-mode clients.
     */
    const spy = stubFetch(async () => ok());
    await sendEmail(MSG);
    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.text).toBe("t");
    expect(body.html).toBe("<p>h</p>");
  });

  it("🔴 refuses a free-mail sender before calling the provider", async () => {
    process.env.REPORT_FROM = "me@gmail.com";
    const spy = stubFetch(async () => ok());
    await expect(sendEmail(MSG)).rejects.toThrow(/p=reject/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses when unconfigured, without calling anything", async () => {
    delete process.env.RESEND_API_KEY;
    const spy = stubFetch(async () => ok());
    await expect(sendEmail(MSG)).rejects.toThrow(/not configured/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an empty recipient list", async () => {
    const spy = stubFetch(async () => ok());
    await expect(sendEmail({ ...MSG, to: [] })).rejects.toThrow(/No recipients/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("marks a bad key and an unverified domain as configurable", async () => {
    for (const status of [401, 403, 422]) {
      stubFetch(async () => ({
        ok: false,
        status,
        json: async () => ({ message: "nope" }),
      }) as unknown as Response);
      await sendEmail(MSG).catch((e: EmailError) => {
        expect(e.configurable, `status ${status}`).toBe(true);
      });
    }
    expect.assertions(3);
  });

  it("does not blame configuration for a provider outage", async () => {
    stubFetch(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ message: "down" }),
    }) as unknown as Response);
    await sendEmail(MSG).catch((e: EmailError) => {
      expect(e.configurable).toBe(false);
      expect(e.status).toBe(503);
    });
    expect.assertions(2);
  });

  it("survives a provider that answers with no JSON body", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }) as unknown as Response);
    expect(await sendEmail(MSG)).toEqual({ id: null });
  });
});

describe("renderReportEmail", () => {
  const period: Period = {
    startKey: "2026-07-01",
    endKey: "2026-07-31",
    key: "2026-07-31",
    label: "July 2026",
  };
  const base = {
    clientName: "Parfaire",
    period,
    url: "https://app.growthguild.us/r/abc",
    expiresAt: new Date("2026-09-01T00:00:00Z"),
    skipped: [],
  };

  it("names the client and the period in the subject", () => {
    expect(renderReportEmail(base).subject).toBe("Parfaire — July 2026");
  });

  it("🔴 carries no figures at all", () => {
    /*
     * Meta restates for up to 28 days, so a monthly report emailed on the 1st
     * is provisional for most of its life. A number in an email is frozen
     * forever and cannot be corrected; the same number behind the link is
     * resolved when the link is opened.
     */
    const { html, text } = renderReportEmail(base);
    // No currency, no percentages — the only digits are dates.
    expect(html).not.toMatch(/[$£€]\s?\d/);
    expect(text).not.toMatch(/[$£€]\s?\d/);
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("includes the link and its expiry", () => {
    const { html, text } = renderReportEmail(base);
    expect(html).toContain("https://app.growthguild.us/r/abc");
    expect(text).toContain("https://app.growthguild.us/r/abc");
    expect(text).toContain("1 September 2026");
  });

  it("🔴 escapes a client name that contains markup", () => {
    const { html } = renderReportEmail({
      ...base,
      clientName: '<script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the URL too", () => {
    const { html } = renderReportEmail({ ...base, url: 'https://x/"onmouseover=' });
    expect(html).not.toContain('"onmouseover=');
  });

  it("🔴 names a gap rather than hiding it", () => {
    const skipped: Period[] = [
      { startKey: "2026-05-01", endKey: "2026-05-31", key: "2026-05-31", label: "May 2026" },
      { startKey: "2026-06-01", endKey: "2026-06-30", key: "2026-06-30", label: "June 2026" },
    ];
    const { text } = renderReportEmail({ ...base, skipped });
    expect(text).toContain("May 2026");
    expect(text).toContain("June 2026");
    expect(text).toContain("2 earlier periods");
  });

  it("phrases a single missed period in the singular", () => {
    const skipped: Period[] = [
      { startKey: "2026-06-01", endKey: "2026-06-30", key: "2026-06-30", label: "June 2026" },
    ];
    const { text } = renderReportEmail({ ...base, skipped });
    expect(text).toContain("No report went out for June 2026");
    expect(text).not.toContain("earlier periods");
  });

  it("says nothing about gaps when there are none", () => {
    expect(renderReportEmail(base).text).not.toContain("No report went out");
  });

  it("uses tables and inline styles, not modern CSS", () => {
    // Outlook ignores flexbox and grid, and strips <style> blocks.
    const { html } = renderReportEmail(base);
    expect(html).toContain("<table");
    expect(html).not.toContain("display:flex");
    expect(html).not.toContain("display:grid");
    expect(html).not.toContain("<style");
  });
});
