import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, type TestDb } from "@/lib/metrics/__testdb__/harness";
import type { SummaryDraft } from "./summary";

/**
 * The publish boundary, tested against a real Postgres.
 *
 * "Never auto-publish" is the headline promise of this feature, and a promise
 * enforced by column layout deserves a test that actually inspects the columns.
 * A typechecker cannot see that `saveDraft` leaves `published_body` alone; only
 * a row can show it.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
}));

const {
  saveDraft,
  saveEdits,
  publishSummary,
  unpublishSummary,
  listSummaries,
  getPublishedSummaries,
} = await import("./store");

const PERIOD = {
  clientId: CLIENT_A,
  platform: "meta" as const,
  rangeStart: "2026-08-01",
  rangeEnd: "2026-08-07",
};

const draft = (over: Partial<SummaryDraft> = {}): SummaryDraft => ({
  framing: "summary",
  headline: "Spend held steady while leads rose.",
  body: "Leads reached 46 at $61.90 each.",
  verification: { ok: true, issues: [], checked: 2 },
  warning: null,
  model: "claude-opus-5",
  retried: false,
  ...over,
});

/** Read the raw columns — the point is what is physically stored. */
async function raw(framing = "summary") {
  const res = await harness.db.execute(sql`
    SELECT headline, body, published_headline, published_body, published_at,
           published_by, generated_by, model, updated_by
    FROM report_summaries
    WHERE client_id = ${CLIENT_A} AND framing = ${framing}::summary_framing
  `);
  return (
    (res as unknown as { rows?: Record<string, unknown>[] }).rows ??
    (res as unknown as Record<string, unknown>[])
  )[0];
}

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.db.execute(sql`DELETE FROM report_summaries`);
});

describe("generation cannot publish", () => {
  it("🔴 leaves every published column null", async () => {
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    const row = await raw();
    expect(row.headline).toBe("Spend held steady while leads rose.");
    expect(row.published_headline).toBeNull();
    expect(row.published_body).toBeNull();
    expect(row.published_at).toBeNull();
    expect(row.published_by).toBeNull();
  });

  it("🔴 regenerating never disturbs what a client already received", async () => {
    /*
     * The failure this design exists to make impossible: a share link is live,
     * somebody hits Generate, and the paragraph the client is reading silently
     * becomes a different paragraph written by a model. Here the working copy
     * changes and the published copy does not move.
     */
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    await publishSummary(PERIOD, "summary", "alice@agency.test");

    await saveDraft(
      PERIOD,
      draft({ headline: "COMPLETELY DIFFERENT", body: "Rewritten by the model." }),
      "bob@agency.test",
    );

    const row = await raw();
    expect(row.headline).toBe("COMPLETELY DIFFERENT");
    expect(row.published_headline).toBe("Spend held steady while leads rose.");
    expect(row.published_body).toBe("Leads reached 46 at $61.90 each.");

    // And the client-facing read still returns the old, reviewed text.
    const published = await getPublishedSummaries(PERIOD);
    expect(published).toEqual([
      {
        framing: "summary",
        headline: "Spend held steady while leads rose.",
        body: "Leads reached 46 at $61.90 each.",
      },
    ]);
  });

  it("editing does not publish either", async () => {
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    await saveEdits(
      PERIOD,
      "summary",
      { headline: "Hand-written", body: "By a person.", verification: null },
      "bob@agency.test",
    );
    const row = await raw();
    expect(row.headline).toBe("Hand-written");
    expect(row.published_body).toBeNull();
  });
});

