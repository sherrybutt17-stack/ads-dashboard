import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, CLIENT_B, CLIENT_C, type TestDb } from "@/lib/metrics/__testdb__/harness";
import type { Client } from "@/db/schema";
import type { SessionPayload } from "@/lib/session";

/**
 * Who gets the "Share this sub-account" controls.
 *
 * The owner's rule (18 Nov): the AGENCY decides which of its clients share a
 * sub-account — its own logins (Reflexion's Salman and RJ), not only Growth
 * Guild. And only its own clients are ever offered.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let panel: typeof import("./share-panel");

const HOLDER = CLIENT_A;
const SAME_AGENCY = CLIENT_B;
const OTHER_AGENCY = CLIENT_C;
const AGENCY = "ae000000-0000-0000-0000-000000000001";
const RIVAL = "ae000000-0000-0000-0000-000000000002";

const run = (s: string) => harness.db.execute(sql.raw(s));

async function holder(): Promise<Client> {
  const r = (await harness.db.execute(sql`SELECT * FROM clients WHERE id = ${HOLDER}`)) as unknown as {
    rows: Record<string, unknown>[];
  };
  const row = r.rows[0];
  return {
    ...(row as object),
    id: HOLDER,
    agencyId: AGENCY,
    timezone: "UTC",
    ghlLocationId: "loc-aloha",
    ghlShareInstallationId: null,
  } as unknown as Client;
}

const session = (role: SessionPayload["role"]): SessionPayload => ({
  userId: "u-1",
  agencyId: AGENCY,
  role,
  slugs: [],
});

beforeAll(async () => {
  harness = await createTestDb();
  panel = await import("./share-panel");
  for (const s of [
    `INSERT INTO agencies (id, name, slug) VALUES ('${AGENCY}', 'Reflexion Digital', 'reflexion'), ('${RIVAL}', 'Other', 'other')`,
    `INSERT INTO clients (id, name, slug, timezone, agency_id, ghl_location_id) VALUES
       ('${HOLDER}', 'Aloha LASER Vision', 'aloha-vision', 'UTC', '${AGENCY}', 'loc-aloha'),
       ('${SAME_AGENCY}', 'Aloha Laser Aesthetic', 'aloha-aesthetic', 'UTC', '${AGENCY}', NULL),
       ('${OTHER_AGENCY}', 'Elsewhere Clinic', 'elsewhere', 'UTC', '${RIVAL}', NULL)`,
    `INSERT INTO ghl_installations (location_id, access_token_encrypted, refresh_token_encrypted, expires_at, client_id)
     VALUES ('loc-aloha', 'x', 'y', now() + interval '1 day', '${HOLDER}')`,
  ]) {
    await run(s);
  }
});

afterAll(async () => {
  await harness?.close();
});

describe("the Share this sub-account controls", () => {
  it("🔴 are the agency's own: an agency login can add clients and stop sharing", async () => {
    const state = await panel.loadSharePanel(await holder(), session("agency"));
    expect(state.canShare).toBe(true);
    expect(state.canManage).toBe(true);
    expect(state.canEditTags).toBe(true);
    expect(state.candidates.map((c) => c.name)).toEqual(["Aloha Laser Aesthetic"]);
  });

  it("never offers another agency's client", async () => {
    const state = await panel.loadSharePanel(await holder(), session("superadmin"));
    expect(state.candidates.map((c) => c.id)).not.toContain(OTHER_AGENCY);
  });

  it("gives a client-role login no controls", async () => {
    const state = await panel.loadSharePanel(await holder(), session("client"));
    expect(state.canManage).toBe(false);
    expect(state.candidates).toEqual([]);
  });
});
