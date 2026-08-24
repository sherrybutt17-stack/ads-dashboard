import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  CLIENT_A,
  CLIENT_B,
  type TestDb,
} from "@/lib/metrics/__testdb__/harness";
import type { Commitment, Outcome } from "./model";

/**
 * The publish boundary and the month key, against a real Postgres.
 *
 * Two things here cannot be checked by a typechecker and are the whole point of
 * the design:
 *
 *   1. `saveCommentary` physically leaves the `published_*` columns alone. Only
 *      a row can show that.
 *   2. `publishCommentary` copies COLUMN to COLUMN — `SET published_did = did` —
 *      rather than reading the row into JavaScript and writing it back. That is
 *      what makes it impossible to publish text that was never stored, and it
 *      is a Drizzle behaviour worth pinning rather than assuming.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
}));

const {
  getCommentary,
  getPublishedMonths,
  saveCommentary,
  publishCommentary,
  unpublishCommentary,
} = await import("./store");

const AUG = { clientId: CLIENT_A, platform: "meta" as const, month: "2026-08" };
const JUL = { ...AUG, month: "2026-07" };

const plan = (over: Partial<Commitment> = {}): Commitment => ({
  id: "c1",
  text: "Rebuild the top-of-funnel creative",
  target: null,
  ...over,
});

const content = (over: Partial<{
  did: string;
  commitments: Commitment[];
  outcomes: Outcome[];
}> = {}) => ({
  did: "Rebuilt three ad sets and cut the worst performer.",
  commitments: [plan()],
  outcomes: [] as Outcome[],
  ...over,
});

/** Read the raw columns — the point is what is physically stored. */
async function raw(month = "2026-08", clientId = CLIENT_A) {
  const res = await harness.db.execute(sql`
    SELECT did, commitments, outcomes,
           published_did, published_commitments, published_outcomes,
           published_at, published_by, updated_by
    FROM monthly_commentary
    WHERE client_id = ${clientId} AND month = ${month}
  `);
  const rows =
    (res as unknown as { rows?: Record<string, unknown>[] }).rows ??
    (res as unknown as Record<string, unknown>[]);
  return rows[0] ?? null;
}

beforeAll(async () => {
  harness = await createTestDb();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.execute(sql`DELETE FROM monthly_commentary`);
});

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

describe("saveCommentary", () => {
  it("stores the working copy and nothing else", async () => {
    await saveCommentary(AUG, content(), "user-1");
    const row = await raw();
    expect(row?.did).toBe("Rebuilt three ad sets and cut the worst performer.");
    expect(row?.updated_by).toBe("user-1");
    // 🔴 The guarantee. Nothing here reached a client.
    expect(row?.published_did).toBeNull();
    expect(row?.published_at).toBeNull();
    expect(row?.published_by).toBeNull();
  });

  it("round-trips commitments and outcomes through jsonb", async () => {
    const c = plan({
      id: "abc",
      target: { metric: "cpLead", direction: "at_most", value: 40 },
    });
    const stored = await saveCommentary(
      AUG,
      content({
        commitments: [c],
        outcomes: [{ commitmentId: "prev", verdict: "partly", note: "Half." }],
      }),
      "user-1",
    );
    expect(stored.commitments).toEqual([c]);
    expect(stored.outcomes).toEqual([
      { commitmentId: "prev", verdict: "partly", note: "Half." },
    ]);
  });

  it("upserts on the month rather than inserting a second row", async () => {
    await saveCommentary(AUG, content({ did: "first" }), "user-1");
    await saveCommentary(AUG, content({ did: "second" }), "user-2");
    const res = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM monthly_commentary WHERE client_id = ${CLIENT_A}
    `);
    const rows =
      (res as unknown as { rows?: { n: number }[] }).rows ??
      (res as unknown as { n: number }[]);
    expect(rows[0].n).toBe(1);
    expect((await raw())?.did).toBe("second");
    expect((await raw())?.updated_by).toBe("user-2");
  });

  it("🔴 leaves a published copy untouched when the working copy is re-saved", async () => {
    await saveCommentary(AUG, content({ did: "sent to the client" }), "user-1");
    await publishCommentary(AUG, "user-1");
    await saveCommentary(AUG, content({ did: "still being reworked" }), "user-1");

    const row = await raw();
    expect(row?.did).toBe("still being reworked");
    // What the client is reading has not moved.
    expect(row?.published_did).toBe("sent to the client");
  });

  it("keeps months, platforms and clients in separate rows", async () => {
    await saveCommentary(AUG, content({ did: "august meta" }), "u");
    await saveCommentary(JUL, content({ did: "july meta" }), "u");
    await saveCommentary({ ...AUG, platform: "google" }, content({ did: "august google" }), "u");
    await saveCommentary({ ...AUG, clientId: CLIENT_B }, content({ did: "other client" }), "u");

    const res = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM monthly_commentary
    `);
    const rows =
      (res as unknown as { rows?: { n: number }[] }).rows ??
      (res as unknown as { n: number }[]);
    expect(rows[0].n).toBe(4);
    expect((await raw("2026-07"))?.did).toBe("july meta");
    expect((await raw("2026-08", CLIENT_B))?.did).toBe("other client");
  });
});

