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
 * The webhook receiver's ledger writer, against a real Postgres.
 *
 * ── Why this file is the one that most needed writing ─────────────────
 *
 * `stage_transitions` is the only data in this application that cannot be
 * rebuilt. GHL has no stage-history API — verified against both published
 * OpenAPI specs — so a transition we fail to record, record twice, or record
 * backwards is not a bug that can be fixed later by re-syncing. It is a
 * permanent corruption of every funnel count, every conversion rate and every
 * cost-per-stage that reads through it, for that date, forever.
 *
 * `processWebhookEvent` is what writes that ledger, and it had NO test. Its
 * three hardest properties are all properties of a database rather than of a
 * function — a unique index collapsing a retry, a row lock serialising two
 * concurrent deliveries, an ordering guard comparing against stored state — and
 * none of them are visible to a typechecker.
 *
 * ── What is faked, and what deliberately is not ───────────────────────
 *
 * The GHL REST client is faked: it is the network. Everything below it is real
 * Postgres — real unique indexes, real transactions, real FOR UPDATE, real
 * COALESCE-on-conflict. The bugs this is looking for live in exactly that
 * layer, so stubbing it would leave the test asserting its own mock.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

/** The token is a real encrypted blob in production; here it just has to be
 *  non-null so `getGhlClientAsync` hands back a client at all. */
vi.mock("@/lib/crypto", () => ({
  decryptNullable: (v: string | null) => v,
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
}));

/** The fake REST client. Tests set `remote.opportunity` / `remote.contact`. */
const remote: {
  opportunity: Record<string, unknown> | null;
  contact: Record<string, unknown> | null;
  throwOnOpportunity: boolean;
  opportunityCalls: number;
  contactCalls: number;
} = {
  opportunity: null,
  contact: null,
  throwOnOpportunity: false,
  opportunityCalls: 0,
  contactCalls: 0,
};

vi.mock("./client", () => ({
  GhlClient: class {
    async getOpportunity(id: string) {
      remote.opportunityCalls++;
      if (remote.throwOnOpportunity) throw new Error("GHL 502");
      return remote.opportunity ? { id, ...remote.opportunity } : null;
    }
    async getContact(id: string) {
      remote.contactCalls++;
      return remote.contact ? { id, ...remote.contact } : null;
    }
  },
}));

let mod: typeof import("./process");

const OPP = "opp0000000000000001";
const CONTACT = "cnt0000000000000001";
/** GHL stage ids are UUIDs while its other ids are 20-char base62. */
const STAGE_NEW = "aaaaaaaa-0000-4000-8000-000000000001";
const STAGE_BOOKED = "aaaaaaaa-0000-4000-8000-000000000002";
const STAGE_SHOWED = "aaaaaaaa-0000-4000-8000-000000000003";
const PIPELINE = "pip0000000000000001";

const client = (id = CLIENT_A, over: Partial<Client> = {}): Client =>
  ({
    id,
    name: "Parfaire",
    slug: "parfaire",
    timezone: "America/Los_Angeles",
    ghlAuthMethod: "pit",
    ghlTokenEncrypted: "token",
    ...over,
  }) as Client;

/** A workflow-shaped opportunity webhook. */
const payload = (over: Record<string, unknown> = {}) => ({
  type: "OpportunityStageUpdate",
  id: OPP,
  contactId: CONTACT,
  pipelineId: PIPELINE,
  pipelineStageId: STAGE_BOOKED,
  status: "open",
  ...over,
});

/** Raw `execute` hands timestamps back as strings; normalise for comparison. */
const iso = (v: unknown) => new Date(v as string).toISOString();
const ms = (v: unknown) => new Date(v as string).getTime();

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

/** A webhook_events row to hang the processed transition off. */
async function newEvent(clientId = CLIENT_A): Promise<string> {
  const r = await run(
    `INSERT INTO webhook_events (client_id, payload) VALUES ('${clientId}', '{}'::jsonb) RETURNING id`,
  );
  return r.rows[0].id as string;
}

