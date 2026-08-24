import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Client } from "@/db/schema";
import {
  createTestDb,
  CLIENT_A,
  type TestDb,
} from "@/lib/metrics/__testdb__/harness";
import type { Commitment } from "./model";

/**
 * Assembling the commentary with the figures that judge it.
 *
 * The behaviours worth pinning are about WHEN the figures are fetched and WHICH
 * copy is read, both of which are invisible in the output shape:
 *
 *   · a report reads frozen text at both ends, never a draft;
 *   · a month's figures are fetched only when a prior commitment carries a
 *     number, because this runs on every report render;
 *   · a failed fetch produces "not measurable", never "missed".
 */

let harness: { db: TestDb; close: () => Promise<void> };

const getPeriodMetrics = vi.fn();

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
}));

vi.mock("@/lib/metrics/queries", () => ({
  getPeriodMetrics: (...args: unknown[]) => getPeriodMetrics(...args),
}));

const { loadCommentaryForReport, loadCommentaryForEditor } = await import("./report");
const { saveCommentary, publishCommentary } = await import("./store");

const TZ = "America/Los_Angeles";

const client = (o: Partial<Client> = {}): Client =>
  ({
    id: CLIENT_A,
    name: "Parfaire",
    slug: "parfaire",
    timezone: TZ,
    paidLeadFilter: "either",
    paidLeadTag: "facebook-lead",
    metaCurrency: "USD",
    ...o,
  }) as Client;

const metrics = (over: Record<string, unknown> = {}) => ({
  label: "2026-08",
  window: {},
  funnel: { new_lead: 20, appointment_booked: 7, showed: 4, closed_won: 2 },
  ads: { spend: 940 },
  revenue: { revenue: 18_400, wonOpps: 2, wonWithValue: 2 },
  derived: {
    cpLead: 47, cpAppt: 134, cpWon: 470,
    bookPct: 0.35, showPct: 0.57, closePct: 0.5,
    ctr: 0.02, cpc: 1.4, cpm: 12.5, roas: 19.5,
  },
  ...over,
});

const AUG = { clientId: CLIENT_A, platform: "meta" as const, month: "2026-08" };
const JUL = { ...AUG, month: "2026-07" };

const plan = (over: Partial<Commitment> = {}): Commitment => ({
  id: "c1",
  text: "Get cost per lead down",
  target: null,
  ...over,
});

beforeAll(async () => {
  harness = await createTestDb();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.execute(sql`DELETE FROM monthly_commentary`);
  getPeriodMetrics.mockReset();
  getPeriodMetrics.mockResolvedValue(metrics());
});

/* ------------------------------------------------------------------ *
 * The report path
 * ------------------------------------------------------------------ */

