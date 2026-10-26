import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Client } from "@/db/schema";
import type { SessionPayload } from "@/lib/session";
import { AD_PLATFORMS } from "@/lib/platforms";

/**
 * The monthly-commentary API — `commentary` (load a month, save it) and
 * `commentary/publish` — on every platform the dashboard has a tab for.
 *
 * 🔴 Both schemas said `meta | google`. Harmless while TikTok was reached only
 * by choosing it; once a TikTok-only client began opening on TikTok, the
 * Reports tab's commentary panel rendered from the page's own load and then
 * answered 400 to every month switch, save and publish made in it.
 *
 * Each platform goes through each verb, and the assertion is the STORE call,
 * not the status alone: a route that coerced TikTok to Meta would answer 200
 * too, and file the month under the wrong platform.
 *
 * ── What is faked ─────────────────────────────────────────────────────
 *
 * The session, the tenant lookup, the audit sink and the two stores. The
 * schemas, the handlers' own checks and the rate limiter are the real ones —
 * they are what decides what reaches a store.
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

const loadCommentaryForEditor = vi.fn();
vi.mock("@/lib/commentary/report", () => ({
  loadCommentaryForEditor: (...args: unknown[]) => loadCommentaryForEditor(...args),
}));

const saveCommentary = vi.fn();
const publishCommentary = vi.fn();
const unpublishCommentary = vi.fn();
vi.mock("@/lib/commentary/store", () => ({
  saveCommentary: (...args: unknown[]) => saveCommentary(...args),
  publishCommentary: (...args: unknown[]) => publishCommentary(...args),
  unpublishCommentary: (...args: unknown[]) => unpublishCommentary(...args),
}));

const route = await import("./route");
const publish = await import("./publish/route");

const MONTH = "2026-09";
const CONTENT = {
  did: "Rebuilt the lead form and paused the weakest ad set.",
  commitments: [
    {
      id: "c1",
      text: "Bring cost per lead under $40.",
      target: { metric: "cpLead", direction: "at_most", value: 40 },
    },
  ],
  outcomes: [],
};
const STORED = {
  month: MONTH,
  ...CONTENT,
  published: null,
  hasUnpublishedChanges: false,
  updatedAt: "2026-10-01T00:00:00.000Z",
  updatedBy: SESSION.userId,
};

const ctx = { params: Promise.resolve({ slug: CLIENT.slug }) };
const BASE = `http://localhost/api/c/${CLIENT.slug}/commentary`;

const withBody = (method: string, url: string, body: unknown) =>
  new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

/** What the panel sends on a month switch. */
const loadMonth = (query: Record<string, string>) =>
  route.GET(new NextRequest(`${BASE}?${new URLSearchParams(query)}`), ctx);
/** What the panel sends on Save. */
const save = (body: Record<string, unknown>) => route.PUT(withBody("PUT", BASE, body), ctx);
/** What the panel sends on Publish and Withdraw. */
const setPublished = (body: Record<string, unknown>) =>
  publish.POST(withBody("POST", `${BASE}/publish`, body), ctx);

const key = (platform: string) => ({ clientId: CLIENT.id, platform, month: MONTH });

beforeEach(() => {
  vi.clearAllMocks();
  getClientForSession.mockResolvedValue(CLIENT);
  loadCommentaryForEditor.mockResolvedValue({
    month: MONTH,
    current: null,
    prior: null,
    actuals: null,
    currency: "USD",
    error: null,
  });
  saveCommentary.mockResolvedValue(STORED);
  publishCommentary.mockResolvedValue({
    ...STORED,
    published: { ...CONTENT, at: "2026-10-02T00:00:00.000Z", by: SESSION.userId },
  });
  unpublishCommentary.mockResolvedValue(STORED);
});

describe.each(AD_PLATFORMS)("🔴 on %s, every verb the panel uses gets through", (platform) => {
  it("loads a month under that platform", async () => {
    const res = await loadMonth({ month: MONTH, platform });
    expect(res.status).toBe(200);
    expect(loadCommentaryForEditor).toHaveBeenCalledWith(CLIENT, platform, MONTH);
  });

  it("saves a month under that platform, and records which", async () => {
    const res = await save({ month: MONTH, platform, ...CONTENT });
    expect(res.status).toBe(200);
    expect(saveCommentary).toHaveBeenCalledWith(key(platform), CONTENT, SESSION.userId);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "commentary.saved",
        metadata: expect.objectContaining({ platform }),
      }),
    );
  });

  it("publishes and withdraws that platform's month", async () => {
    expect((await setPublished({ month: MONTH, platform })).status).toBe(200);
    expect(publishCommentary).toHaveBeenCalledWith(key(platform), SESSION.userId);

    expect((await setPublished({ month: MONTH, platform, published: false })).status).toBe(200);
    expect(unpublishCommentary).toHaveBeenCalledWith(key(platform));
  });
});

describe("the platform a request names", () => {
  it("🔴 is refused when it is not a platform, before any store is reached", async () => {
    // A misspelling, the wrong case, the display name, and nothing at all.
    for (const platform of ["bing", "TikTok", "facebook", ""]) {
      expect((await loadMonth({ month: MONTH, platform })).status).toBe(400);
      expect((await save({ month: MONTH, platform, ...CONTENT })).status).toBe(400);
      expect((await setPublished({ month: MONTH, platform })).status).toBe(400);
    }
    expect(loadCommentaryForEditor).not.toHaveBeenCalled();
    expect(saveCommentary).not.toHaveBeenCalled();
    expect(publishCommentary).not.toHaveBeenCalled();
    expect(unpublishCommentary).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("is still Meta when it is left out", async () => {
    // What a request naming no platform has always meant — the panel itself
    // always names one, so this is for every other caller.
    expect((await loadMonth({ month: MONTH })).status).toBe(200);
    expect((await save({ month: MONTH, ...CONTENT })).status).toBe(200);
    expect((await setPublished({ month: MONTH })).status).toBe(200);
    expect(loadCommentaryForEditor).toHaveBeenCalledWith(CLIENT, "meta", MONTH);
    expect(saveCommentary).toHaveBeenCalledWith(key("meta"), CONTENT, SESSION.userId);
    expect(publishCommentary).toHaveBeenCalledWith(key("meta"), SESSION.userId);
  });
});