const transitions = async () =>
  (
    await run(
      `SELECT from_canonical, to_canonical,
              from_stage_ghl_id, to_stage_ghl_id,
              from_stage_id::text AS from_stage_id, to_stage_id::text AS to_stage_id,
              changed_at, dedupe_key, source
         FROM stage_transitions ORDER BY changed_at, dedupe_key`,
    )
  ).rows;

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./process");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(
    `TRUNCATE stage_transitions, opportunities, pipeline_stages, contacts,
              webhook_events, clients RESTART IDENTITY CASCADE`,
  );
  remote.opportunity = null;
  remote.contact = null;
  remote.throwOnOpportunity = false;
  remote.opportunityCalls = 0;
  remote.contactCalls = 0;

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
      [STAGE_SHOWED, "showed"],
    ] as const) {
      await run(
        `INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, canonical_stage)
         VALUES ('${id}', '${PIPELINE}', '${stage}', '${canonical}')`,
      );
    }
  }
});

describe("recording a transition", () => {
  it("writes the ledger row a first delivery earns", async () => {
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z", status: "open" };
    const res = await mod.processWebhookEvent(await newEvent(), client(), payload());

    expect(res).toMatchObject({ status: "processed", transitionCreated: true });
    const rows = await transitions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_canonical: null,
      to_canonical: "appointment_booked",
      to_stage_ghl_id: STAGE_BOOKED,
      source: "webhook",
    });
    expect(iso(rows[0].changed_at)).toBe("2026-08-10T18:00:00.000Z");
  });

  it("derives from→to by diffing against stored state", async () => {
    /*
     * The whole reason a database is mandatory here. The payload carries no
     * previous stage, so `from` exists only because we stored where the
     * opportunity was last time.
     */
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    await mod.processWebhookEvent(
      await newEvent(),
      client(),
      payload({ pipelineStageId: STAGE_NEW }),
    );

    remote.opportunity = { lastStageChangeAt: "2026-08-12T18:00:00Z" };
    await mod.processWebhookEvent(await newEvent(), client(), payload());

    const rows = await transitions();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      from_canonical: "new_lead",
      to_canonical: "appointment_booked",
      from_stage_ghl_id: STAGE_NEW,
      to_stage_ghl_id: STAGE_BOOKED,
    });

    /*
     * And the FOREIGN KEYS, not just their canonical mirrors. `from_canonical`
     * is copied off the resolved row, so it stays right even if the id column
     * is wrong — which means asserting only the canonicals leaves a transition
     * that points at the wrong stage row indistinguishable from a correct one.
     * Anything joining stage_transitions back to pipeline_stages reads these.
     */
    const ids = await run(
      `SELECT id::text AS id, ghl_stage_id FROM pipeline_stages WHERE client_id = '${CLIENT_A}'`,
    );
    const byGhlId = new Map(ids.rows.map((r) => [r.ghl_stage_id, r.id]));
    expect(rows[1].from_stage_id).toBe(byGhlId.get(STAGE_NEW));
    expect(rows[1].to_stage_id).toBe(byGhlId.get(STAGE_BOOKED));
    expect(rows[0].from_stage_id).toBeNull();
  });

  it("🔴 prefers lastStageChangeAt over the opportunity's creation date", async () => {
    /*
     * `dateAdded` is when the LEAD appeared, not when it moved. Using it would
     * backdate every transition to the day the lead was created and silently
     * relocate appointments into the wrong month.
     */
    remote.opportunity = { lastStageChangeAt: "2026-08-12T18:00:00Z" };
    await mod.processWebhookEvent(
      await newEvent(),
      client(),
      payload({ dateAdded: "2026-01-05T00:00:00Z", timestamp: "2026-08-12T17:59:00Z" }),
    );
    const rows = await transitions();
    expect(iso(rows[0].changed_at)).toBe("2026-08-12T18:00:00.000Z");
  });

  it("falls back to the envelope timestamp when the REST read fails", async () => {
    // Losing precision is recoverable; losing the transition is not.
    remote.throwOnOpportunity = true;
    const res = await mod.processWebhookEvent(
      await newEvent(),
      client(),
      payload({ timestamp: "2026-08-12T17:59:00Z" }),
    );
    expect(res.transitionCreated).toBe(true);
    const rows = await transitions();
    expect(iso(rows[0].changed_at)).toBe("2026-08-12T17:59:00.000Z");
  });

  it("appends nothing when only the name or value moved", async () => {
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    await mod.processWebhookEvent(await newEvent(), client(), payload());

    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z", name: "Renamed" };
    const res = await mod.processWebhookEvent(
      await newEvent(),
      client(),
      payload({ monetaryValue: 4200 }),
    );

    expect(res).toMatchObject({ transitionCreated: false, reason: "no stage change" });
    expect(await transitions()).toHaveLength(1);
    const opp = await run(`SELECT name, monetary_value FROM opportunities`);
    expect(opp.rows[0]).toMatchObject({ name: "Renamed", monetary_value: "4200.00" });
  });
});

