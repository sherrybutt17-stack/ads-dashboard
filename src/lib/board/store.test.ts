import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, type TestDb } from "@/lib/metrics/__testdb__/harness";
import type { StarterContext } from "./catalog";
import type { BoardWidget } from "./types";

/**
 * Saving a client's board — the agency and the client edit the same row, so
 * the two properties that matter are that nobody silently overwrites anybody
 * and that a client can never undo the agency's lock.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let store: typeof import("./store");

const STARTER: StarterContext = {
  hasMeta: true,
  hasGoogle: false,
  hasTiktok: false,
  hasCrm: true,
  hasLogo: false,
  clientName: "Acme",
};

const k = (id: string, x = 0, y = 0): BoardWidget => ({
  id,
  kind: "kpi",
  platform: "meta",
  metric: "spend",
  x,
  y,
  w: 3,
  h: 3,
});

beforeAll(async () => {
  harness = await createTestDb();
  store = await import("./store");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.db.execute(sql`DELETE FROM dashboard_boards`);
});

describe("reading", () => {
  it("shows the computed starter until someone saves", async () => {
    const b = await store.getBoard(CLIENT_A, STARTER);
    expect(b.customised).toBe(false);
    expect(b.updatedAt).toBeNull();
    expect(b.widgets.length).toBeGreaterThan(3);
  });

  it("falls back to the starter for an unreadable row, keeping its lock", async () => {
    await harness.db.execute(sql`
      INSERT INTO dashboard_boards (client_id, widgets, locked) VALUES (${CLIENT_A}, '{"oops": 1}', true)
    `);
    const b = await store.getBoard(CLIENT_A, STARTER);
    expect(b.problem).toBe("unreadable");
    expect(b.locked).toBe(true);
    expect(b.customised).toBe(true);
    expect(b.updatedAt).not.toBeNull();
  });

  it("does not guess at a row from a newer version", async () => {
    await harness.db.execute(sql`
      INSERT INTO dashboard_boards (client_id, widgets, schema_version) VALUES (${CLIENT_A}, '[]', 99)
    `);
    expect((await store.getBoard(CLIENT_A, STARTER)).problem).toBe("newer_version");
  });

  it("🔴 shows the starter, not an error, when the table is missing", async () => {
    await harness.db.execute(sql`ALTER TABLE dashboard_boards RENAME TO dashboard_boards_away`);
    try {
      const b = await store.getBoard(CLIENT_A, STARTER);
      expect(b.problem).toBe("unavailable");
      expect(b.widgets.length).toBeGreaterThan(0);
    } finally {
      await harness.db.execute(sql`ALTER TABLE dashboard_boards_away RENAME TO dashboard_boards`);
    }
  });
});

describe("saving", () => {
  it("saves a first board, and refuses a second first save", async () => {
    const first = await store.saveBoard(CLIENT_A, {
      widgets: [k("a1")],
      expectNew: true,
      updatedBy: "u1",
      starter: STARTER,
    });
    expect(first.ok).toBe(true);
    // 🔴 Two people opened the starter; the second save must not overwrite the first.
    const second = await store.saveBoard(CLIENT_A, {
      widgets: [k("b2")],
      expectNew: true,
      updatedBy: "u2",
      starter: STARTER,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.current.widgets.map((w) => w.id)).toEqual(["a1"]);
  });

  it("refuses a save made from a stale copy", async () => {
    const first = await store.saveBoard(CLIENT_A, { widgets: [k("a1")], expectNew: true, updatedBy: "u1", starter: STARTER });
    if (!first.ok) throw new Error("setup");
    const stamp = first.board.updatedAt!.toISOString();

    const fresh = await store.saveBoard(CLIENT_A, {
      widgets: [k("a1"), k("b2", 3)],
      ifUnmodifiedSince: stamp,
      updatedBy: "u1",
      starter: STARTER,
    });
    expect(fresh.ok).toBe(true);

    const stale = await store.saveBoard(CLIENT_A, {
      widgets: [k("c3")],
      ifUnmodifiedSince: stamp,
      updatedBy: "u2",
      starter: STARTER,
    });
    expect(stale.ok).toBe(false);
    expect((await store.getBoard(CLIENT_A, STARTER)).widgets.map((w) => w.id)).toEqual(["a1", "b2"]);
  });

  it("🔴 keeps the lock when a save does not name it", async () => {
    await store.saveBoard(CLIENT_A, { locked: true, updatedBy: "staff", starter: STARTER });
    const locked = await store.getBoard(CLIENT_A, STARTER);
    expect(locked.locked).toBe(true);
    // A lock on a never-saved board stores the starter so the lock has something to hold.
    expect(locked.widgets.length).toBeGreaterThan(3);

    await store.saveBoard(CLIENT_A, {
      widgets: [k("a1")],
      ifUnmodifiedSince: locked.updatedAt!.toISOString(),
      updatedBy: "staff",
      starter: STARTER,
    });
    expect((await store.getBoard(CLIENT_A, STARTER)).locked).toBe(true);
  });

  it("stores the layout the renderer would draw", async () => {
    await store.saveBoard(CLIENT_A, {
      widgets: [k("a1"), k("b2")],
      expectNew: true,
      updatedBy: "u1",
      starter: STARTER,
    });
    const [a, b] = (await store.getBoard(CLIENT_A, STARTER)).widgets;
    expect(a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  });

  it("resets to the starter by deleting the row", async () => {
    await store.saveBoard(CLIENT_A, { widgets: [k("a1")], expectNew: true, updatedBy: "u1", starter: STARTER });
    await store.resetBoard(CLIENT_A);
    expect((await store.getBoard(CLIENT_A, STARTER)).customised).toBe(false);
  });
});
