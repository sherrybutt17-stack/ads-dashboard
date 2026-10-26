import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Client } from "@/db/schema";
import type { HistoryResult } from "@/lib/ghl/history";

/**
 * The GoHighLevel history import's request — `action: "ghl_backfill"`.
 *
 * What the route itself decides: which cursor reaches the import, what is
 * audited, and what a failure says to the browser. The import is faked; its
 * own behaviour is pinned in `lib/ghl/history.test.ts`.
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

const CLIENT = { id: "11111111-1111-4111-8111-111111111111", slug: "acme" } as Client;
vi.mock("@/lib/auth", () => ({
  requireClient: async () => ({ client: CLIENT, session: { userId: "user-1", agencyId: "agency-1", role: "staff", slugs: [] } }),
  isSuperadmin: () => false,
}));

const record = vi.fn(async (entry: unknown) => void entry);
vi.mock("@/lib/audit", () => ({
  record: (entry: unknown) => record(entry),
  requestContext: () => ({ ip: null, userAgent: null }),
}));

vi.mock("@/lib/meta/sync", () => ({ backfillClientMetrics: vi.fn(), importMetaAdLevelHistory: vi.fn(), syncClientMetrics: vi.fn() }));
vi.mock("@/lib/tiktok/sync", () => ({ backfillClientTiktokMetrics: vi.fn() }));
vi.mock("@/lib/tiktok/adlevel", () => ({ importTiktokAdLevelHistory: vi.fn() }));
vi.mock("@/lib/google/sync", () => ({ backfillClientGoogleMetrics: vi.fn() }));

const importGhlHistory = vi.fn();
vi.mock("@/lib/ghl/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ghl/history")>()),
  importGhlHistory: (...args: unknown[]) => importGhlHistory(...args),
}));

const { POST } = await import("./route");
const { encodeHistoryCursor } = await import("@/lib/ghl/history");

const totals = { contacts: 500, opportunities: 0, leads: 0, transitions: 0, skipped: 0 };
const call = (body: unknown) =>
  POST(
    new NextRequest(`http://localhost/api/clients/${CLIENT.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: CLIENT.id }) },
  );

beforeEach(() => {
  record.mockClear();
  importGhlHistory.mockReset();
});

describe("the GoHighLevel history import's request", () => {
  it("hands the import the cursor it made, and audits the request with its totals", async () => {
    const cursor = { v: 1 as const, phase: "contacts" as const, after: [1761000000000, "abc"], totals };
    const answer: HistoryResult = { done: false, cursor: "next", phase: "contacts", totals: { ...totals, contacts: 1000 }, notes: [] };
    importGhlHistory.mockResolvedValue(answer);

    const res = await call({ action: "ghl_backfill", cursor: encodeHistoryCursor(cursor) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...answer });
    expect(importGhlHistory).toHaveBeenCalledWith(CLIENT, { cursor });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "client.ghl_history_import",
        metadata: { resumed: true, done: false, phase: "contacts", ...answer.totals },
      }),
    );
  });

  it("refuses a cursor it did not make, before importing anything", async () => {
    const res = await call({ action: "ghl_backfill", cursor: "bm90IGEgY3Vyc29y" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/can't be carried on/);
    expect(importGhlHistory).not.toHaveBeenCalled();
  });

  it("🔴 audits a failed import too — without its text", async () => {
    importGhlHistory.mockRejectedValue(
      new Error("Couldn't save a page of the import (database code 22021). Import again to carry on — nothing is imported twice."),
    );
    const res = await call({ action: "ghl_backfill" });
    expect(res.status).toBe(502);
    // Our own words, worded for this screen: through as they are.
    expect((await res.json()).error).toMatch(/^Couldn't save a page of the import/);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      action: "client.ghl_history_import",
      metadata: { resumed: false, failed: true },
    });
    expect(JSON.stringify(record.mock.calls[0][0])).not.toMatch(/database code/);
  });

  it("🔴 never echoes a failed statement that reached it", async () => {
    const { DrizzleQueryError } = await import("drizzle-orm");
    importGhlHistory.mockRejectedValue(
      new DrizzleQueryError('insert into "contacts" ("email") values ($1)', ["dana@example.com"], new Error("boom")),
    );
    const body = await (await call({ action: "ghl_backfill" })).json();
    expect(JSON.stringify(body)).not.toMatch(/insert|dana@example\.com/);
  });
});
