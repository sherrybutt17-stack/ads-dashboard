import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Client } from "@/db/schema";
import type { SessionPayload } from "@/lib/session";
import type { DashboardData } from "@/lib/metrics/dashboard";
import type { ReportBrief } from "@/lib/ai/brief";
import { EMPTY_ADS, EMPTY_FUNNEL, derive } from "@/lib/metrics/compute";
import { FRAMINGS, type Framing } from "@/lib/ai/framings";
import { AD_PLATFORMS, type AdPlatform } from "@/lib/platforms";

/**
 * The weekly-summary API — `summary` (list, draft, edit) and `summary/publish`
 * — on every platform the dashboard has a tab for.
 *
 * 🔴 Both schemas said `meta | google`. Harmless while TikTok was reached only
 * by choosing it; once a TikTok-only client began opening on TikTok, the
 * Reports tab's summary panel answered 400 to every draft, edit and publish.
 *
 * Each platform goes through each verb, and the assertion is what reached the
 * dashboard load, the model and the store — not the status alone, because a
 * route that coerced TikTok to Meta would answer 200 too, and draft TikTok's
 * summary from Facebook's figures.
 *
 * ── What is faked ─────────────────────────────────────────────────────
 *
 * The session, the tenant lookup, the audit sink, the dashboard load, the
 * model call and the store. The brief, the figure check and the rate limiter
 * are the real ones, so a draft here is built from exactly what the route
 * would hand the model.
 */

/*
 * 🔴 Nothing here may reach a database. Every module that would is faked
 * below; this turns one that slipped past them into a loud failure instead of
 * a connection to whatever a stray DATABASE_URL names.
 */
vi.mock("@/db", () => ({
  get db() {
    throw new Error("route tests do not reach the database");
  },
  schema: {},
}));

const SESSION: SessionPayload = {
  userId: "user-1",
  agencyId: "agency-1",
  role: "staff",
  slugs: [],
};
vi.mock("@/lib/auth", () => ({
  agencyGuard: async () => null,
  getSessionUser: async () => SESSION,
}));

const CLIENT = { id: "11111111-1111-1111-1111-111111111111", slug: "acme" } as Client;
const getClientForSession = vi.fn(async (): Promise<Client | null> => CLIENT);
vi.mock("@/lib/clients", () => ({
  getClientForSession: (...args: unknown[]) => getClientForSession(...(args as [])),
}));

const record = vi.fn(async () => {});
vi.mock("@/lib/audit", () => ({
  record: (...args: unknown[]) => record(...(args as [])),
  requestContext: () => ({ ip: null, userAgent: null }),
}));

const START = "2026-09-01";
const END = "2026-09-07";

/** What `loadDashboard` returns for a platform — enough for the real brief. */
function dashboard(platform: AdPlatform): DashboardData {
  const funnel = { ...EMPTY_FUNNEL, new_lead: 46, appointment_booked: 12, closed_won: 2 };
  const ads = { ...EMPTY_ADS, spend: 2847.32, impressions: 96_191, linkClicks: 742 };
  const revenue = { wonOpps: 2, wonWithValue: 2, revenue: 9600 };
  const current = {
    label: "Selected range",
    funnel,
    ads,
    derived: derive(funnel, ads, revenue),
    revenue,
  };
  return {
    platform,
    client: {
      id: CLIENT.id,
      name: "Acme Aesthetics",
      slug: CLIENT.slug,
      timezone: "America/Los_Angeles",
      currency: "USD",
      lastSyncedAt: null,
      firstWebhookAt: null,
    },
    range: { startKey: START, endKey: END, label: "Sep 1 – Sep 7" },
    current,
    previous: current,
    deltas: {},
    funnel: [],
    campaigns: [],
    anomalies: { findings: [], judgedDays: 30, testedDays: 30 },
    provisional: { totalRows: 0, provisionalRows: 0, since: null },
    creativesError: null,
    revenueCoverage: {
      totalDeals: 0,
      attributedDeals: 0,
      recentContacts: 0,
      recentContactsWithAdId: 0,
    },
    attributionGap: false,
    leadFilter: { mode: "all", tag: "", total: 46, attributed: 46, tagged: 0, paid: 46 },
  } as unknown as DashboardData;
}

const loadDashboard = vi.fn(
  async (_client: Client, _range: { startKey: string; endKey: string }, platform: AdPlatform) =>
    dashboard(platform),
);
vi.mock("@/lib/metrics/dashboard", () => ({
  loadDashboard: (...args: unknown[]) =>
    loadDashboard(...(args as Parameters<typeof loadDashboard>)),
}));

