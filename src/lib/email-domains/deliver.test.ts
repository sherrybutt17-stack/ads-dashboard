import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * Sending on an agency's behalf, against a real database and a stubbed Resend.
 *
 * Nothing is mocked but `fetch`: the domain lookup, the agency name, the From
 * line and the fallback all run for real, because the bugs that matter here
 * are in how they fit together — a reset that does not arrive, or a report that
 * arrives twice.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let mod: typeof import("./deliver");
let EmailError: typeof import("@/lib/reports/email").EmailError;

const AGENCY = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORIGINAL = { ...process.env };

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as { rows: Record<string, unknown>[] };
}

const MSG = { to: ["client@example.com"], subject: "July 2026", html: "<p>h</p>", text: "t" };

/** What each account does with the next send: answer, or fail. */
let agencyReply: () => Response | Promise<Response>;
let platformReply: () => Response | Promise<Response>;
const calls: Array<{ account: "agency" | "platform"; body: Record<string, unknown> }> = [];

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function stubResend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      const account = auth === "Bearer agency-key" ? "agency" : "platform";
      calls.push({ account, body: JSON.parse(String(init.body)) });
      return account === "agency" ? agencyReply() : platformReply();
    }),
  );
}

async function addDomain(status: string, over: Record<string, string> = {}) {
  await run(
    `INSERT INTO agency_email_domains (agency_id, domain, resend_domain_id, status, from_local, from_name, reply_to, verified_at)
     VALUES ('${AGENCY}', 'acme.com', 'rd_1', '${status}', '${over.fromLocal ?? "reports"}',
             ${over.fromName ? `'${over.fromName}'` : "NULL"}, ${over.replyTo ? `'${over.replyTo}'` : "NULL"},
             ${status === "verified" ? "now()" : "NULL"})`,
  );
}

const domainRow = async () =>
  (await run(`SELECT status, last_error FROM agency_email_domains WHERE agency_id = '${AGENCY}'`)).rows[0];

