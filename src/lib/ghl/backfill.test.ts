import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  CLIENT_A,
  CLIENT_B,
  type TestDb,
} from "@/lib/metrics/__testdb__/harness";
import type { Client } from "@/db/schema";

/**
 * The day-0 backfill snapshot, against a real Postgres.
 *
 * ── What a backfill can and cannot recover ────────────────────────────
 *
 * GHL exposes no stage-transition history, so for each opportunity exactly two
 * facts are knowable: the stage it is in now, and when it last moved. The
 * backfill writes ONE synthetic arrival per opportunity from those, marked
 * `source='backfill_snapshot'` so it stays distinguishable from observed
 * history. It establishes the floor of what is knowable and nothing more.
 *
 * ── Why it needed testing more than its docstring suggests ────────────
 *
 * The header says "run this once, at onboarding". Nothing enforces that, and it
 * is wired to an operator-pressable button on the sync route that never goes
 * away. So "what happens on the second press, months later, with webhooks
 * live" is a real question about the second writer to the irreplaceable table —
 * and it was never asked.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

type Remote = Record<string, unknown>;
const remote: { pages: Remote[][]; throws: boolean } = { pages: [], throws: false };

vi.mock("./process", () => ({
  getGhlClientAsync: async () => ({
    async *iterateOpportunities() {
      if (remote.throws) throw new Error("GHL 500");
      for (const page of remote.pages) yield page;
    },
  }),
}));

let mod: typeof import("./backfill");

const STAGE_NEW = "aaaaaaaa-0000-4000-8000-000000000001";
const STAGE_BOOKED = "aaaaaaaa-0000-4000-8000-000000000002";

const client = (id = CLIENT_A): Client =>
  ({
    id,
    name: "Parfaire",
    slug: "parfaire",
    timezone: "America/Los_Angeles",
    ghlLocationId: `loc-${id.slice(0, 4)}`,
    ghlAuthMethod: "pit",
    ghlTokenEncrypted: "token",
  }) as Client;

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const transitions = async () =>
  (
    await run(
      `SELECT source, to_canonical, from_canonical, from_stage_ghl_id, to_stage_ghl_id,
              changed_at, dedupe_key
         FROM stage_transitions ORDER BY changed_at, dedupe_key`,
    )
  ).rows;

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./backfill");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(
    `TRUNCATE stage_transitions, opportunities, pipeline_stages, contacts,
              sync_runs, clients RESTART IDENTITY CASCADE`,
  );
  remote.pages = [];
  remote.throws = false;
  for (const [id, slug] of [
    [CLIENT_A, "parfaire"],
    [CLIENT_B, "other"],
  ] as const) {
    await run(
      `INSERT INTO clients (id, name, slug) VALUES ('${id}', '${slug}', '${slug}')`,
    );
    for (const [stage, canonical] of [
      [STAGE_NEW, "new_lead"],
      [STAGE_BOOKED, "appointment_booked"],
    ] as const) {
      await run(
        `INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, canonical_stage)
         VALUES ('${id}', 'pip', '${stage}', '${canonical}')`,
      );
    }
  }
});

describe("the snapshot it writes", () => {
  it("writes one synthetic arrival per opportunity, marked as such", async () => {
    remote.pages = [
      [
        {
          id: "o1",
          contactId: "c1",
          pipelineStageId: STAGE_BOOKED,
          lastStageChangeAt: "2026-07-10T12:00:00Z",
          status: "open",
        },
        {
          id: "o2",
          contactId: "c2",
          pipelineStageId: STAGE_NEW,
          lastStageChangeAt: "2026-07-11T12:00:00Z",
        },
      ],
    ];
    const res = await mod.backfillClientSnapshot(client());

    expect(res).toEqual({ opportunities: 2, transitions: 2 });
    const rows = await transitions();
    expect(rows.map((r) => r.source)).toEqual([
      "backfill_snapshot",
      "backfill_snapshot",
    ]);
    expect(rows.map((r) => r.to_canonical)).toEqual([
      "appointment_booked",
      "new_lead",
    ]);
  });

  it("🔴 never invents where a lead came from", async () => {
    /*
     * The one thing that would turn an honest floor into fabricated history.
     * We know the stage it is in; we do not know the stage before it, and a
     * guessed `from` would produce conversion rates for transitions that were
     * never observed.
     */
    remote.pages = [
      [{ id: "o1", pipelineStageId: STAGE_BOOKED, lastStageChangeAt: "2026-07-10T12:00:00Z" }],
    ];
    await mod.backfillClientSnapshot(client());
    const [row] = await transitions();
    expect(row.from_canonical).toBeNull();
    expect(row.from_stage_ghl_id).toBeNull();
  });

  it("re-running does not duplicate the ledger", async () => {
    remote.pages = [
      [{ id: "o1", pipelineStageId: STAGE_NEW, lastStageChangeAt: "2026-07-10T12:00:00Z" }],
    ];
    await mod.backfillClientSnapshot(client());
    const second = await mod.backfillClientSnapshot(client());

    expect(second.transitions).toBe(0);
    expect(await transitions()).toHaveLength(1);
  });

  it("records a failure on the sync run rather than swallowing it", async () => {
    remote.throws = true;
    await expect(mod.backfillClientSnapshot(client())).rejects.toThrow();
    const runs = await run(`SELECT status, error FROM sync_runs WHERE kind = 'ghl_backfill'`);
    expect(runs.rows[0]).toMatchObject({ status: "failed" });
    expect(String(runs.rows[0].error)).toContain("GHL 500");
  });

  it("does not write into another client's ledger", async () => {
    remote.pages = [
      [{ id: "o1", pipelineStageId: STAGE_NEW, lastStageChangeAt: "2026-07-10T12:00:00Z" }],
    ];
    await mod.backfillClientSnapshot(client(CLIENT_B));
    const rows = await run(
      `SELECT client_id::text AS c FROM stage_transitions`,
    );
    expect(rows.rows.map((r) => r.c)).toEqual([CLIENT_B]);
  });
});

