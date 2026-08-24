import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";
import type { SessionPayload } from "@/lib/session";

/**
 * Creating, naming, and reading a client.
 *
 * Three separate concerns live in this module and each fails in its own way:
 *
 *   - **the slug**, which is a client's permanent public address and is derived
 *     from a name someone typed once;
 *   - **the stage import**, which decides what the funnel counts;
 *   - **the scoped reads**, which are the only thing standing between two
 *     agencies' data.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

const ghlClient = {
  getPipelines: vi.fn(),
  getLocation: vi.fn(),
};
vi.mock("@/lib/ghl/process", () => ({
  getGhlClientAsync: vi.fn(async () => ghlClient),
}));

let mod: typeof import("./clients");

const AGENCY_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const AGENCY_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CLIENT_A = "11111111-1111-1111-1111-111111111111";
const CLIENT_B = "22222222-2222-2222-2222-222222222222";

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const stageRows = async (clientId = CLIENT_A) =>
  (
    await run(
      `SELECT ghl_stage_id, ghl_stage_name, ghl_pipeline_name, canonical_stage,
              display_order, discovered_from_webhook
         FROM pipeline_stages WHERE client_id = '${clientId}'
        ORDER BY display_order`,
    )
  ).rows;

const session = (over: Partial<SessionPayload> = {}): SessionPayload => ({
  userId: "user-1",
  agencyId: AGENCY_A,
  role: "agency",
  slugs: [],
  ...over,
});

beforeAll(async () => {
  harness = await createTestDb();
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  mod = await import("./clients");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await run(`TRUNCATE pipeline_stages, clients, agencies RESTART IDENTITY CASCADE`);
  await run(
    `INSERT INTO agencies (id, name, slug) VALUES
       ('${AGENCY_A}', 'Growth Guild', 'growth-guild'),
       ('${AGENCY_B}', 'Rival Agency', 'rival')`,
  );
  await run(
    `INSERT INTO clients (id, name, slug, agency_id, ghl_location_id, webhook_token) VALUES
       ('${CLIENT_A}', 'Acme Medical', 'acme-medical', '${AGENCY_A}', 'loc_a', 'tok_a'),
       ('${CLIENT_B}', 'Rival Client', 'rival-client', '${AGENCY_B}', 'loc_b', 'tok_b')`,
  );
});

/* ------------------------------------------------------------------ *
 * Slugs
 * ------------------------------------------------------------------ */

describe("slugify", () => {
  it("turns a business name into a URL segment", () => {
    expect(mod.slugify("Parfaire Medical Aesthetics")).toBe(
      "parfaire-medical-aesthetics",
    );
  });

  it("collapses punctuation and runs of separators", () => {
    expect(mod.slugify("Smith & Co. — Dental!!")).toBe("smith-co-dental");
  });

  it("leaves no leading or trailing separator", () => {
    expect(mod.slugify("  ***Acme***  ")).toBe("acme");
  });

  it("returns empty for a name with nothing slug-able in it", () => {
    /*
     * Not a hypothetical: a non-Latin business name reduces to nothing here,
     * because the filter is an ASCII allowlist. `uniqueSlug` is what turns
     * that into a usable address — asserted below — so this returning "" is
     * the contract rather than a gap.
     */
    expect(mod.slugify("株式会社")).toBe("");
    expect(mod.slugify("")).toBe("");
  });

  it("caps the length", () => {
    expect(mod.slugify("a".repeat(200))).toHaveLength(60);
  });
});

describe("uniqueSlug", () => {
  it("uses the plain slug when it is free", async () => {
    await expect(mod.uniqueSlug("Brand New Client")).resolves.toBe(
      "brand-new-client",
    );
  });

  it("🔴 suffixes rather than colliding", async () => {
    /*
     * `clients.slug` is UNIQUE across the whole platform, not per agency. So
     * two agencies both onboarding a "Smile Dental" is not an edge case, it is
     * Tuesday — and without this the second create throws a constraint
     * violation the operator sees as a generic failure.
     */
    await expect(mod.uniqueSlug("Acme Medical")).resolves.toBe("acme-medical-2");
  });

  it("keeps counting past the first suffix", async () => {
    await run(
      `INSERT INTO clients (name, slug, agency_id) VALUES
         ('Acme Medical 2', 'acme-medical-2', '${AGENCY_A}'),
         ('Acme Medical 3', 'acme-medical-3', '${AGENCY_A}')`,
    );
    await expect(mod.uniqueSlug("Acme Medical")).resolves.toBe("acme-medical-4");
  });

  it("🔴 still yields an address for an unslug-able name", async () => {
    // "" would make every such client collide on the same empty slug, and a
    // client with no URL has no dashboard.
    const slug = await mod.uniqueSlug("株式会社");
    expect(slug).toMatch(/^client/);
    expect(slug.length).toBeGreaterThan(0);
  });
});