/* ------------------------------------------------------------------ *
 * Publishing
 * ------------------------------------------------------------------ */

describe("publishCommentary", () => {
  it("🔴 copies column to column, so only stored text can be published", async () => {
    const c = plan({ id: "x", target: { metric: "leads", direction: "at_least", value: 25 } });
    await saveCommentary(AUG, content({ did: "the reviewed text", commitments: [c] }), "u");

    const stored = await publishCommentary(AUG, "publisher");
    const row = await raw();

    expect(row?.published_did).toBe("the reviewed text");
    expect(row?.published_commitments).toEqual([c]);
    expect(row?.published_by).toBe("publisher");
    expect(row?.published_at).not.toBeNull();
    expect(stored?.published?.did).toBe("the reviewed text");
    expect(stored?.hasUnpublishedChanges).toBe(false);
  });

  it("returns null rather than creating a row for a month nobody has written", async () => {
    expect(await publishCommentary(AUG, "u")).toBeNull();
    expect(await raw()).toBeNull();
  });

  it("flags a working copy that has moved on since it was published", async () => {
    await saveCommentary(AUG, content({ did: "v1" }), "u");
    await publishCommentary(AUG, "u");
    const stored = await saveCommentary(AUG, content({ did: "v2" }), "u");
    expect(stored.hasUnpublishedChanges).toBe(true);
    expect(stored.published?.did).toBe("v1");
  });

  it("notices a change to the commitments alone, not just the prose", async () => {
    await saveCommentary(AUG, content({ commitments: [plan({ id: "a" })] }), "u");
    await publishCommentary(AUG, "u");
    const stored = await saveCommentary(
      AUG,
      content({ commitments: [plan({ id: "a" }), plan({ id: "b", text: "and this" })] }),
      "u",
    );
    expect(stored.hasUnpublishedChanges).toBe(true);
  });

  it("notices a change to an answer alone", async () => {
    await saveCommentary(AUG, content(), "u");
    await publishCommentary(AUG, "u");
    const stored = await saveCommentary(
      AUG,
      content({ outcomes: [{ commitmentId: "p", verdict: "done", note: "" }] }),
      "u",
    );
    expect(stored.hasUnpublishedChanges).toBe(true);
  });

  it("republishing clears the flag", async () => {
    await saveCommentary(AUG, content({ did: "v1" }), "u");
    await publishCommentary(AUG, "u");
    await saveCommentary(AUG, content({ did: "v2" }), "u");
    const stored = await publishCommentary(AUG, "u");
    expect(stored?.hasUnpublishedChanges).toBe(false);
    expect(stored?.published?.did).toBe("v2");
  });

  it("withdrawing clears the frozen copy and leaves the working one alone", async () => {
    await saveCommentary(AUG, content({ did: "v1" }), "u");
    await publishCommentary(AUG, "u");
    const stored = await unpublishCommentary(AUG);
    expect(stored?.published).toBeNull();
    expect(stored?.did).toBe("v1");
    const row = await raw();
    expect(row?.published_did).toBeNull();
    expect(row?.published_at).toBeNull();
    expect(row?.did).toBe("v1");
  });
});

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

