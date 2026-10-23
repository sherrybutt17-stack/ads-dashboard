import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DomainApiError,
  createDomain,
  deleteDomain,
  getDomain,
  parseDomain,
  verifyDomain,
} from "./resend-domains";

/**
 * The agency-domains Resend client, against a stubbed `fetch`.
 *
 * What matters here is what an agency operator reads when Resend says no, and
 * that the Full-access key never ends up in it.
 */

const KEY = "re_agency_full_access_SECRET";
const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.RESEND_AGENCY_API_KEY = KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const DOMAIN = {
  object: "domain",
  id: "d91cd9bd-1176-453e-8fc1-35364d380206",
  name: "salmanmarketing.com",
  status: "not_started",
  created_at: "2026-10-23T00:00:00.000Z",
  region: "us-east-1",
  records: [
    { record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", status: "not_started", value: "p=MIGf..." },
    { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "not_started", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
    { record: "SPF", name: "send", type: "TXT", ttl: "Auto", status: "not_started", value: '"v=spf1 include:amazonses.com ~all"' },
    { record: "Tracking", name: "links", type: "CNAME", status: "not_started" },
  ],
};

describe("requests", () => {
  it("creates a domain with the agency key and maps its records", async () => {
    const spy = stubFetch(() => reply(201, DOMAIN));
    const d = await createDomain("salmanmarketing.com");
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/domains");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "salmanmarketing.com" });
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(d.id).toBe(DOMAIN.id);
    expect(d.status).toBe("not_started");
    // A record with no value cannot be added to DNS, so it is not shown.
    expect(d.records.map((r) => `${r.type} ${r.name}`)).toEqual([
      "TXT resend._domainkey",
      "MX send",
      "TXT send",
    ]);
    expect(d.records[1].priority).toBe(10);
    expect(d.records[0].priority).toBeNull();
  });

  it("reads, verifies and deletes by id, escaped", async () => {
    const spy = stubFetch(() => reply(200, DOMAIN));
    await getDomain("a/b");
    await verifyDomain("a/b");
    await deleteDomain("a/b");
    const calls = spy.mock.calls.map(([u, i]) => `${(i as RequestInit).method} ${u}`);
    expect(calls).toEqual([
      "GET https://api.resend.com/domains/a%2Fb",
      "POST https://api.resend.com/domains/a%2Fb/verify",
      "DELETE https://api.resend.com/domains/a%2Fb",
    ]);
  });

  it("treats deleting a domain that is already gone as done", async () => {
    stubFetch(() => reply(404, { name: "not_found", message: "Domain not found" }));
    await expect(deleteDomain("gone")).resolves.toBeUndefined();
  });

  it("refuses to call anything without the key", async () => {
    delete process.env.RESEND_AGENCY_API_KEY;
    const spy = stubFetch(() => reply(200, DOMAIN));
    await expect(getDomain("x")).rejects.toMatchObject({ status: 503, code: "not_configured" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("what an operator reads when Resend says no", () => {
  const cases: Array<[string, number, unknown, RegExp]> = [
    [
      "a domain registered elsewhere",
      403,
      { name: "validation_error", message: "The domain salman.com is already registered." },
      /subdomain/,
    ],
    ["a send-only key", 401, { name: "restricted_api_key", message: "This API key is restricted to only send emails" }, /Full access/],
    ["a key that isn't valid", 401, { name: "validation_error", message: "API key is invalid" }, /isn't valid/],
    // What the live API actually sends for a bad key on /domains: a 400.
    ["a bad key, the way Resend really says it", 400, { name: "validation_error", message: "API key is invalid" }, /isn't valid/],
    ["a rate limit", 429, { name: "rate_limit_exceeded", message: "Too many requests" }, /Try again/],
    ["a domain limit", 403, { name: "validation_error", message: "You have reached your domain limit. Upgrade your plan." }, /email plan/],
    ["an outage", 503, { name: "service_unavailable", message: "Unavailable" }, /trouble/],
    ["anything else", 422, { name: "validation_error", message: "Invalid domain name." }, /said: Invalid domain name\./],
    ["no body at all", 418, null, /returned 418/],
  ];

  it.each(cases)("%s", async (_label, status, body, expected) => {
    stubFetch(() => reply(status, body));
    const err = await createDomain("salman.com").catch((e) => e);
    expect(err).toBeInstanceOf(DomainApiError);
    expect(err.status).toBe(status);
    expect(err.message).toMatch(expected);
  });

  it("knows which refusals are ours to fix, and which are the agency's", async () => {
    const ours = async (status: number, body: unknown) => {
      stubFetch(() => reply(status, body));
      return ((await createDomain("salman.com").catch((e) => e)) as DomainApiError).ours;
    };
    expect(await ours(400, { name: "validation_error", message: "API key is invalid" })).toBe(true);
    expect(await ours(401, { name: "restricted_api_key", message: "restricted" })).toBe(true);
    expect(await ours(403, { name: "validation_error", message: "You have reached your domain limit." })).toBe(true);
    expect(await ours(403, { name: "validation_error", message: "The domain is already registered." })).toBe(false);
    expect(await ours(422, { name: "validation_error", message: "Invalid domain name." })).toBe(false);
  });

  it("🔴 never repeats the key, whatever Resend sends back", async () => {
    stubFetch(() => reply(400, { name: "validation_error", message: `Bad request for key ${KEY}` }));
    const err = await createDomain("salman.com").catch((e) => e);
    // Resend does not echo keys — but this message is shown to agencies, so
    // it is checked rather than assumed. The key reaches only the header.
    expect(err.message).toContain("Bad request");
    expect(JSON.stringify({ m: err.message, c: err.code })).not.toContain("re_agency");
  });
});

describe("parseDomain", () => {
  it("survives a reply missing everything but an id", () => {
    expect(parseDomain({ id: "x" })).toEqual({ id: "x", name: "", status: "not_started", records: [] });
  });

  it("refuses a reply with no id", () => {
    expect(() => parseDomain({ name: "x.com" })).toThrow(DomainApiError);
  });
});