describe("webhookUrlFor", () => {
  it("builds the URL an operator pastes into GoHighLevel", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://dash.example.com");
    expect(mod.webhookUrlFor({ webhookToken: "tok_a" })).toBe(
      "https://dash.example.com/api/webhooks/crm/tok_a",
    );
    vi.unstubAllEnvs();
  });

  it("does not double the separator when the base carries a trailing slash", () => {
    // The wizard shows this string for copy-paste and GHL stores whatever it is
    // given. A `//` here is not caught by anything until a webhook 404s months
    // later, by which time the stage history for those days does not exist.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://dash.example.com/");
    expect(mod.webhookUrlFor({ webhookToken: "tok_a" })).toBe(
      "https://dash.example.com/api/webhooks/crm/tok_a",
    );
    vi.unstubAllEnvs();
  });
});

/* ------------------------------------------------------------------ *
 * Stage import
 * ------------------------------------------------------------------ */

describe("importPipelineStages", () => {
  const client = () =>
    ({ id: CLIENT_A, ghlLocationId: "loc_a" }) as never;

  const pipelines = [
    {
      id: "pipe_1",
      name: "Main Pipeline",
      stages: [
        { id: "stage_new", name: "New Lead", position: 0 },
        { id: "stage_dq", name: "Disqualified", position: 1 },
        { id: "stage_won", name: "Closed Won", position: 2 },
      ],
    },
  ];

  it("🔴 imports stages UNMAPPED", async () => {
    /*
     * The defect this assertion exists for.
     *
     * This used to write a name-based guess straight into `canonical_stage` —
     * the column the funnel queries and the health check reads. Nothing
     * anywhere records whether a mapping was guessed or confirmed, because
     * there is no column for it, so the guess WAS the mapping: the funnel
     * counted it, `unmappedCanonical` came back empty, and "stage mapping
     * complete" went green without a human having looked.
     *
     * On the GHL OAuth install path this runs from `api/oauth/callback`, where
     * nobody is at the keyboard at all — a client could be fully "mapped" by
     * regex and nobody would ever be prompted.
     */
    ghlClient.getPipelines.mockResolvedValue(pipelines);
    await mod.importPipelineStages(client());

    const rows = await stageRows();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.canonical_stage).toBeNull();
  });

  it("records the names and order the operator will map against", async () => {
    ghlClient.getPipelines.mockResolvedValue(pipelines);
    await mod.importPipelineStages(client());

    expect(await stageRows()).toMatchObject([
      { ghl_stage_id: "stage_new", ghl_stage_name: "New Lead", display_order: 0 },
      { ghl_stage_id: "stage_dq", ghl_stage_name: "Disqualified", display_order: 1 },
      { ghl_stage_id: "stage_won", ghl_stage_name: "Closed Won", display_order: 2 },
    ]);
  });

  it("🔴 never overwrites a mapping on re-import", async () => {
    /*
     * Re-import is not rare — it is a button on the settings page and it runs
     * automatically on every OAuth callback. Clobbering the mapping would
     * silently detach the whole funnel from its history, and
     * `reclassifyTransitions` would then relabel thousands of past events to
     * match. The numbers would move overnight with no cause anyone could name.
     */
    ghlClient.getPipelines.mockResolvedValue(pipelines);
    await mod.importPipelineStages(client());
    await run(
      `UPDATE pipeline_stages SET canonical_stage = 'closed_won'
        WHERE ghl_stage_id = 'stage_won'`,
    );

    await mod.importPipelineStages(client());

    const won = (await stageRows()).find((r) => r.ghl_stage_id === "stage_won");
    expect(won?.canonical_stage).toBe("closed_won");
  });

  it("refreshes a renamed or reordered stage", async () => {
    ghlClient.getPipelines.mockResolvedValue(pipelines);
    await mod.importPipelineStages(client());

    ghlClient.getPipelines.mockResolvedValue([
      {
        id: "pipe_1",
        name: "Renamed Pipeline",
        stages: [{ id: "stage_new", name: "Fresh Lead", position: 7 }],
      },
    ]);
    await mod.importPipelineStages(client());

    const row = (await stageRows()).find((r) => r.ghl_stage_id === "stage_new");
    expect(row).toMatchObject({
      ghl_stage_name: "Fresh Lead",
      ghl_pipeline_name: "Renamed Pipeline",
      display_order: 7,
    });
  });

  it("clears the discovered-from-webhook flag once GHL confirms the stage", async () => {
    /*
     * A stage first seen in an incoming webhook is recorded with that flag so
     * the operator is prompted to map it. Once it appears in GHL's own pipeline
     * list it is no longer a surprise, and leaving the flag set keeps an
     * already-handled prompt on screen forever.
     */
    await run(
      `INSERT INTO pipeline_stages
         (client_id, ghl_pipeline_id, ghl_stage_id, discovered_from_webhook)
       VALUES ('${CLIENT_A}', 'pipe_1', 'stage_new', true)`,
    );
    ghlClient.getPipelines.mockResolvedValue(pipelines);
    await mod.importPipelineStages(client());

    const row = (await stageRows()).find((r) => r.ghl_stage_id === "stage_new");
    expect(row?.discovered_from_webhook).toBe(false);
  });

  it("refuses a client with no GHL location rather than importing nothing", async () => {
    // Silently importing zero stages would look like a pipeline with no stages,
    // which is a very different problem from a missing connection.
    await expect(
      mod.importPipelineStages({ id: CLIENT_A, ghlLocationId: null } as never),
    ).rejects.toThrow(/location/i);
  });
});

