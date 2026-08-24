import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { ClientLayoutSchema, StaffLayoutSchema } from "./layout-write";
import {
  createTestDb,
  CLIENT_A,
  CLIENT_B,
  type TestDb,
} from "@/lib/metrics/__testdb__/harness";

/**
 * Layout persistence, against a real Postgres.
 *
 * Three properties that only a database can demonstrate:
 *
 *   1. 🔴 **The `locked` column survives a client write.** The plan is explicit
 *      that this must be proven by reading the row back, not by inspecting the
 *      code path — the failure mode is a value that quietly gets through.
 *   2. **Optimistic concurrency really is a race, not a check.** Staff setting a
 *      client's default and the client editing it write the SAME row, so the
 *      guard has to live in the UPDATE's WHERE clause; a read-then-write would
 *      let two callers both pass and one change vanish.
 *   3. **Canonicalisation on write.** What is stored is what the renderer would
 *      have produced, so nothing has to be re-derived on every page load.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return globalThis.__layoutHarnessDb;
  },
  schema: {},
}));

let store: typeof import("./layout-store");

beforeAll(async () => {
  harness = await createTestDb();
  globalThis.__layoutHarnessDb = harness.db;
  store = await import("./layout-store");
});
afterAll(async () => {
  await harness?.close();
});

interface RawLayoutRow extends Record<string, unknown> {
  locked: boolean;
  sections: Array<{ id: string; visible: boolean }>;
  schema_version: number;
  updated_by: string | null;
}

/** The row as Postgres holds it — deliberately not through `getLayout`, which
 *  would resolve and normalise away the very values under test. */
async function maybeRow(
  clientId: string,
  audience = "client",
): Promise<RawLayoutRow | undefined> {
  const res = await harness.db.execute<RawLayoutRow>(
    sql`SELECT locked, sections, schema_version, updated_by FROM dashboard_layouts
        WHERE client_id = ${clientId} AND audience = ${audience}::layout_audience`,
  );
  return (res as unknown as { rows: RawLayoutRow[] }).rows[0];
}

/** The same, asserting the row exists — every test but the reset one expects it. */
async function rawRow(clientId: string, audience = "client"): Promise<RawLayoutRow> {
  const row = await maybeRow(clientId, audience);
  if (!row) throw new Error(`no dashboard_layouts row for ${clientId}/${audience}`);
  return row;
}

describe("🔴 a locked layout stays locked", () => {
  it("the DB row still reads locked=true after a client write", async () => {
    // Staff lock it.
    await store.saveLayout(CLIENT_A, "client", {
      sections: [{ id: "kpis", visible: true }],
      locked: true,
      updatedBy: "staff-1",
    });
    expect((await rawRow(CLIENT_A)).locked).toBe(true);

    /*
     * The client sends the hostile payload. It never survives the client
     * schema, so the route 400s — but the decisive check is the column, because
     * "the code would have rejected it" is exactly the claim a test exists to
     * stop us making on faith.
     */
    const hostile = { sections: [{ id: "funnel", visible: false }], locked: false };
    expect(ClientLayoutSchema.safeParse(hostile).success).toBe(false);

    // Now the write the client CAN legitimately make, with no `locked` key at
    // all — the writer must leave the column alone rather than defaulting it.
    const parsed = ClientLayoutSchema.safeParse({ sections: hostile.sections });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      await store.saveLayout(CLIENT_A, "client", {
        sections: parsed.data.sections,
        updatedBy: "client-1",
      });
    }

    const row = await rawRow(CLIENT_A);
    expect(row.locked).toBe(true);
    expect(row.updated_by).toBe("client-1");
  });

  it("staff CAN unlock, via the schema that carries the field", async () => {
    // The control: without this, the assertion above could pass because the
    // writer ignores `locked` entirely rather than because the schema stopped
    // the client.
    const parsed = StaffLayoutSchema.safeParse({
      sections: [{ id: "kpis", visible: true }],
      locked: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      await store.saveLayout(CLIENT_A, "client", {
        sections: parsed.data.sections,
        locked: parsed.data.locked,
        updatedBy: "staff-1",
      });
    }
    expect((await rawRow(CLIENT_A)).locked).toBe(false);
  });
});

describe("canonicalisation on write", () => {
  it("stores the RESOLVED layout, not the raw payload", async () => {
    await store.saveLayout(CLIENT_B, "client", {
      sections: [
        { id: "kpis", visible: true },
        { id: "a_deleted_section", visible: true },
        { id: "kpis", visible: false },
      ],
      updatedBy: null,
    });

    const storedIds = (await rawRow(CLIENT_B)).sections.map((s) => s.id);

    // The unknown id is gone, the duplicate collapsed, and every registry
    // section is present with an explicit visibility — so a reader never has to
    // guess what an absent id meant.
    expect(storedIds).not.toContain("a_deleted_section");
    expect(storedIds.filter((i) => i === "kpis")).toHaveLength(1);
    expect(new Set(storedIds).size).toBe(storedIds.length);
  });

  it("required sections are stored visible whatever was sent", async () => {
    await store.saveLayout(CLIENT_B, "client", {
      sections: [{ id: "lead_filter_note", visible: false }],
      updatedBy: null,
    });
    const stored = (await rawRow(CLIENT_B)).sections;
    expect(stored.find((s) => s.id === "lead_filter_note")?.visible).toBe(true);
  });

  it("stamps the current schema version", async () => {
    expect((await rawRow(CLIENT_B)).schema_version).toBe(1);
  });
});