describe("at-least-once delivery", () => {
  /*
   * ── What this harness can and cannot reach ──────────────────────────
   *
   * There are TWO defences against a redelivered event inflating the funnel,
   * and they cover different cases:
   *
   *  1. the stage-unchanged short-circuit, which catches every retry that
   *     arrives AFTER the first one finished, and
   *  2. the unique `dedupe_key`, which catches the retry that arrives WHILE the
   *     first is still in flight — the only case the short-circuit cannot see,
   *     because at that moment nothing has been stored yet.
   *
   * 🔴 PGlite runs on a single connection and serialises transactions — probed,
   * not assumed: three overlapping `db.transaction()` calls each ran to
   * completion before the next began, across an intervening await. So (2) is
   * genuinely unreachable through `processWebhookEvent` here, and so is the
   * FOR UPDATE row lock that guards the same window. Deleting either passes
   * every test that drives the function.
   *
   * Rather than let two tests claim coverage they do not have, the constraint
   * those defences rest on is asserted directly against the database below, and
   * the tests that drive the function claim only the short-circuit.
   */

  it("🔴 a retry after the first landed appends nothing", async () => {
    /*
     * GHL retries ~12x with jitter. Every retry that arrives once the first has
     * been recorded finds the opportunity already sitting on the incoming
     * stage, and stops there — the cheap defence, and the one that fires in the
     * overwhelming majority of real redeliveries.
     */
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    const first = await mod.processWebhookEvent(await newEvent(), client(), payload());
    const retry = await mod.processWebhookEvent(await newEvent(), client(), payload());

    expect(first.transitionCreated).toBe(true);
    // Reported as NOT created — the caller must be able to tell a retry from a move.
    expect(retry).toMatchObject({ transitionCreated: false, reason: "no stage change" });
    expect(await transitions()).toHaveLength(1);
  });

  it("twelve deliveries of one event yield one opportunity and one transition", async () => {
    // Drives the whole path twelve times over. It does NOT prove the row lock
    // (see the note above) — it proves that nothing else in the path double
    // -writes, which is the part that is reachable.
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    const events = await Promise.all(Array.from({ length: 12 }, () => newEvent()));
    const results = await Promise.all(
      events.map((e) => mod.processWebhookEvent(e, client(), payload())),
    );

    expect(results.filter((r) => r.transitionCreated)).toHaveLength(1);
    expect(await transitions()).toHaveLength(1);
    const opps = await run(`SELECT count(*)::int AS n FROM opportunities`);
    expect(opps.rows[0].n).toBe(1);
  });

  it("🔴 the ledger refuses a duplicate dedupe key at the database level", async () => {
    /*
     * The guarantee the concurrent case rests on, asserted where it actually
     * lives. If this index is ever dropped by a migration, two in-flight
     * deliveries stop collapsing and every funnel count downstream doubles for
     * that event — so the constraint is worth a test of its own even though no
     * single-connection harness can drive it through the function.
     */
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    await mod.processWebhookEvent(await newEvent(), client(), payload());
    const [row] = (
      await run(`SELECT opportunity_id::text AS o, client_id::text AS c, dedupe_key FROM stage_transitions`)
    ).rows;

    await expect(
      run(
        `INSERT INTO stage_transitions
           (client_id, opportunity_id, to_stage_ghl_id, to_canonical, changed_at, dedupe_key)
         VALUES ('${row.c}', '${row.o}', '${STAGE_BOOKED}', 'appointment_booked',
                 '2026-08-10T18:00:00Z', '${row.dedupe_key}')`,
      ),
    ).rejects.toThrow();
    expect(await transitions()).toHaveLength(1);
  });

  it("🔴 the key carries the change time, so a genuine re-entry is not collapsed", async () => {
    /*
     * The other half of the constraint's correctness. A lead that books, no
     * -shows, and books again HAS entered appointment_booked twice, and both
     * belong in the ledger. A key of just (opportunity, stage) would silently
     * swallow the second — under-counting appointments for a client whose leads
     * legitimately bounce, which is most of them.
     */
    for (const [stage, at] of [
      [STAGE_BOOKED, "2026-08-10T18:00:00Z"],
      [STAGE_NEW, "2026-08-12T18:00:00Z"],
      [STAGE_BOOKED, "2026-08-14T18:00:00Z"],
    ] as const) {
      remote.opportunity = { lastStageChangeAt: at };
      await mod.processWebhookEvent(
        await newEvent(),
        client(),
        payload({ pipelineStageId: stage }),
      );
    }

    const rows = await transitions();
    expect(rows.map((r) => r.to_canonical)).toEqual([
      "appointment_booked",
      "new_lead",
      "appointment_booked",
    ]);
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(3);
  });

  it("🔴 ignores a reordered event rather than walking the stage backwards", async () => {
    /*
     * Delivery is unordered. A replay of an old move arrives carrying a
     * `changedAt` no newer than what we stored; acting on it would drag
     * `current_stage` backwards AND append a phantom reverse transition —
     * counting an appointment that never un-happened.
     */
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    await mod.processWebhookEvent(
      await newEvent(),
      client(),
      payload({ pipelineStageId: STAGE_NEW }),
    );
    remote.opportunity = { lastStageChangeAt: "2026-08-14T18:00:00Z" };
    await mod.processWebhookEvent(
      await newEvent(),
      client(),
      payload({ pipelineStageId: STAGE_SHOWED }),
    );

    // The stale one, arriving last, describing the earlier move.
    remote.opportunity = { lastStageChangeAt: "2026-08-12T18:00:00Z" };
    const late = await mod.processWebhookEvent(await newEvent(), client(), payload());

    expect(late).toMatchObject({
      transitionCreated: false,
      reason: "out-of-order stage event ignored",
    });
    const rows = await transitions();
    expect(rows.map((r) => r.to_canonical)).toEqual(["new_lead", "showed"]);
    const opp = await run(`SELECT current_stage_ghl_id, last_stage_change_at FROM opportunities`);
    expect(opp.rows[0].current_stage_ghl_id).toBe(STAGE_SHOWED);
  });
});