beforeAll(async () => {
  harness = await createTestDb();
  ({ EmailError } = await import("@/lib/reports/email"));
  mod = await import("./deliver");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  process.env.RESEND_API_KEY = "platform-key";
  process.env.REPORT_FROM = "Growth Guild <noreply@send.growthguild.agency>";
  process.env.RESEND_AGENCY_API_KEY = "agency-key";
  delete process.env.RESEND_FROM;
  delete process.env.RESEND_API_URL;
  delete process.env.REPORT_REPLY_TO;
  calls.length = 0;
  agencyReply = () => reply(200, { id: "msg_agency" });
  platformReply = () => reply(200, { id: "msg_platform" });
  stubResend();
  await run(`TRUNCATE agency_email_domains, agency_settings, agencies CASCADE`);
  await run(`INSERT INTO agencies (id, name, slug) VALUES ('${AGENCY}', 'Acme Agency', 'acme-agency')`);
  await run(`INSERT INTO agency_settings (agency_id, support_email) VALUES ('${AGENCY}', 'hello@acme.com')`);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

describe("which address", () => {
  it("no domain: our address, the agency's name via ours, its support email for replies", async () => {
    const d = await mod.sendForAgency(AGENCY, MSG);
    expect(calls).toHaveLength(1);
    expect(calls[0].account).toBe("platform");
    expect(calls[0].body).toMatchObject({
      from: "Acme Agency via Growth Guild <noreply@send.growthguild.agency>",
      reply_to: "hello@acme.com",
      to: ["client@example.com"],
    });
    expect(d).toEqual({
      id: "msg_platform",
      via: "platform",
      from: "Acme Agency via Growth Guild <noreply@send.growthguild.agency>",
      fellBack: null,
    });
  });

  it("verified domain: the agency's own address and key", async () => {
    await addDomain("verified");
    const d = await mod.sendForAgency(AGENCY, MSG);
    expect(calls.map((c) => c.account)).toEqual(["agency"]);
    expect(calls[0].body).toMatchObject({ from: "Acme Agency <reports@acme.com>", reply_to: "hello@acme.com" });
    expect(d).toMatchObject({ id: "msg_agency", via: "agency_domain", fellBack: null });
  });

  it("uses the name and reply address set on the tab over the agency's", async () => {
    await addDomain("verified", { fromLocal: "hello", fromName: "Acme Reporting", replyTo: "team@acme.com" });
    await mod.sendForAgency(AGENCY, MSG);
    expect(calls[0].body).toMatchObject({ from: "Acme Reporting <hello@acme.com>", reply_to: "team@acme.com" });
  });

  it.each(["not_started", "pending", "failed", "temporary_failure", "recheck"])(
    "a %s domain does not send",
    async (status) => {
      await addDomain(status);
      const d = await mod.sendForAgency(AGENCY, MSG);
      expect(calls.map((c) => c.account)).toEqual(["platform"]);
      expect(d.via).toBe("platform");
    },
  );

  it("ignores a verified domain when the feature is switched off", async () => {
    await addDomain("verified");
    delete process.env.RESEND_AGENCY_API_KEY;
    await mod.sendForAgency(AGENCY, MSG);
    expect(calls.map((c) => c.account)).toEqual(["platform"]);
  });

  it("🔴 a broken lookup sends from our address rather than failing", async () => {
    // Not a uuid: both the settings read and the domain read fail in Postgres.
    // Neither may stop a password reset.
    const d = await mod.sendForAgency("not-a-uuid", MSG);
    expect(d.via).toBe("platform");
    expect(calls[0].body.from).toBe("Growth Guild <noreply@send.growthguild.agency>");
  });

  it("passes the message through untouched when our sender is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    const err = await mod.sendForAgency(AGENCY, MSG).catch((e) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect(err.message).toBe("Email is not configured.");
    expect(calls).toHaveLength(0);
  });
});

describe("🔴 when the agency's domain refuses", () => {
  beforeEach(async () => {
    await addDomain("verified");
  });

  it("a 403 'not verified': sends from ours, and stops using the domain until it checks out", async () => {
    agencyReply = () => reply(403, { name: "validation_error", message: "The acme.com domain is not verified." });
    const d = await mod.sendForAgency(AGENCY, MSG);
    expect(calls.map((c) => c.account)).toEqual(["agency", "platform"]);
    expect(d).toMatchObject({ via: "platform", id: "msg_platform" });
    expect(d.fellBack).toMatch(/not verified/);
    expect(await domainRow()).toMatchObject({ status: "recheck", last_error: "The acme.com domain is not verified." });

    // And the next email does not try the domain again.
    calls.length = 0;
    await mod.sendForAgency(AGENCY, MSG);
    expect(calls.map((c) => c.account)).toEqual(["platform"]);
  });

  it.each([
    [401, { name: "restricted_api_key", message: "This API key is restricted" }],
    [429, { name: "daily_quota_exceeded", message: "Daily quota exceeded" }],
  ])("a %i (ours to fix): sends from ours and leaves the domain as it is", async (status, body) => {
    agencyReply = () => reply(status, body);
    const d = await mod.sendForAgency(AGENCY, MSG);
    expect(calls.map((c) => c.account)).toEqual(["agency", "platform"]);
    expect(d.via).toBe("platform");
    expect(await domainRow()).toMatchObject({ status: "verified" });
  });

  it("a 5xx: the outcome is unknown, so the original error is thrown and nothing is resent", async () => {
    agencyReply = () => reply(502, { name: "application_error", message: "Bad gateway" });
    const err = await mod.sendForAgency(AGENCY, MSG).catch((e) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect(err.providerStatus).toBe(502);
    expect(calls.map((c) => c.account)).toEqual(["agency"]);
    expect(await domainRow()).toMatchObject({ status: "verified" });
  });

  it.each([
    ["the network failed", () => Promise.reject(new TypeError("fetch failed"))],
    ["the request timed out", () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))],
  ])("%s: thrown as it came, never resent", async (_label, failure) => {
    agencyReply = failure as () => Promise<Response>;
    const err = await mod.sendForAgency(AGENCY, MSG).catch((e) => e);
    expect(err).not.toBeInstanceOf(EmailError);
    expect(calls.map((c) => c.account)).toEqual(["agency"]);
  });

  it("if our address then fails too, that failure is what the caller sees", async () => {
    agencyReply = () => reply(403, { message: "The acme.com domain is not verified." });
    platformReply = () => reply(503, { message: "Unavailable" });
    const err = await mod.sendForAgency(AGENCY, MSG).catch((e) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect(err.providerStatus).toBe(503);
  });
});

describe("senderFor", () => {
  it("describes our address under the agency's name when there is no domain", async () => {
    expect(await mod.senderFor(AGENCY)).toEqual({
      from: "Acme Agency via Growth Guild <noreply@send.growthguild.agency>",
      viaDomain: false,
      domain: null,
      domainStatus: null,
      available: true,
    });
  });

  it("names an unverified domain without sending from it", async () => {
    await addDomain("pending");
    expect(await mod.senderFor(AGENCY)).toMatchObject({ viaDomain: false, domain: "acme.com", domainStatus: "pending" });
  });

  it("describes the agency's own address once verified", async () => {
    await addDomain("verified");
    expect(await mod.senderFor(AGENCY)).toMatchObject({ from: "Acme Agency <reports@acme.com>", viaDomain: true });
  });
});
