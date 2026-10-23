import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * The hourly pass that keeps domain statuses current and releases claims
 * nobody proved — against a real database and a stubbed Resend.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let mod: typeof import("./refresh");

const A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const B = "bbbbbbbb-0000-4000-8000-0000000000b2";
const ORIGINAL = { ...process.env };

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as { rows: Record<string, unknown>[] };
}

/** What Resend says each domain's status is now, by Resend id. */
let resendStatus: Record<string, string>;
let deleteFails = false;
const requests: string[] = [];

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function stubResend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.resend.com", "");
      requests.push(`${init.method} ${path}`);
      const id = path.split("/")[2];
      if (init.method === "DELETE") {
        return deleteFails ? reply(500, { message: "boom" }) : reply(200, { object: "domain", id, deleted: true });
      }
      if (path.endsWith("/verify")) return reply(200, { object: "domain", id });
      return reply(200, {
        id,
        name: "x",
        status: resendStatus[id] ?? "pending",
        records: [{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=abc", status: "verified" }],
      });
    }),
  );
}

async function addDomain(agency: string, domain: string, rid: string, status: string, opts: { ageDays?: number; verifiedBefore?: boolean } = {}) {
  await run(
    `INSERT INTO agency_email_domains (agency_id, domain, resend_domain_id, status, created_at, verified_at)
     VALUES ('${agency}', '${domain}', '${rid}', '${status}', now() - interval '${opts.ageDays ?? 0} days',
             ${opts.verifiedBefore ? "now() - interval '30 days'" : "NULL"})`,
  );
}

const rows = async () =>
  (await run(`SELECT agency_id, status, verified_at, last_error, checked_at, records FROM agency_email_domains ORDER BY domain`)).rows;

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./refresh");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  process.env.RESEND_AGENCY_API_KEY = "agency-key";
  resendStatus = {};
  deleteFails = false;
  requests.length = 0;
  stubResend();
  await run(`TRUNCATE agency_email_domains, audit_log CASCADE`);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

describe("refreshDomains", () => {
  it("asks Resend to check a domain that is not mid-check, then stores the answer", async () => {
    await addDomain(A, "a.com", "rd_a", "not_started");
    resendStatus.rd_a = "verified";
    const s = await mod.refreshDomains({ budgetMs: 10_000 });
    expect(requests).toEqual(["POST /domains/rd_a/verify", "GET /domains/rd_a"]);
    expect(s).toEqual({ checked: 1, verified: 1, expired: 0, errors: 0 });
    const [r] = await rows();
    expect(r.status).toBe("verified");
    expect(r.verified_at).not.toBeNull();
    expect(r.checked_at).not.toBeNull();
    expect(r.records).toEqual([
      { record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=abc", status: "verified", priority: null, ttl: null },
    ]);
  });

  it("only reads a domain that is already being checked", async () => {
    await addDomain(A, "a.com", "rd_a", "pending");
    await mod.refreshDomains({ budgetMs: 10_000 });
    expect(requests).toEqual(["GET /domains/rd_a"]);
  });

  it("audits the moment a domain first verifies — once", async () => {
    await addDomain(A, "a.com", "rd_a", "pending");
    resendStatus.rd_a = "verified";
    await mod.refreshDomains({ budgetMs: 10_000 });
    await run(`UPDATE agency_email_domains SET status = 'recheck'`);
    await mod.refreshDomains({ budgetMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    const audits = (await run(`SELECT action, agency_id FROM audit_log`)).rows;
    expect(audits).toEqual([{ action: "agency.email_domain_verified", agency_id: A }]);
  });

  it("clears a re-check once Resend says the domain is fine again", async () => {
    await addDomain(A, "a.com", "rd_a", "recheck", { ageDays: 60, verifiedBefore: true });
    await run(`UPDATE agency_email_domains SET last_error = 'refused'`);
    resendStatus.rd_a = "verified";
    await mod.refreshDomains({ budgetMs: 10_000 });
    expect((await rows())[0]).toMatchObject({ status: "verified", last_error: null });
  });

  it("leaves verified domains alone", async () => {
    await addDomain(A, "a.com", "rd_a", "verified", { verifiedBefore: true });
    await mod.refreshDomains({ budgetMs: 10_000 });
    expect(requests).toEqual([]);
  });

  it("does nothing at all without the agency key", async () => {
    await addDomain(A, "a.com", "rd_a", "pending");
    delete process.env.RESEND_AGENCY_API_KEY;
    expect(await mod.refreshDomains({ budgetMs: 10_000 })).toEqual({ checked: 0, verified: 0, expired: 0, errors: 0 });
    expect(requests).toEqual([]);
  });
});

describe("🔴 expiry: a claim nobody proved is released", () => {
  it("removes a never-verified domain after 14 days, in Resend first", async () => {
    await addDomain(A, "squatted.com", "rd_a", "failed", { ageDays: 15 });
    await addDomain(B, "fresh.com", "rd_b", "not_started", { ageDays: 13 });
    const s = await mod.refreshDomains({ budgetMs: 10_000 });
    expect(requests[0]).toBe("DELETE /domains/rd_a");
    expect(s.expired).toBe(1);
    const left = await rows();
    expect(left.map((r) => r.agency_id)).toEqual([B]);
    await new Promise((r) => setTimeout(r, 50));
    expect((await run(`SELECT action FROM audit_log`)).rows).toContainEqual({ action: "agency.email_domain_expired" });
  });

  it("never removes a domain that has worked before, however old", async () => {
    await addDomain(A, "a.com", "rd_a", "recheck", { ageDays: 400, verifiedBefore: true });
    await mod.refreshDomains({ budgetMs: 10_000 });
    expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it("keeps the row when Resend will not delete, so nothing is orphaned there", async () => {
    await addDomain(A, "a.com", "rd_a", "failed", { ageDays: 20 });
    deleteFails = true;
    const s = await mod.refreshDomains({ budgetMs: 10_000 });
    expect(s).toMatchObject({ expired: 0, errors: 1 });
    expect(await rows()).toHaveLength(1);
  });
});

describe("applyResendStatus", () => {
  it("does not write an old domain's status onto its replacement", async () => {
    const store = await import("./store");
    await addDomain(A, "new.com", "rd_new", "not_started");
    const stale = { ...(await store.getAgencyDomain(A))!, resendDomainId: "rd_old" };
    await store.applyResendStatus(stale, { status: "verified", records: [] });
    expect((await rows())[0]).toMatchObject({ status: "not_started", verified_at: null });
  });
});