describe("a stage we have never seen", () => {
  it("🔴 records the transition instead of dropping the event", async () => {
    /*
     * A client adding a stage in GHL after onboarding must not cost us history.
     * The stage is recorded unmapped for the operator to classify, and the raw
     * GHL id is kept so the transition can be reclassified later.
     */
    const UNKNOWN = "aaaaaaaa-0000-4000-8000-00000000ffff";
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    const res = await mod.processWebhookEvent(
      await newEvent(),
      client(),
      payload({ pipelineStageId: UNKNOWN }),
    );

    expect(res.transitionCreated).toBe(true);
    const rows = await transitions();
    expect(rows[0]).toMatchObject({ to_canonical: null, to_stage_ghl_id: UNKNOWN });

    const stage = await run(
      `SELECT canonical_stage, discovered_from_webhook, ghl_pipeline_id
         FROM pipeline_stages WHERE ghl_stage_id = '${UNKNOWN}'`,
    );
    expect(stage.rows[0]).toMatchObject({
      canonical_stage: null,
      discovered_from_webhook: true,
      ghl_pipeline_id: PIPELINE,
    });
  });

  it("creates the placeholder once across concurrent first sightings", async () => {
    const UNKNOWN = "aaaaaaaa-0000-4000-8000-00000000fffe";
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    const events = await Promise.all(Array.from({ length: 6 }, () => newEvent()));
    await Promise.all(
      events.map((e) =>
        mod.processWebhookEvent(e, client(), payload({ pipelineStageId: UNKNOWN })),
      ),
    );
    const stage = await run(
      `SELECT count(*)::int AS n FROM pipeline_stages WHERE ghl_stage_id = '${UNKNOWN}'`,
    );
    expect(stage.rows[0].n).toBe(1);
  });
});