describe("audiences are isolated", () => {
  it("writing the client row leaves the staff row alone", async () => {
    await store.saveLayout(CLIENT_A, "staff", {
      sections: [{ id: "kpis", visible: true }],
      updatedBy: "staff-1",
    });
    await store.saveLayout(CLIENT_A, "client", {
      sections: [{ id: "campaigns", visible: false }],
      updatedBy: "client-1",
    });

    const staffRow = await store.getLayout(CLIENT_A, "staff");
    const clientRow = await store.getLayout(CLIENT_A, "client");

    /*
     * The isolation this exists for: a client hiding the campaign table must not
     * blind the agency on the same page, because the agency is who notices when
     * a feed dies.
     */
    expect(
      staffRow.sections.find((s) => s.def.id === "campaigns")?.visible,
    ).toBe(true);
    expect(
      clientRow.sections.find((s) => s.def.id === "campaigns")?.visible,
    ).toBe(false);
  });

  it("one client's layout is not another's", async () => {
    const a = await store.getLayout(CLIENT_A, "client");
    const b = await store.getLayout(CLIENT_B, "client");
    expect(a.updatedBy).not.toBe(b.updatedBy);
  });
});

describe("optimistic concurrency", () => {
  it("🔴 the second of two writers gets a conflict, not a silent overwrite", async () => {
    await store.saveLayout(CLIENT_B, "client", {
      sections: [{ id: "kpis", visible: true }],
      updatedBy: "first",
    });
    const seen = await store.getLayout(CLIENT_B, "client");
    const stamp = seen.updatedAt!.toISOString();

    // Someone else saves in between.
    await store.saveLayout(CLIENT_B, "client", {
      sections: [{ id: "funnel", visible: false }],
      updatedBy: "second",
    });

    // Our conditional write now refers to a version that no longer exists.
    const outcome = await store.saveLayout(CLIENT_B, "client", {
      sections: [{ id: "heatmap", visible: false }],
      updatedBy: "first",
      ifUnmodifiedSince: stamp,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // …and the caller is handed the CURRENT state, so the UI can show what it
      // is actually about to overwrite rather than asking them to guess.
      expect(outcome.current.updatedBy).toBe("second");
    }
    // The other writer's change survived untouched.
    expect((await store.getLayout(CLIENT_B, "client")).updatedBy).toBe("second");
  });

  it("succeeds when the stamp still matches", async () => {
    const seen = await store.getLayout(CLIENT_B, "client");
    const outcome = await store.saveLayout(CLIENT_B, "client", {
      sections: [{ id: "kpis", visible: true }],
      updatedBy: "third",
      ifUnmodifiedSince: seen.updatedAt!.toISOString(),
    });
    expect(outcome.ok).toBe(true);
    expect((await store.getLayout(CLIENT_B, "client")).updatedBy).toBe("third");
  });

  it("a conditional write against a row that does not exist is a conflict", async () => {
    // Not a silent insert: the caller is working from a view of the world that
    // was never true, and proceeding would overwrite a decision they never saw.
    const outcome = await store.saveLayout(
      "33333333-3333-3333-3333-333333333333",
      "client",
      {
        sections: [{ id: "kpis", visible: true }],
        updatedBy: "nobody",
        ifUnmodifiedSince: new Date("2020-01-01T00:00:00.000Z").toISOString(),
      },
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("reset", () => {
  it("deletes the row rather than storing a snapshot of today's defaults", async () => {
    /*
     * A stored copy of the defaults stops TRACKING them: a section shipped next
     * month would arrive visible for everyone on real defaults, and be governed
     * by a frozen snapshot for anyone who had ever pressed Reset.
     */
    await store.resetLayout(CLIENT_B, "client");
    expect(await maybeRow(CLIENT_B)).toBeUndefined();

    const after = await store.getLayout(CLIENT_B, "client");
    expect(after.customised).toBe(false);
    expect(after.locked).toBe(false);
    expect(after.sections.length).toBeGreaterThan(0);
  });
});

describe("degradation", () => {
  it("returns defaults, never throws, when the table is missing", async () => {
    await harness.db.execute(
      sql`ALTER TABLE dashboard_layouts RENAME TO dashboard_layouts_x`,
    );
    try {
      const out = await store.getLayout(CLIENT_A, "client");
      expect(out.customised).toBe(false);
      expect(out.sections.length).toBeGreaterThan(0);
      expect(out.locked).toBe(false);
    } finally {
      await harness.db.execute(
        sql`ALTER TABLE dashboard_layouts_x RENAME TO dashboard_layouts`,
      );
    }
  });
});

declare global {
  var __layoutHarnessDb: TestDb | undefined;
}
