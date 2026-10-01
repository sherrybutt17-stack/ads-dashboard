import { describe, it, expect } from "vitest";
import { renderAccessEmail, lifetime, type AccessEmailInput } from "./invite-email";

/*
 * The invite lands in a stranger's inbox carrying strings that people typed:
 * the invitee's name, client names, the agency's own (editable) name. Two rules
 * are therefore load-bearing — nothing typed reaches a header unsanitised, and
 * nothing typed reaches the HTML unescaped — and both fail silently.
 */

const base: AccessEmailInput = {
  kind: "invite",
  agencyName: "Growth Guild",
  name: "Dana",
  inviterName: "Abdul",
  clientNames: ["River Ridge Dental"],
  url: "https://dash.example.com/invite?token=abc.123.sig",
  ttlMs: 7 * 24 * 60 * 60 * 1000,
};

describe("renderAccessEmail", () => {
  it("names the agency, the person, and what they will see", () => {
    const { subject, text } = renderAccessEmail(base);
    expect(subject).toBe("You're invited to Growth Guild's reporting dashboard");
    expect(text).toContain("Hi Dana,");
    expect(text).toContain("Abdul set up a login for you");
    expect(text).toContain("River Ridge Dental");
    expect(text).toContain("7 days");
  });

  it("carries the link in both parts — a text-only reader must still get in", () => {
    const { html, text } = renderAccessEmail(base);
    expect(text).toContain(base.url);
    expect(html).toContain(base.url);
  });

  it("falls back to the agency's name when the sender has none", () => {
    const { text } = renderAccessEmail({ ...base, inviterName: null, name: null });
    expect(text).toContain("Hi,");
    expect(text).toContain("Growth Guild set up a login for you");
  });

  it("lists several dashboards the way a person would", () => {
    const { text } = renderAccessEmail({ ...base, clientNames: ["A", "B", "C"] });
    expect(text).toContain("A, B and C");
  });

  it("says something different for a password link, and that the old one still works", () => {
    const { subject, text } = renderAccessEmail({
      ...base,
      kind: "password",
      ttlMs: 24 * 60 * 60 * 1000,
    });
    expect(subject).toMatch(/^Set a new password/);
    expect(text).toContain("24 hours");
    expect(text).toContain("current password keeps working");
  });

  it("🔴 strips control characters from the agency name before it reaches the subject", () => {
    // The subject is a header at the provider; a newline in it is injection.
    const { subject } = renderAccessEmail({
      ...base,
      agencyName: "Evil\r\nBcc: victim@example.com",
    });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain("Evil Bcc: victim@example.com");
  });

  it("🔴 never lets the invitee's name or a client name reach the subject", () => {
    const { subject } = renderAccessEmail({
      ...base,
      name: "NAME-MARKER",
      clientNames: ["CLIENT-MARKER"],
      inviterName: "INVITER-MARKER",
    });
    expect(subject).not.toMatch(/MARKER/);
  });

  it("🔴 escapes every typed string in the HTML", () => {
    const { html } = renderAccessEmail({
      ...base,
      name: "<script>alert(1)</script>",
      inviterName: "<img src=x onerror=alert(1)>",
      clientNames: ['"><b>bold</b>'],
      agencyName: "A & B <i>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
  });

  it("contains no password — there is none to send", () => {
    const { html, text } = renderAccessEmail(base);
    expect(`${html}\n${text}`.toLowerCase()).not.toMatch(/password:\s|your password is/);
  });
});

describe("lifetime", () => {
  it.each([
    [7 * 24 * 3_600_000, "7 days"],
    [2 * 24 * 3_600_000, "2 days"],
    [24 * 3_600_000, "24 hours"],
    [3_600_000, "1 hour"],
  ])("%d ms → %s", (ms, words) => {
    expect(lifetime(ms)).toBe(words);
  });
});