const generateSummary = vi.fn(async (_brief: ReportBrief, framing: Framing) => ({
  framing,
  headline: "Leads held at 46.",
  body: "You had 46 leads and 12 appointments.",
  verification: { ok: true, issues: [], checked: 2 },
  warning: null,
  model: "test-model",
  retried: false,
}));
vi.mock("@/lib/ai/summary", async () => ({
  // The real framings, so the schemas are built from the list the panel uses.
  ...(await vi.importActual<typeof import("@/lib/ai/framings")>("@/lib/ai/framings")),
  SummaryUnavailable: class SummaryUnavailable extends Error {},
  summariesConfigured: () => true,
  generateSummary: (...args: unknown[]) =>
    generateSummary(...(args as Parameters<typeof generateSummary>)),
}));

const STORED = {
  framing: "summary",
  headline: "Leads held at 46.",
  body: "You had 46 leads and 12 appointments.",
  verification: null,
  model: "test-model",
  updatedAt: "2026-10-01T00:00:00.000Z",
  updatedBy: SESSION.userId,
  published: null,
  hasUnpublishedChanges: false,
};
const listSummaries = vi.fn();
const saveDraft = vi.fn();
const saveEdits = vi.fn();
const publishSummary = vi.fn();
const unpublishSummary = vi.fn();
vi.mock("@/lib/ai/store", () => ({
  listSummaries: (...args: unknown[]) => listSummaries(...args),
  saveDraft: (...args: unknown[]) => saveDraft(...args),
  saveEdits: (...args: unknown[]) => saveEdits(...args),
  publishSummary: (...args: unknown[]) => publishSummary(...args),
  unpublishSummary: (...args: unknown[]) => unpublishSummary(...args),
}));

const route = await import("./route");
const publish = await import("./publish/route");

const ctx = { params: Promise.resolve({ slug: CLIENT.slug }) };
const BASE = `http://localhost/api/c/${CLIENT.slug}/summary`;

const withBody = (method: string, url: string, body: unknown) =>
  new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

/** The stored summaries for a period. */
const list = (query: Record<string, string>) =>
  route.GET(new NextRequest(`${BASE}?${new URLSearchParams(query)}`), ctx);
/** What the panel sends on Generate. */
const generate = (body: Record<string, unknown>) =>
  route.POST(withBody("POST", BASE, { start: START, end: END, ...body }), ctx);
/** What the panel sends on Save. */
const edit = (body: Record<string, unknown>) =>
  route.PUT(withBody("PUT", BASE, { start: START, end: END, ...body }), ctx);
/** What the panel sends on Publish and Withdraw. */
const setPublished = (body: Record<string, unknown>) =>
  publish.POST(withBody("POST", `${BASE}/publish`, { start: START, end: END, ...body }), ctx);

const period = (platform: string, clientId = CLIENT.id) => ({
  clientId,
  platform,
  rangeStart: START,
  rangeEnd: END,
});

beforeEach(() => {
  vi.clearAllMocks();
  getClientForSession.mockResolvedValue(CLIENT);
  listSummaries.mockResolvedValue({ summaries: [], error: null });
  saveDraft.mockResolvedValue(STORED);
  saveEdits.mockResolvedValue(STORED);
  publishSummary.mockResolvedValue({
    ...STORED,
    published: {
      headline: STORED.headline,
      body: STORED.body,
      at: "2026-10-02T00:00:00.000Z",
      by: SESSION.userId,
    },
  });
  unpublishSummary.mockResolvedValue(STORED);
});

describe.each(AD_PLATFORMS)("🔴 on %s, every verb gets through", (platform) => {
  it("lists that platform's summaries", async () => {
    const res = await list({ start: START, end: END, platform });
    expect(res.status).toBe(200);
    expect(listSummaries).toHaveBeenCalledWith(period(platform));
  });

  it("drafts from that platform's figures, and files the draft under it", async () => {
    const res = await generate({ platform, framing: "wins" });
    expect(res.status).toBe(200);
    expect(loadDashboard).toHaveBeenCalledWith(CLIENT, { startKey: START, endKey: END }, platform);
    expect(generateSummary).toHaveBeenCalledWith(expect.anything(), "wins");
    expect(saveDraft).toHaveBeenCalledWith(
      period(platform),
      expect.objectContaining({ framing: "wins" }),
      SESSION.userId,
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "summary.generated",
        metadata: expect.objectContaining({ platform }),
      }),
    );
  });

  it("saves edits under that platform, re-checked against its figures", async () => {
    const res = await edit({
      platform,
      framing: "summary",
      headline: "Leads held at 46.",
      body: "You had 46 leads.",
    });
    expect(res.status).toBe(200);
    expect(loadDashboard).toHaveBeenCalledWith(CLIENT, { startKey: START, endKey: END }, platform);
    expect(saveEdits).toHaveBeenCalledWith(
      period(platform),
      "summary",
      {
        headline: "Leads held at 46.",
        body: "You had 46 leads.",
        // Checked, and clean: 46 is a figure the brief for this platform holds.
        verification: expect.objectContaining({ ok: true }),
      },
      SESSION.userId,
    );
  });

  it("publishes and withdraws that platform's summary", async () => {
    expect((await setPublished({ platform, framing: "issues" })).status).toBe(200);
    expect(publishSummary).toHaveBeenCalledWith(period(platform), "issues", SESSION.userId);

    expect(
      (await setPublished({ platform, framing: "issues", published: false })).status,
    ).toBe(200);
    expect(unpublishSummary).toHaveBeenCalledWith(period(platform), "issues");
  });
});