describe("the client-facing read", () => {
  it("🔴 returns nothing at all while only a draft exists", async () => {
    // The single most important query in this feature. A draft is not a
    // document the agency has stood behind, however good it looks.
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    expect(await getPublishedSummaries(PERIOD)).toEqual([]);
  });

  it("returns the frozen copy after publishing, and stops after withdrawal", async () => {
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    await publishSummary(PERIOD, "summary", "alice@agency.test");
    expect(await getPublishedSummaries(PERIOD)).toHaveLength(1);

    await unpublishSummary(PERIOD, "summary");
    expect(await getPublishedSummaries(PERIOD)).toEqual([]);
    // Withdrawal keeps the working copy — it is a retraction, not a delete.
    expect((await raw()).headline).toBe("Spend held steady while leads rose.");
  });

  it("never leaks another client's summary", async () => {
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    await publishSummary(PERIOD, "summary", "alice@agency.test");
    expect(await getPublishedSummaries({ ...PERIOD, clientId: CLIENT_B })).toEqual([]);
  });

  it("never leaks another period's, or the other platform's", async () => {
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    await publishSummary(PERIOD, "summary", "alice@agency.test");
    expect(
      await getPublishedSummaries({ ...PERIOD, rangeStart: "2026-07-01", rangeEnd: "2026-07-07" }),
    ).toEqual([]);
    expect(await getPublishedSummaries({ ...PERIOD, platform: "google" })).toEqual([]);
  });
});

describe("publishing copies the stored text", () => {
  it("🔴 publishes what was reviewed, not what a caller passes", async () => {
    /*
     * `publishSummary` takes no text. It copies column to column inside one
     * UPDATE, so there is no request body that could carry different prose into
     * the published copy than the prose someone read on the screen.
     */
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    await saveEdits(
      PERIOD,
      "summary",
      { headline: "Reviewed headline", body: "Reviewed body.", verification: null },
      "bob@agency.test",
    );
    await publishSummary(PERIOD, "summary", "bob@agency.test");

    const row = await raw();
    expect(row.published_headline).toBe("Reviewed headline");
    expect(row.published_body).toBe("Reviewed body.");
    expect(row.published_by).toBe("bob@agency.test");
    expect(row.published_at).not.toBeNull();
  });

  it("marks a working copy that has drifted from what was published", async () => {
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    const published = await publishSummary(PERIOD, "summary", "alice@agency.test");
    expect(published!.hasUnpublishedChanges).toBe(false);

    const edited = await saveEdits(
      PERIOD,
      "summary",
      { headline: "Changed", body: "Since publishing.", verification: null },
      "alice@agency.test",
    );
    expect(edited!.hasUnpublishedChanges).toBe(true);
  });
});

describe("framings are separate documents", () => {
  it("stores one row per framing and replaces only that one", async () => {
    await saveDraft(PERIOD, draft({ framing: "summary" }), "alice@agency.test");
    await saveDraft(
      PERIOD,
      draft({ framing: "wins", headline: "Two campaigns improved." }),
      "alice@agency.test",
    );

    const { summaries } = await listSummaries(PERIOD);
    expect(summaries.map((s) => s.framing).sort()).toEqual(["summary", "wins"]);

    await saveDraft(
      PERIOD,
      draft({ framing: "wins", headline: "Regenerated wins." }),
      "alice@agency.test",
    );
    const after = await listSummaries(PERIOD);
    expect(after.summaries).toHaveLength(2);
    expect(after.summaries.find((s) => s.framing === "wins")!.headline).toBe(
      "Regenerated wins.",
    );
    expect(after.summaries.find((s) => s.framing === "summary")!.headline).toBe(
      "Spend held steady while leads rose.",
    );
  });
});

describe("edits take ownership of the text", () => {
  it("clears the model attribution once a person has rewritten it", async () => {
    // Continuing to label an agency's own words as model output would
    // misattribute them in both directions.
    await saveDraft(PERIOD, draft(), "alice@agency.test");
    expect((await raw()).model).toBe("claude-opus-5");

    await saveEdits(
      PERIOD,
      "summary",
      { headline: "Mine now", body: "Written by hand.", verification: null },
      "bob@agency.test",
    );
    const row = await raw();
    expect(row.model).toBeNull();
    expect(row.generated_by).toBeNull();
    expect(row.updated_by).toBe("bob@agency.test");
  });

  it("returns null when there is nothing to edit", async () => {
    expect(
      await saveEdits(
        PERIOD,
        "issues",
        { headline: "x", body: "y", verification: null },
        "bob@agency.test",
      ),
    ).toBeNull();
    expect(await publishSummary(PERIOD, "issues", "bob@agency.test")).toBeNull();
  });
});