describe("contacts and attribution", () => {
  it("stores the campaign id the webhook itself never carries", async () => {
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    remote.contact = {
      firstName: "Dana",
      email: "dana@example.com",
      dateAdded: "2026-08-09T12:00:00Z",
      tags: ["Facebook-Lead", " VIP "],
      attributionSource: {
        campaignId: "120200000000000001",
        adId: "120200000000000009",
        utmSource: "facebook",
        url: "https://x.test/?utm_source=facebook",
      },
    };
    await mod.processWebhookEvent(await newEvent(), client(), payload());

    const c = await run(
      `SELECT first_name, email, meta_campaign_id, meta_ad_id, tags,
              attribution_fetched_at IS NOT NULL AS fetched
         FROM contacts`,
    );
    expect(c.rows[0]).toMatchObject({
      first_name: "Dana",
      email: "dana@example.com",
      meta_campaign_id: "120200000000000001",
      fetched: true,
    });
    // Lowercased and trimmed, so the paid-lead tag match needs no LOWER().
    expect(c.rows[0].tags).toEqual(["facebook-lead", "vip"]);
  });

  it("🔴 a later re-fetch without attribution never nulls what we captured", async () => {
    /*
     * The COALESCE-on-conflict rule. Overwriting a campaign id with a null
     * would drop the lead out of paid CPL entirely, and nothing would report an
     * error — the lead would simply stop being a Facebook lead.
     */
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    remote.contact = {
      firstName: "Dana",
      // `utmSource` is load-bearing, not decoration: a bare campaign id with no
      // platform signal is deliberately assigned to NEITHER column, because
      // guessing would move the lead's whole pipeline value to the wrong
      // platform's cost-per-lead.
      attributionSource: {
        campaignId: "120200000000000001",
        utmSource: "facebook",
        facebookLeadId: "998877665544332",
      },
    };
    await mod.processWebhookEvent(await newEvent(), client(), payload());

    // A tag event forces a re-fetch inside the 24h window; this one comes back
    // bare, as GHL's contact reads sometimes do.
    remote.contact = { tags: ["facebook-lead"] };
    await mod.processWebhookEvent(await newEvent(), client(), {
      type: "ContactTagUpdate",
      id: CONTACT,
    });

    const c = await run(
      `SELECT first_name, meta_campaign_id, facebook_lead_id, tags FROM contacts`,
    );
    expect(c.rows[0]).toMatchObject({
      first_name: "Dana",
      meta_campaign_id: "120200000000000001",
      /*
       * 🔴 The one that matters most. An Instant Form lead has NO UTM path, so
       * this id is its only route back to a campaign — nulling it does not
       * degrade its attribution, it ends it, permanently and silently.
       */
      facebook_lead_id: "998877665544332",
    });
    expect(c.rows[0].tags).toEqual(["facebook-lead"]);
  });

  it("does not re-fetch attribution on every delivery", async () => {
    // Once a day per contact; a retry storm must not become a rate-limit storm.
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    remote.contact = { firstName: "Dana" };
    await mod.processWebhookEvent(await newEvent(), client(), payload());
    const after = remote.contactCalls;

    await mod.processWebhookEvent(
      await newEvent(),
      client(),
      payload({ pipelineStageId: STAGE_SHOWED }),
    );
    expect(remote.contactCalls).toBe(after);
  });

  it("records a contact-only event and reports why it made no transition", async () => {
    remote.contact = { firstName: "Dana" };
    const res = await mod.processWebhookEvent(await newEvent(), client(), {
      type: "ContactCreate",
      id: CONTACT,
    });
    expect(res).toMatchObject({ status: "processed", transitionCreated: false });
    const c = await run(`SELECT ghl_contact_id FROM contacts`);
    expect(c.rows[0].ghl_contact_id).toBe(CONTACT);
    expect(await transitions()).toHaveLength(0);
  });

  it("ignores a payload carrying neither id", async () => {
    const res = await mod.processWebhookEvent(await newEvent(), client(), { type: "Noise" });
    expect(res.status).toBe("ignored");
    expect(remote.contactCalls).toBe(0);
  });

  it("ignores an opportunity event with no stage id", async () => {
    const res = await mod.processWebhookEvent(
      await newEvent(),
      client(),
      payload({ pipelineStageId: undefined }),
    );
    expect(res).toMatchObject({ status: "ignored" });
    expect(await transitions()).toHaveLength(0);
  });
});