describe("a second press of the button, months later", () => {
  /*
   * 🔴 The scenario the docstring assumes away. `ghl_backfill` is an operator
   * action on the sync route with no once-only guard, so this WILL happen — and
   * by then the webhook path has spent months carefully accumulating exactly
   * the fields a snapshot does not carry.
   */

  async function establishedByWebhooks() {
    const contact = (
      await run(
        `INSERT INTO contacts (client_id, ghl_contact_id, first_name, meta_campaign_id)
         VALUES ('${CLIENT_A}', 'c1', 'Dana', '120200000000000001') RETURNING id`,
      )
    ).rows[0].id;
    await run(
      `INSERT INTO opportunities
         (client_id, ghl_opportunity_id, contact_id, ghl_contact_id, name,
          monetary_value, ghl_created_at, current_stage_ghl_id, last_stage_change_at)
       VALUES ('${CLIENT_A}', 'o1', '${contact}', 'c1', 'Dana — Botox',
               4200, '2026-06-01T00:00:00Z', '${STAGE_BOOKED}', '2026-07-20T12:00:00Z')`,
    );
    return contact as string;
  }

  it("🔴 does not null the contact link a snapshot happens not to carry", async () => {
    /*
     * `contact_id` is what joins an opportunity to its attribution. Nulling it
     * drops the lead out of paid cost-per-lead entirely — and nothing errors,
     * so the only symptom is a CPL that quietly got worse.
     */
    const contact = await establishedByWebhooks();
    // GHL's opportunity search does not always carry the contact id.
    remote.pages = [
      [{ id: "o1", pipelineStageId: STAGE_BOOKED, lastStageChangeAt: "2026-07-20T12:00:00Z" }],
    ];
    await mod.backfillClientSnapshot(client());

    const opp = await run(
      `SELECT contact_id::text AS contact_id, ghl_contact_id FROM opportunities`,
    );
    expect(opp.rows[0].contact_id).toBe(contact);
    expect(opp.rows[0].ghl_contact_id).toBe("c1");
  });

  it("🔴 does not blank the name, value or creation date", async () => {
    await establishedByWebhooks();
    remote.pages = [
      [{ id: "o1", pipelineStageId: STAGE_BOOKED, lastStageChangeAt: "2026-07-20T12:00:00Z" }],
    ];
    await mod.backfillClientSnapshot(client());

    const opp = await run(
      `SELECT name, monetary_value, ghl_created_at FROM opportunities`,
    );
    expect(opp.rows[0]).toMatchObject({
      name: "Dana — Botox",
      monetary_value: "4200.00",
    });
    expect(opp.rows[0].ghl_created_at).not.toBeNull();
  });

  it("🔴 does not drag the stage pointer backwards", async () => {
    /*
     * The webhook path has an explicit ordering guard for exactly this: a
     * snapshot describing an older state must not move `current_stage` back,
     * because the NEXT webhook derives its `from` stage by diffing against
     * whatever we stored — so one stale write corrupts the transition after it
     * too, and that one is real history.
     */
    await establishedByWebhooks();
    remote.pages = [
      [{ id: "o1", pipelineStageId: STAGE_NEW, lastStageChangeAt: "2026-07-01T12:00:00Z" }],
    ];
    await mod.backfillClientSnapshot(client());

    const opp = await run(
      `SELECT current_stage_ghl_id, last_stage_change_at FROM opportunities`,
    );
    expect(opp.rows[0].current_stage_ghl_id).toBe(STAGE_BOOKED);
    expect(new Date(opp.rows[0].last_stage_change_at as string).toISOString()).toBe(
      "2026-07-20T12:00:00.000Z",
    );

    /*
     * And no ledger row either. The snapshot knows only the CURRENT stage, so a
     * response older than what we hold is out of date rather than describing an
     * extra arrival we had not heard about — writing it would invent an
     * arrival at new_lead that nothing ever observed, and the funnel would
     * count it.
     */
    expect(await transitions()).toHaveLength(0);
  });

  it("still advances state when the snapshot is genuinely newer", async () => {
    // The guard must not freeze the record — a backfill run before the webhook
    // was installed is the case this function exists for.
    await establishedByWebhooks();
    remote.pages = [
      [
        {
          id: "o1",
          pipelineStageId: STAGE_NEW,
          name: "Dana — Filler",
          lastStageChangeAt: "2026-08-01T12:00:00Z",
        },
      ],
    ];
    await mod.backfillClientSnapshot(client());

    const opp = await run(
      `SELECT current_stage_ghl_id, name FROM opportunities`,
    );
    expect(opp.rows[0]).toMatchObject({
      current_stage_ghl_id: STAGE_NEW,
      name: "Dana — Filler",
    });
  });
});