describe("🔴 a TikTok draft", () => {
  it("is written from a brief that says TikTok", async () => {
    // The model names whichever platform the brief names, so this is the
    // line that decides what the client reads.
    expect((await generate({ platform: "tiktok", framing: "summary" })).status).toBe(200);
    const [brief] = generateSummary.mock.calls[0];
    expect(brief.platformLabel).toBe("TikTok Ads");
  });
});

describe("the platform a request names", () => {
  it("🔴 is refused when it is not a platform, before anything is loaded or stored", async () => {
    // A misspelling, the wrong case, the display name, and nothing at all.
    for (const platform of ["bing", "TikTok", "facebook", ""]) {
      expect((await list({ start: START, end: END, platform })).status).toBe(400);
      expect((await generate({ platform, framing: "summary" })).status).toBe(400);
      expect(
        (await edit({ platform, framing: "summary", headline: "h", body: "b" })).status,
      ).toBe(400);
      expect((await setPublished({ platform, framing: "summary" })).status).toBe(400);
    }
    for (const fn of [
      listSummaries,
      loadDashboard,
      generateSummary,
      saveDraft,
      saveEdits,
      publishSummary,
      unpublishSummary,
      record,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("is still Meta when it is left out", async () => {
    // What a request naming no platform has always meant — the panel itself
    // always names one, so this is for every other caller.
    expect((await list({ start: START, end: END })).status).toBe(200);
    expect((await generate({ framing: "summary" })).status).toBe(200);
    expect((await edit({ framing: "summary", headline: "h", body: "b" })).status).toBe(200);
    expect((await setPublished({ framing: "summary" })).status).toBe(200);
    expect(listSummaries).toHaveBeenCalledWith(period("meta"));
    expect(saveDraft).toHaveBeenCalledWith(period("meta"), expect.anything(), SESSION.userId);
    expect(saveEdits).toHaveBeenCalledWith(period("meta"), "summary", expect.anything(), SESSION.userId);
    expect(publishSummary).toHaveBeenCalledWith(period("meta"), "summary", SESSION.userId);
  });
});

describe("🔴 the generate limit", () => {
  it("still leaves room to regenerate after every framing on every platform", async () => {
    /*
     * It was a literal twelve — "four framings over two platforms is eight,
     * plus room". TikTok made the full set twelve, so the limit fell exactly
     * on it and the first regeneration was refused.
     *
     * A client of its own, so the drafts made by the other tests in this file
     * are not in its bucket whatever order they run in.
     */
    const own = { ...CLIENT, id: "22222222-2222-2222-2222-222222222222" } as Client;
    getClientForSession.mockResolvedValue(own);

    for (const platform of AD_PLATFORMS) {
      for (const framing of FRAMINGS) {
        expect((await generate({ platform, framing })).status, `${platform} ${framing}`).toBe(200);
      }
    }
    // A couple of regenerations on top of the full set — the room it exists to leave.
    for (let i = 0; i < 2; i++) {
      expect((await generate({ platform: "tiktok", framing: "summary" })).status).toBe(200);
    }
    expect(saveDraft).toHaveBeenLastCalledWith(
      period("tiktok", own.id),
      expect.anything(),
      SESSION.userId,
    );

    // And it is still a limit on paid calls: it trips, and says when to retry.
    let refused: Response | null = null;
    for (let i = 0; i < 100 && !refused; i++) {
      const res = await generate({ platform: "tiktok", framing: "summary" });
      if (res.status === 429) refused = res;
    }
    expect(refused).not.toBeNull();
    expect(Number(refused?.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