describe("loadCommentaryForReport", () => {
  it("returns nothing when the month has no published commentary", async () => {
    await saveCommentary(AUG, { did: "draft only", commitments: [], outcomes: [] }, "u");
    expect(await loadCommentaryForReport(client(), "meta", "2026-08")).toBeNull();
  });

  it("returns the published text with no accountability when there is no prior month", async () => {
    await saveCommentary(AUG, { did: "what we did", commitments: [plan()], outcomes: [] }, "u");
    await publishCommentary(AUG, "u");

    const r = await loadCommentaryForReport(client(), "meta", "2026-08");
    expect(r?.did).toBe("what we did");
    expect(r?.commitments).toHaveLength(1);
    expect(r?.accountability).toBeNull();
  });

  it("🔴 does not fetch a month's figures when no prior commitment carries a number", async () => {
    /*
     * This runs on every report render, including a share link. An untargeted
     * plan is answered entirely by a person, so the query would be pure cost.
     */
    await saveCommentary(JUL, { did: "", commitments: [plan({ id: "a" })], outcomes: [] }, "u");
    await publishCommentary(JUL, "u");
    await saveCommentary(
      AUG,
      { did: "x", commitments: [], outcomes: [{ commitmentId: "a", verdict: "done", note: "" }] },
      "u",
    );
    await publishCommentary(AUG, "u");

    const r = await loadCommentaryForReport(client(), "meta", "2026-08");
    expect(getPeriodMetrics).not.toHaveBeenCalled();
    expect(r?.accountability?.items[0].status).toBe("done");
  });

  it("fetches the figures once when a prior commitment carries a number", async () => {
    await saveCommentary(
      JUL,
      {
        did: "",
        commitments: [
          plan({ id: "a", target: { metric: "cpLead", direction: "at_most", value: 40 } }),
          plan({ id: "b" }),
        ],
        outcomes: [],
      },
      "u",
    );
    await publishCommentary(JUL, "u");
    await saveCommentary(AUG, { did: "x", commitments: [], outcomes: [] }, "u");
    await publishCommentary(AUG, "u");

    const r = await loadCommentaryForReport(client(), "meta", "2026-08");
    expect(getPeriodMetrics).toHaveBeenCalledTimes(1);
    expect(r?.accountability?.items[0].status).toBe("missed");
    expect(r?.accountability?.items[0].actual).toBe(47);
    // The untargeted one is still carried, unanswered.
    expect(r?.accountability?.items[1].status).toBe("unanswered");
    expect(r?.accountability?.unanswered).toBe(1);
  });

  it("🔴 measures a target over the month carrying the verdict, not the month it was written in", async () => {
    await saveCommentary(
      JUL,
      { did: "", commitments: [plan({ id: "a", target: { metric: "cpLead", direction: "at_most", value: 40 } })], outcomes: [] },
      "u",
    );
    await publishCommentary(JUL, "u");
    await saveCommentary(AUG, { did: "x", commitments: [], outcomes: [] }, "u");
    await publishCommentary(AUG, "u");

    await loadCommentaryForReport(client(), "meta", "2026-08");
    // August's window, not July's. The reader can check the claim against the
    // figures on the same page only if this is the month they are reading.
    const window = getPeriodMetrics.mock.calls[0][1];
    expect(window.startKey).toBe("2026-08-01");
    expect(window.endKey).toBe("2026-08-31");
  });

  it("passes the client's own lead filter, so the figure matches the dashboard", async () => {
    await saveCommentary(
      JUL,
      { did: "", commitments: [plan({ id: "a", target: { metric: "cpLead", direction: "at_most", value: 40 } })], outcomes: [] },
      "u",
    );
    await publishCommentary(JUL, "u");
    await saveCommentary(AUG, { did: "x", commitments: [], outcomes: [] }, "u");
    await publishCommentary(AUG, "u");

    await loadCommentaryForReport(
      client({ paidLeadFilter: "tagged", paidLeadTag: "fb" }),
      "meta",
      "2026-08",
    );
    expect(getPeriodMetrics.mock.calls[0][4]).toEqual({ mode: "tagged", tag: "fb" });
    // Revenue opted in, because a target may be set on revenue or ROAS.
    expect(getPeriodMetrics.mock.calls[0][6]).toBe(true);
  });

  it("🔴 reports unmeasurable, not missed, when the figures cannot be fetched", async () => {
    getPeriodMetrics.mockRejectedValue(new Error("connection terminated"));
    await saveCommentary(
      JUL,
      { did: "", commitments: [plan({ id: "a", target: { metric: "cpLead", direction: "at_most", value: 40 } })], outcomes: [] },
      "u",
    );
    await publishCommentary(JUL, "u");
    await saveCommentary(AUG, { did: "x", commitments: [], outcomes: [] }, "u");
    await publishCommentary(AUG, "u");

    const r = await loadCommentaryForReport(client(), "meta", "2026-08");
    expect(r?.accountability?.items[0].status).toBe("unmeasurable");
    expect(r?.accountability?.counts.missed).toBe(0);
  });

  it("🔴 carries forward the published plan, never the draft that replaced it", async () => {
    await saveCommentary(JUL, { did: "", commitments: [plan({ id: "promised" })], outcomes: [] }, "u");
    await publishCommentary(JUL, "u");
    await saveCommentary(JUL, { did: "", commitments: [plan({ id: "rewritten" })], outcomes: [] }, "u");
    await saveCommentary(AUG, { did: "x", commitments: [], outcomes: [] }, "u");
    await publishCommentary(AUG, "u");

    const r = await loadCommentaryForReport(client(), "meta", "2026-08");
    expect(r?.accountability?.items.map((i) => i.commitment.id)).toEqual(["promised"]);
  });

  it("drops an accountability block with no items rather than rendering an empty one", async () => {
    await saveCommentary(JUL, { did: "just prose", commitments: [], outcomes: [] }, "u");
    await publishCommentary(JUL, "u");
    await saveCommentary(AUG, { did: "x", commitments: [], outcomes: [] }, "u");
    await publishCommentary(AUG, "u");

    const r = await loadCommentaryForReport(client(), "meta", "2026-08");
    expect(r?.accountability).toBeNull();
  });

  it("carries the client's currency for the figures it prints", async () => {
    await saveCommentary(AUG, { did: "x", commitments: [], outcomes: [] }, "u");
    await publishCommentary(AUG, "u");
    expect((await loadCommentaryForReport(client({ metaCurrency: "GBP" }), "meta", "2026-08"))?.currency).toBe("GBP");
    expect((await loadCommentaryForReport(client({ metaCurrency: null }), "meta", "2026-08"))?.currency).toBe("USD");
  });
});

/* ------------------------------------------------------------------ *
 * The editor path
 * ------------------------------------------------------------------ */

describe("loadCommentaryForEditor", () => {
  it("returns the working copy, unlike the report path", async () => {
    await saveCommentary(AUG, { did: "still drafting", commitments: [], outcomes: [] }, "u");
    const r = await loadCommentaryForEditor(client(), "meta", "2026-08");
    expect(r.current?.did).toBe("still drafting");
    expect(r.current?.published).toBeNull();
  });

  it("reports an unpublished prior plan as unpublished rather than pretending it is absent", async () => {
    await saveCommentary(JUL, { did: "", commitments: [plan({ id: "private" })], outcomes: [] }, "u");
    const r = await loadCommentaryForEditor(client(), "meta", "2026-08");
    expect(r.prior?.published).toBe(false);
    expect(r.prior?.commitments).toEqual([]);
    // Nothing to judge, so nothing was fetched.
    expect(getPeriodMetrics).not.toHaveBeenCalled();
  });

  it("fetches the figures so a derived verdict is visible while writing", async () => {
    await saveCommentary(
      JUL,
      { did: "", commitments: [plan({ id: "a", target: { metric: "leads", direction: "at_least", value: 15 } })], outcomes: [] },
      "u",
    );
    await publishCommentary(JUL, "u");
    const r = await loadCommentaryForEditor(client(), "meta", "2026-08");
    expect(getPeriodMetrics).toHaveBeenCalledTimes(1);
    expect(r.actuals?.funnel.new_lead).toBe(20);
  });

  it("passes the store's error through instead of throwing", async () => {
    await harness.db.execute(sql`ALTER TABLE monthly_commentary RENAME TO hidden_mc`);
    try {
      const r = await loadCommentaryForEditor(client(), "meta", "2026-08");
      expect(r.error).toBeTruthy();
      expect(r.current).toBeNull();
    } finally {
      await harness.db.execute(sql`ALTER TABLE hidden_mc RENAME TO monthly_commentary`);
    }
  });
});
