import { describe, it, expect } from "vitest";
import {
  addressOf,
  displayNameOf,
  dnsZoneOf,
  fullHostName,
  formatFrom,
  normalizeDomain,
  normalizeLocalPart,
  platformSenderName,
  readableFrom,
  statusLabel,
} from "./identity";

const PLATFORM = "Growth Guild <noreply@send.growthguild.agency>";

describe("normalizeDomain", () => {
  it.each([
    ["salmanmarketing.com", "salmanmarketing.com"],
    ["  SalmanMarketing.COM  ", "salmanmarketing.com"],
    ["https://www.salmanmarketing.com/about?x=1", "salmanmarketing.com"],
    ["http://salmanmarketing.com:8080", "salmanmarketing.com"],
    ["salman@salmanmarketing.com", "salmanmarketing.com"],
    ["salmanmarketing.com.", "salmanmarketing.com"],
    ["mail.salmanmarketing.co.uk", "mail.salmanmarketing.co.uk"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
  ])("accepts %j as %j", (input, out) => {
    expect(normalizeDomain(input)).toEqual({ ok: true, domain: out });
  });

  it.each([
    [""],
    ["localhost"],
    ["192.168.1.10"],
    ["[::1]"],
    ["-bad.com"],
    ["bad-.com"],
    ["under_score.com"],
    ["bücher.example"],
    ["example.c0m"],
    [`${"a".repeat(64)}.com`],
  ])("rejects %j with a sentence", (input) => {
    const r = normalizeDomain(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\.$/);
  });

  it("🔴 refuses a public email service", () => {
    // Nobody can verify gmail.com, and trying would only fail at Resend later.
    for (const d of ["gmail.com", "Outlook.com", "me@yahoo.com", "x.icloud.com"]) {
      const r = normalizeDomain(d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/public email service/);
    }
  });

  it("🔴 refuses our own sending domain and anything under it", () => {
    // An agency must never be able to claim the address everyone else's
    // fallback mail goes out from.
    for (const d of ["send.growthguild.agency", "x.send.growthguild.agency"]) {
      const r = normalizeDomain(d, { platformFrom: PLATFORM });
      expect(r.ok).toBe(false);
    }
    expect(normalizeDomain("growthguild.agency", { platformFrom: PLATFORM }).ok).toBe(true);
  });
});

describe("normalizeLocalPart", () => {
  it("accepts ordinary mailbox names, lower-cased", () => {
    expect(normalizeLocalPart(" Reports ")).toEqual({ ok: true, local: "reports" });
    expect(normalizeLocalPart("hello.team")).toEqual({ ok: true, local: "hello.team" });
    expect(normalizeLocalPart("no-reply+dash")).toEqual({ ok: true, local: "no-reply+dash" });
  });

  it.each([[""], [".reports"], ["reports."], ["re..ports"], ["re ports"], ["re@ports"], ['re"ports'], ["a".repeat(65)]])(
    "rejects %j",
    (input) => {
      expect(normalizeLocalPart(input).ok).toBe(false);
    },
  );
});

describe("formatFrom", () => {
  it("writes a plain name unquoted — the shape production already sends", () => {
    expect(formatFrom("Salman Marketing", "reports@salman.com")).toBe(
      "Salman Marketing <reports@salman.com>",
    );
    expect(formatFrom("Smith & Jones", "a@b.com")).toBe("Smith & Jones <a@b.com>");
  });

  it("quotes a name that has structure in a header", () => {
    // Unquoted, "Smith, Jones" would read as two addresses.
    expect(formatFrom("Smith, Jones", "a@b.com")).toBe('"Smith, Jones" <a@b.com>');
    expect(formatFrom("Acme Ltd.", "a@b.com")).toBe('"Acme Ltd." <a@b.com>');
  });

  it("🔴 cannot be talked into a second header or a different address", () => {
    const from = formatFrom('Evil"\r\nBcc: victim@x.com <attacker@evil.com>', "reports@salman.com");
    expect(from).not.toMatch(/[\r\n]/);
    expect(addressOf(from)).toBe("reports@salman.com");
    expect(from.match(/</g)).toHaveLength(1);
  });

  it("leaves the address bare when there is no usable name", () => {
    expect(formatFrom("", "a@b.com")).toBe("a@b.com");
    expect(formatFrom(null, "a@b.com")).toBe("a@b.com");
    expect(formatFrom(' "" ', "a@b.com")).toBe("a@b.com");
  });
});

describe("platformSenderName", () => {
  it("🔴 says who carried it when an agency borrows our address", () => {
    // Anyone can sign up and type any agency name. On our domain, the name
    // alone would let "PayPal Security" borrow our reputation.
    expect(platformSenderName("Salman Marketing", PLATFORM)).toBe("Salman Marketing via Growth Guild");
    expect(platformSenderName("PayPal Security", PLATFORM)).toBe("PayPal Security via Growth Guild");
  });

  it("keeps our own name for our own agency, or an unknown one", () => {
    expect(platformSenderName("Growth Guild", PLATFORM)).toBe("Growth Guild");
    expect(platformSenderName("growth guild", PLATFORM)).toBe("Growth Guild");
    expect(platformSenderName(null, PLATFORM)).toBe("Growth Guild");
  });

  it("changes nothing when our sender has no name to put after via", () => {
    expect(platformSenderName("Salman Marketing", "noreply@send.growthguild.agency")).toBeNull();
  });
});

describe("addresses", () => {
  it("reads both shapes", () => {
    expect(addressOf(PLATFORM)).toBe("noreply@send.growthguild.agency");
    expect(addressOf("noreply@x.com")).toBe("noreply@x.com");
    expect(displayNameOf(PLATFORM)).toBe("Growth Guild");
    expect(displayNameOf('"Acme, Inc" <a@b.com>')).toBe("Acme, Inc");
    expect(displayNameOf("a@b.com")).toBeNull();
  });
});

describe("dnsZoneOf", () => {
  const rec = (name: string) => ({ record: "DKIM", name, type: "TXT", value: "p=x", priority: null, ttl: null, status: null });

  it("reads the zone off Resend's DKIM host, the way the live API names a subdomain", () => {
    // Resend, for test.growthguild.agency: "resend._domainkey.test" — relative
    // to growthguild.agency, which is what the DNS provider appends.
    expect(dnsZoneOf("test.growthguild.agency", [rec("resend._domainkey.test")])).toBe("growthguild.agency");
    expect(dnsZoneOf("a.b.acme.co.uk", [rec("resend._domainkey.a.b")])).toBe("acme.co.uk");
  });

  it("is the domain itself for a main domain, or when it cannot tell", () => {
    expect(dnsZoneOf("acme.com", [rec("resend._domainkey")])).toBe("acme.com");
    expect(dnsZoneOf("acme.com", [])).toBe("acme.com");
    expect(dnsZoneOf("acme.com", [rec("resend._domainkey.other")])).toBe("acme.com");
  });

  it("builds the full name a provider might ask for", () => {
    expect(fullHostName("send.test", "growthguild.agency")).toBe("send.test.growthguild.agency");
    expect(fullHostName("@", "acme.com")).toBe("acme.com");
  });
});

describe("readableFrom", () => {
  it("shows a From the way an inbox does, without header quoting", () => {
    expect(readableFrom('"Acme, Inc." <a@b.com>')).toBe("Acme, Inc. <a@b.com>");
    expect(readableFrom("Growth Guild <noreply@x.com>")).toBe("Growth Guild <noreply@x.com>");
    expect(readableFrom("noreply@x.com")).toBe("noreply@x.com");
  });
});

describe("statusLabel", () => {
  it("says something an agency can act on for every state, known or not", () => {
    expect(statusLabel("verified").tone).toBe("good");
    expect(statusLabel("failed").tone).toBe("bad");
    expect(statusLabel("recheck").hint).toMatch(/our address/);
    for (const s of ["not_started", "pending", "temporary_failure", "partially_verified", null, ""]) {
      expect(statusLabel(s).label.length).toBeGreaterThan(0);
    }
  });
});