describe("tenancy", () => {
  it("🔴 two clients may carry the same GHL opportunity id", async () => {
    /*
     * GHL ids are unique per sub-account, not globally, and an agency running
     * one dashboard over many sub-accounts WILL eventually see a collision.
     * Keying on the id alone would merge two clients' pipelines into one.
     */
    remote.opportunity = { lastStageChangeAt: "2026-08-10T18:00:00Z" };
    await mod.processWebhookEvent(await newEvent(), client(CLIENT_A), payload());
    await mod.processWebhookEvent(
      await newEvent(CLIENT_B),
      client(CLIENT_B),
      payload(),
    );

    const rows = await run(
      `SELECT client_id::text AS client_id FROM stage_transitions ORDER BY client_id`,
    );
    expect(rows.rows.map((r) => r.client_id)).toEqual([CLIENT_A, CLIENT_B]);
    const opps = await run(`SELECT count(*)::int AS n FROM opportunities`);
    expect(opps.rows[0].n).toBe(2);
  });
});

describe("liveness markers", () => {
  it("🔴 firstWebhookAt is set once and never moves", async () => {
    // It is the evidence the pipe has genuinely worked — the thing the
    // onboarding wizard polls for. Overwriting it would erase that proof.
    /*
     * Seeded to a date far in the past on purpose. Two `touch` calls in the
     * same test run land in the same millisecond, so comparing them to each
     * other passes just as well for an implementation that overwrites the
     * marker every time — which is the bug this test exists to catch.
     */
    const FIRST = "2026-03-01T09:15:00.000Z";
    await run(
      `UPDATE clients SET first_webhook_at = '${FIRST}', last_webhook_at = '${FIRST}'
         WHERE id = '${CLIENT_A}'`,
    );

    await mod.touchClientWebhookMarkers(CLIENT_A);
    const after = await run(
      `SELECT first_webhook_at, last_webhook_at FROM clients WHERE id = '${CLIENT_A}'`,
    );

    expect(iso(after.rows[0].first_webhook_at)).toBe(FIRST);
    // …while the liveness marker, which SHOULD move, did.
    expect(ms(after.rows[0].last_webhook_at)).toBeGreaterThan(Date.parse(FIRST));
    // And it did not reach across the tenant boundary.
    const other = await run(
      `SELECT first_webhook_at FROM clients WHERE id = '${CLIENT_B}'`,
    );
    expect(other.rows[0].first_webhook_at).toBeNull();
  });

  it("stamps the raw event row with its outcome", async () => {
    const id = await newEvent();
    await mod.finalizeEvent(id, {
      status: "processed",
      transitionCreated: false,
      reason: "no stage change",
    });
    const e = await run(
      `SELECT status, error, processed_at IS NOT NULL AS done FROM webhook_events WHERE id = '${id}'`,
    );
    expect(e.rows[0]).toMatchObject({
      status: "processed",
      error: "no stage change",
      done: true,
    });
  });
});

describe("message touches", () => {
  beforeEach(async () => {
    await run(
      `INSERT INTO contacts (client_id, ghl_contact_id) VALUES ('${CLIENT_A}', '${CONTACT}')`,
    );
  });

  it("🔴 only the FIRST outbound call anchors speed-to-lead", async () => {
    const r1 = await mod.recordMessageTouch(CLIENT_A, {
      contactId: CONTACT,
      messageType: "call",
      direction: "outbound",
      dateAdded: "2026-08-10T18:00:00Z",
    });
    await mod.recordMessageTouch(CLIENT_A, {
      contactId: CONTACT,
      messageType: "CALL",
      direction: "outbound",
      dateAdded: "2026-08-11T18:00:00Z",
    });

    expect(r1).toEqual({ isCall: true, contactMatched: true });
    const c = await run(`SELECT first_call_at, first_touch_at FROM contacts`);
    expect(iso(c.rows[0].first_call_at)).toBe("2026-08-10T18:00:00.000Z");
  });

  it("an inbound reply is a touch but not a call", async () => {
    const r = await mod.recordMessageTouch(CLIENT_A, {
      contactId: CONTACT,
      messageType: "CALL",
      direction: "inbound",
      dateAdded: "2026-08-10T18:00:00Z",
    });
    expect(r.isCall).toBe(false);
    const c = await run(`SELECT first_call_at, first_touch_at FROM contacts`);
    expect(c.rows[0].first_call_at).toBeNull();
    expect(iso(c.rows[0].first_touch_at)).toBe("2026-08-10T18:00:00.000Z");
  });

  it("reports an unmatched contact rather than silently doing nothing", async () => {
    const r = await mod.recordMessageTouch(CLIENT_B, {
      contactId: CONTACT,
      messageType: "SMS",
      direction: "outbound",
    });
    expect(r).toEqual({ isCall: false, contactMatched: false });
  });
});