describe("reclassifying after a stage is mapped", () => {
  async function unmappedTransition(dedupe: string, from: string | null, to: string) {
    const opp = (
      await run(
        `INSERT INTO opportunities (client_id, ghl_opportunity_id)
         VALUES ('${CLIENT_A}', 'o-${dedupe}') RETURNING id`,
      )
    ).rows[0].id;
    await run(
      `INSERT INTO stage_transitions
         (client_id, opportunity_id, from_stage_ghl_id, to_stage_ghl_id,
          from_canonical, to_canonical, changed_at, dedupe_key, source)
       VALUES ('${CLIENT_A}', '${opp}', ${from ? `'${from}'` : "NULL"}, '${to}',
               NULL, NULL, '2026-07-10T12:00:00Z', '${dedupe}', 'webhook')`,
    );
  }

  it("🔴 fills in transitions recorded before the stage was known", async () => {
    /*
     * Until this runs, those transitions carry a null canonical and are
     * invisible to the funnel — the lead moved, we recorded it, and no report
     * counts it. This is the legitimate exception to append-only: it fills in a
     * derived label and never changes what happened or when.
     */
    const LATE = "aaaaaaaa-0000-4000-8000-0000000000ff";
    await unmappedTransition("t1", null, LATE);
    await run(
      `INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, canonical_stage)
       VALUES ('${CLIENT_A}', 'pip', '${LATE}', 'showed')`,
    );

    const n = await mod.reclassifyTransitions(CLIENT_A);
    expect(n).toBe(1);
    const rows = await transitions();
    expect(rows[0].to_canonical).toBe("showed");
  });

  it("🔴 labels the FROM side too, or drop-off is computed off a null", async () => {
    const LATE = "aaaaaaaa-0000-4000-8000-0000000000fe";
    await unmappedTransition("t2", LATE, STAGE_BOOKED);
    await run(
      `INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, canonical_stage)
       VALUES ('${CLIENT_A}', 'pip', '${LATE}', 'contacted')`,
    );

    await mod.reclassifyTransitions(CLIENT_A);
    const rows = await transitions();
    expect(rows[0].from_canonical).toBe("contacted");
  });

  it("never changes when a transition happened", async () => {
    await unmappedTransition("t3", null, STAGE_NEW);
    await mod.reclassifyTransitions(CLIENT_A);
    const rows = await transitions();
    expect(new Date(rows[0].changed_at as string).toISOString()).toBe(
      "2026-07-10T12:00:00.000Z",
    );
  });

  it("does not reach into another client's ledger", async () => {
    await unmappedTransition("t4", null, STAGE_NEW);
    const n = await mod.reclassifyTransitions(CLIENT_B);
    expect(n).toBe(0);
    const rows = await transitions();
    expect(rows[0].to_canonical).toBeNull();
  });

  it("leaves a still-unmapped stage alone", async () => {
    await unmappedTransition("t5", null, "aaaaaaaa-0000-4000-8000-0000000000fd");
    const n = await mod.reclassifyTransitions(CLIENT_A);
    expect(n).toBe(0);
  });
});