describe("getCommentary", () => {
  it("returns nothing for a month nobody has written", async () => {
    const r = await getCommentary(AUG);
    expect(r.current).toBeNull();
    expect(r.prior).toBeNull();
    expect(r.error).toBeNull();
  });

  it("finds the previous month by string arithmetic across a year boundary", async () => {
    const JAN = { ...AUG, month: "2026-01" };
    await saveCommentary({ ...AUG, month: "2025-12" }, content({ commitments: [plan({ id: "dec" })] }), "u");
    await publishCommentary({ ...AUG, month: "2025-12" }, "u");
    const r = await getCommentary(JAN);
    expect(r.prior?.month).toBe("2025-12");
    expect(r.prior?.commitments.map((c) => c.id)).toEqual(["dec"]);
  });

  it("🔴 carries forward the PUBLISHED plan, not the draft", async () => {
    /*
     * A plan that was never published was never shown to the client. Answering
     * it on their report would present a promise they never received — so the
     * prior month reports as unpublished with no commitments carried, and the
     * editor says so rather than showing nothing.
     */
    await saveCommentary(JUL, content({ commitments: [plan({ id: "private" })] }), "u");
    const r = await getCommentary(AUG);
    expect(r.prior?.published).toBe(false);
    expect(r.prior?.commitments).toEqual([]);
  });

  it("carries forward the plan as it was published, not as it was later edited", async () => {
    await saveCommentary(JUL, content({ commitments: [plan({ id: "promised" })] }), "u");
    await publishCommentary(JUL, "u");
    await saveCommentary(JUL, content({ commitments: [plan({ id: "rewritten" })] }), "u");

    const r = await getCommentary(AUG);
    expect(r.prior?.published).toBe(true);
    expect(r.prior?.commitments.map((c) => c.id)).toEqual(["promised"]);
  });

  it("does not mistake another platform's plan for this one", async () => {
    await saveCommentary({ ...JUL, platform: "google" }, content({ commitments: [plan({ id: "g" })] }), "u");
    await publishCommentary({ ...JUL, platform: "google" }, "u");
    const r = await getCommentary(AUG);
    expect(r.prior).toBeNull();
  });

  it("does not mistake another client's plan for this one", async () => {
    await saveCommentary({ ...JUL, clientId: CLIENT_B }, content(), "u");
    await publishCommentary({ ...JUL, clientId: CLIENT_B }, "u");
    const r = await getCommentary(AUG);
    expect(r.prior).toBeNull();
  });

  it("degrades to an error string rather than throwing when the table is gone", async () => {
    await harness.db.execute(sql`ALTER TABLE monthly_commentary RENAME TO monthly_commentary_hidden`);
    try {
      const r = await getCommentary(AUG);
      expect(r.current).toBeNull();
      expect(r.prior).toBeNull();
      expect(r.error).toBeTruthy();
    } finally {
      await harness.db.execute(sql`ALTER TABLE monthly_commentary_hidden RENAME TO monthly_commentary`);
    }
  });
});

describe("getPublishedMonths", () => {
  it("🔴 never returns a draft, at either end", async () => {
    await saveCommentary(JUL, content({ commitments: [plan({ id: "jul" })] }), "u");
    await saveCommentary(AUG, content({ did: "august draft" }), "u");

    const r = await getPublishedMonths(AUG);
    expect(r.current).toBeNull();
    expect(r.prior).toBeNull();
  });

  it("returns both months once both are published", async () => {
    await saveCommentary(JUL, content({ commitments: [plan({ id: "jul" })] }), "u");
    await publishCommentary(JUL, "u");
    await saveCommentary(AUG, content({ did: "august published" }), "u");
    await publishCommentary(AUG, "u");

    const r = await getPublishedMonths(AUG);
    expect(r.current?.did).toBe("august published");
    expect(r.prior?.month).toBe("2026-07");
    expect(r.prior?.commitments.map((c) => c.id)).toEqual(["jul"]);
  });

  it("returns this month alone when only this month is published", async () => {
    await saveCommentary(JUL, content({ commitments: [plan({ id: "jul" })] }), "u");
    await saveCommentary(AUG, content({ did: "august" }), "u");
    await publishCommentary(AUG, "u");

    const r = await getPublishedMonths(AUG);
    expect(r.current?.did).toBe("august");
    expect(r.prior).toBeNull();
  });

  it("returns nulls rather than throwing when the table is gone", async () => {
    await harness.db.execute(sql`ALTER TABLE monthly_commentary RENAME TO monthly_commentary_hidden`);
    try {
      const r = await getPublishedMonths(AUG);
      expect(r).toEqual({ current: null, prior: null });
    } finally {
      await harness.db.execute(sql`ALTER TABLE monthly_commentary_hidden RENAME TO monthly_commentary`);
    }
  });

  it("survives jsonb written by hand in a shape it does not recognise", async () => {
    // Lenient on read: the panel degrades, the page does not.
    await saveCommentary(AUG, content(), "u");
    await publishCommentary(AUG, "u");
    await harness.db.execute(sql`
      UPDATE monthly_commentary
      SET published_commitments = '"not an array"'::jsonb,
          published_outcomes = '[{"commitmentId": 7}]'::jsonb
      WHERE client_id = ${CLIENT_A} AND month = '2026-08'
    `);
    const r = await getPublishedMonths(AUG);
    expect(r.current?.commitments).toEqual([]);
    expect(r.current?.outcomes).toEqual([]);
  });
});