/* ------------------------------------------------------------------ *
 * Creating
 * ------------------------------------------------------------------ */

describe("createClient", () => {
  it("stores the GHL token encrypted, never in the clear", async () => {
    const row = await mod.createClient({
      agencyId: AGENCY_A,
      name: "Fresh Client",
      timezone: "America/New_York",
      ghlToken: "pit-secret-value",
    });
    expect(row.ghlTokenEncrypted).not.toBeNull();
    expect(row.ghlTokenEncrypted).not.toContain("pit-secret-value");
  });

  it("gives every client its own webhook token", async () => {
    /*
     * The token IS the tenant routing and the shared secret both — workflow
     * webhooks may carry no signature header at all. Two clients sharing one
     * would cross-post another tenant's leads into this client's ledger.
     */
    const a = await mod.createClient({
      agencyId: AGENCY_A,
      name: "One",
      timezone: "UTC",
    });
    const b = await mod.createClient({
      agencyId: AGENCY_A,
      name: "Two",
      timezone: "UTC",
    });
    expect(a.webhookToken).toBeTruthy();
    expect(a.webhookToken).not.toBe(b.webhookToken);
    expect(a.webhookToken).toHaveLength(32);
  });

  it("belongs to the agency it was created under", async () => {
    const row = await mod.createClient({
      agencyId: AGENCY_B,
      name: "Theirs",
      timezone: "UTC",
    });
    expect(row.agencyId).toBe(AGENCY_B);
  });
});

/* ------------------------------------------------------------------ *
 * Scoped reads
 * ------------------------------------------------------------------ */

describe("scoped reads", () => {
  it("returns this agency's client", async () => {
    const row = await mod.getClientForSession(session(), "acme-medical");
    expect(row?.id).toBe(CLIENT_A);
  });

  it("🔴 answers null — not a row — for another agency's client", async () => {
    /*
     * Slugs are derived from business names and are therefore guessable. The
     * whole tenancy boundary is this returning null.
     */
    const row = await mod.getClientForSession(session(), "rival-client");
    expect(row).toBeNull();
  });

  it("🔴 is indistinguishable from 'no such client'", async () => {
    /*
     * A handler that could tell "someone else's" from "does not exist" is an
     * existence oracle: walk slugs and it enumerates the platform's customer
     * list. Both answers must be the same value, so callers cannot accidentally
     * answer 403 for one and 404 for the other.
     */
    expect(await mod.getClientForSession(session(), "rival-client")).toBeNull();
    expect(await mod.getClientForSession(session(), "no-such-client")).toBeNull();
  });

  it("refuses an anonymous caller", async () => {
    expect(await mod.getClientForSession(null, "acme-medical")).toBeNull();
    expect(await mod.getClientByIdForSession(null, CLIENT_A)).toBeNull();
    expect(await mod.listClientsForSession(null)).toEqual([]);
  });

  it("applies the same rule to lookup by id", async () => {
    // Uuids are not guessable, but "not guessable" is not an access control —
    // an id reaches a handler from a URL, a webhook body, or a stale bookmark.
    expect((await mod.getClientByIdForSession(session(), CLIENT_A))?.id).toBe(
      CLIENT_A,
    );
    expect(await mod.getClientByIdForSession(session(), CLIENT_B)).toBeNull();
  });

  it("lists only this agency's clients", async () => {
    const rows = await mod.listClientsForSession(session());
    expect(rows.map((r) => r.slug)).toEqual(["acme-medical"]);
  });

  it("🔴 lets a platform role read across tenants, and an agency never", async () => {
    /*
     * Tier and tenancy are separate questions and this is where they meet.
     * `superadmin` is cross-tenant by design; `agency` is an OPERATOR role that
     * is still confined to its own tenant. Conflating the two — the natural
     * mistake when adding a role — hands one customer another's numbers.
     */
    const all = await mod.listClientsForSession(session({ role: "superadmin" }));
    expect(all.map((r) => r.slug).sort()).toEqual(["acme-medical", "rival-client"]);

    const own = await mod.listClientsForSession(session({ role: "agency" }));
    expect(own.map((r) => r.slug)).toEqual(["acme-medical"]);
  });

  it("🔴 shows a client-role login only the clients it was granted", async () => {
    // Same agency, so the tenant filter passes them both — the slug grant is
    // the only thing narrowing this, which is exactly why it is asserted.
    await run(`UPDATE clients SET agency_id = '${AGENCY_A}' WHERE id = '${CLIENT_B}'`);
    const rows = await mod.listClientsForSession(
      session({ role: "client", slugs: ["acme-medical"] }),
    );
    expect(rows.map((r) => r.slug)).toEqual(["acme-medical"]);
  });

  it("shows a client-role login with no grants nothing at all", async () => {
    const rows = await mod.listClientsForSession(session({ role: "client" }));
    expect(rows).toEqual([]);
  });
});
