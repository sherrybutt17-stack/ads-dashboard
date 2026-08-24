import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, CLIENT_A, type TestDb } from "@/lib/metrics/__testdb__/harness";
import type { Client } from "@/db/schema";

/**
 * The send path, against a real Postgres.
 *
 * Everything here is about the two things that cannot be tested in a pure
 * function: **the claim** — GHL retries a webhook about twelve times, and
 * read-then-write would put twelve identical pings in a channel — and the
 * per-client-timezone counting behind "3rd today".
 *
 * `fetch` is stubbed throughout, so no test can reach a real destination.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let alerts: typeof import("./send");
let posted: { url: string; body: unknown; init: Record<string, unknown> }[] = [];
let nextStatus = 200;

const TZ = "America/Los_Angeles";
const HOOK = "https://hooks.slack.com/services/T0/B0/xyz";

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??= "a".repeat(64);
  harness = await createTestDb();
  // `alerted_at` and `clients` now live in the harness itself, kept in step
  // with schema.ts by __testdb__/drift.test.ts. Patching them in here was how
  // they drifted out of it in the first place.
  alerts = await import("./send");

  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    posted.push({
      url,
      body: JSON.parse(init.body),
      init: init as unknown as Record<string, unknown>,
    });
    return { status: nextStatus } as Response;
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await harness?.close();
});

beforeEach(async () => {
  posted = [];
  nextStatus = 200;
  await harness.db.execute(sql.raw(`DELETE FROM contacts`));
});

const { encrypt } = await import("@/lib/crypto");

const client = (o: Partial<Client> = {}): Client =>
  ({
    id: CLIENT_A,
    name: "Parfaire",
    slug: "parfaire",
    timezone: TZ,
    paidLeadFilter: "either",
    paidLeadTag: "facebook-lead",
    alertsEnabled: true,
    alertWebhookEncrypted: encrypt(HOOK),
    ...o,
  }) as Client;

/** Insert a contact N minutes before `now`. */
async function seedLead(
  ghlId: string,
  minutesAgo: number,
  o: { campaign?: string | null; tags?: string[]; alerted?: boolean } = {},
) {
  const camp = o.campaign === undefined ? "'camp_1'" : o.campaign === null ? "NULL" : `'${o.campaign}'`;
  const tags = (o.tags ?? []).map((t) => `'${t}'`).join(",");
  await harness.db.execute(
    sql.raw(`
      INSERT INTO contacts (client_id, ghl_contact_id, first_name, last_name, phone, email,
                            meta_campaign_id, tags, ghl_created_at, alerted_at)
      VALUES ('${CLIENT_A}', '${ghlId}', 'Sarah', 'Mitchell', '+15550142', 's@x.com',
              ${camp}, ARRAY[${tags}]::text[],
              now() - interval '${minutesAgo} minutes',
              ${o.alerted ? "now()" : "NULL"})
    `),
  );
}

const alertedCount = async () => {
  const r = (await harness.db.execute(
    sql.raw(`SELECT COUNT(*)::int AS n FROM contacts WHERE alerted_at IS NOT NULL`),
  )) as unknown as { rows: { n: number }[] };
  return Number(r.rows[0].n);
};

/* ------------------------------------------------------------------ *
 * The claim
 * ------------------------------------------------------------------ */

describe("delivery is exactly once", () => {
  it("sends for a fresh paid lead", async () => {
    await seedLead("g1", 5);
    const r = await alerts.alertNewLead(client(), "g1");
    expect(r.sent).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe(HOOK);
  });

  it("🔴 sends once across twelve retried deliveries", async () => {
    /*
     * GHL redelivers a webhook about twelve times with jitter. A read-then-write
     * check would let several of them see a null `alerted_at` at once; the
     * claim is an UPDATE guarded on that null, so exactly one wins.
     */
    await seedLead("g1", 5);
    const c = client();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => alerts.alertNewLead(c, "g1")),
    );
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(posted).toHaveLength(1);
  });

  it("🔴 claims the row BEFORE the request, not after", async () => {
    /*
     * A request that times out may still have been delivered — a timeout says
     * nothing about what the far end did. Releasing the claim on failure would
     * turn every slow response into a duplicate ping, and this lead is on the
     * dashboard either way.
     */
    await seedLead("g1", 5);
    nextStatus = 500;
    const r = await alerts.alertNewLead(client(), "g1");
    expect(r.sent).toBe(false);
    expect(await alertedCount()).toBe(1);

    // A retry after the failure must stay silent.
    posted = [];
    nextStatus = 200;
    await alerts.alertNewLead(client(), "g1");
    expect(posted).toHaveLength(0);
  });

  it("does not send twice for a lead already alerted", async () => {
    await seedLead("g1", 5, { alerted: true });
    const r = await alerts.alertNewLead(client(), "g1");
    expect(r).toEqual({ sent: false, reason: "already_alerted" });
  });
});

/* ------------------------------------------------------------------ *
 * Who does not get one
 * ------------------------------------------------------------------ */

describe("leads that produce no alert", () => {
  it("🔴 stays silent for a backfilled contact", async () => {
    /*
     * The catastrophic case. Reconnecting a client re-upserts every contact
     * they have — sixteen hundred on this deployment — and each one reaches
     * this function. The age bound is the only thing between that and sixteen
     * hundred messages.
     */
    await seedLead("g1", 60 * 24 * 30);
    const r = await alerts.alertNewLead(client(), "g1");
    expect(r).toEqual({ sent: false, reason: "stale" });
    expect(posted).toHaveLength(0);
    // And it is NOT claimed, so a genuinely fresh event for it could still fire.
    expect(await alertedCount()).toBe(0);
  });

  it("stays silent for an unattributed lead", async () => {
    await seedLead("g1", 5, { campaign: null });
    expect((await alerts.alertNewLead(client(), "g1")).sent).toBe(false);
  });

  it("counts a tagged lead with no campaign id as paid", async () => {
    // Instant Form leads carry no UTMs at all; the tag is the only signal, and
    // they are exactly the leads worth interrupting somebody about.
    await seedLead("g1", 5, { campaign: null, tags: ["facebook-lead"] });
    expect((await alerts.alertNewLead(client(), "g1")).sent).toBe(true);
  });

  it("stays silent when muted, and when there is no destination", async () => {
    await seedLead("g1", 5);
    expect(await alerts.alertNewLead(client({ alertsEnabled: false }), "g1")).toEqual({
      sent: false,
      reason: "disabled",
    });
    expect(
      await alerts.alertNewLead(client({ alertWebhookEncrypted: null }), "g1"),
    ).toEqual({ sent: false, reason: "no_destination" });
    expect(posted).toHaveLength(0);
  });

  it("🔴 re-checks the destination at send time", async () => {
    /*
     * The allowlist can tighten, and a row saved before it did must not keep
     * firing requests at a host that is no longer permitted. Validating only on
     * write would leave those rows live indefinitely.
     */
    await seedLead("g1", 5);
    const r = await alerts.alertNewLead(
      client({ alertWebhookEncrypted: encrypt("https://evil.test/hook") }),
      "g1",
    );
    expect(r.sent).toBe(false);
    expect((r as { reason: string }).reason).toBe("bad_destination");
    expect(posted).toHaveLength(0);
  });

  it("stays silent for a contact this database has never seen", async () => {
    expect((await alerts.alertNewLead(client(), "nope")).sent).toBe(false);
  });

  it("caps the hourly volume", async () => {
    // Ten already alerted within the hour, then an eleventh arrives.
    for (let i = 0; i < 10; i++) await seedLead(`old${i}`, 30, { alerted: true });
    await seedLead("g1", 5);
    const r = await alerts.alertNewLead(client(), "g1");
    expect(r).toEqual({ sent: false, reason: "rate_limited" });
  });

  it("🔴 reports a rejected webhook rather than treating it as delivered", async () => {
    /*
     * A deleted Slack app leaves a live-looking URL that answers 404, and a
     * revoked one answers 403. Treating anything below 500 as success would
     * mark the lead alerted and go quiet for good, with nobody ever told the
     * destination had stopped working.
     */
    for (const status of [301, 403, 404]) {
      await harness.db.execute(sql.raw(`DELETE FROM contacts`));
      posted = [];
      nextStatus = status;
      await seedLead("g1", 5);
      const r = await alerts.alertNewLead(client(), "g1");
      expect(r.sent).toBe(false);
      expect((r as { reason: string }).reason).toBe("failed");
    }
  });

  it("🔴 survives a key that can no longer decrypt the destination", async () => {
    /*
     * Rotating ENCRYPTION_KEY leaves every stored ciphertext unreadable, and
     * `decrypt` throws rather than returning null. This runs inside the webhook
     * receiver's `after()`, so an escaping throw is an unhandled rejection in
     * the ingest path — for a courtesy feature.
     */
    await seedLead("g1", 5);
    const r = await alerts.alertNewLead(
      client({ alertWebhookEncrypted: "not:valid:ciphertext" }),
      "g1",
    );
    expect(r.sent).toBe(false);
    expect((r as { reason: string }).reason).toBe("failed");
  });

  it("🔴 does not throw when the destination is unreachable", async () => {
    /*
     * The receiver this sits behind exists to persist a payload and return 200,
     * because a non-2xx makes GHL retry and a lost transition is unrecoverable.
     * An alert is a courtesy; it must never be able to damage the ledger.
     */
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await seedLead("g1", 5);
    const r = await alerts.alertNewLead(client(), "g1");
    expect(r.sent).toBe(false);
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      posted.push({
        url,
        body: JSON.parse(init.body),
        init: init as unknown as Record<string, unknown>,
      });
      return { status: nextStatus } as Response;
    });
  });

  it("🔴 does not follow redirects, and gives up quickly", async () => {
    /*
     * A white-box assertion, and it earns its place: the allowlist checks the
     * URL we were GIVEN, so a 302 from an allowed host to an internal address
     * walks straight around it. That is the standard way a host allowlist is
     * defeated and no stub can observe it any other way.
     *
     * The timeout is here for a different reason — this runs after the webhook
     * response, and a destination that never answers would otherwise hold the
     * invocation open behind a third party.
     */
    await seedLead("g1", 5);
    await alerts.alertNewLead(client(), "g1");
    expect(posted[0].init.redirect).toBe("manual");
    expect(posted[0].init.signal).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * What the message contains
 * ------------------------------------------------------------------ */

describe("the composed message", () => {
  it("counts the lead's place in the client's day, not the server's", async () => {
    /*
     * Two leads earlier the same Los Angeles day, one of them after 5pm local —
     * which is already tomorrow in UTC. Counted in UTC the newest lead reads as
     * the first of the day when it is the third.
     *
     * 🔴 Every instant here is absolute, and `now` is passed in rather than
     * read off the wall clock. Seeding these at "09:00 local today" made the
     * test depend on what time of day it was RUN: before 5:30pm local the two
     * earlier leads are stamped in the future relative to the one being
     * alerted, the `<=` in the count excludes them, and it reads "1st today".
     * A test that passes for six hours a day is worse than no test — it fails
     * long after the change that broke nothing.
     *
     * Los Angeles is UTC-7 in August, so:
     *   09:00 PDT = 16:00Z (14th) · 17:30 PDT = 00:30Z (15th, already tomorrow
     *   in UTC — the whole point) · 18:00 PDT = 01:00Z (15th, this lead).
     */
    const at = (iso: string) => `'${iso}'::timestamptz`;
    await harness.db.execute(
      sql.raw(`
        INSERT INTO contacts (client_id, ghl_contact_id, meta_campaign_id, tags, ghl_created_at, alerted_at)
        VALUES
          ('${CLIENT_A}', 'e1', 'camp_1', ARRAY[]::text[],
           ${at("2026-08-14T16:00:00Z")}, ${at("2026-08-14T16:00:00Z")}),
          ('${CLIENT_A}', 'e2', 'camp_1', ARRAY[]::text[],
           ${at("2026-08-15T00:30:00Z")}, ${at("2026-08-15T00:30:00Z")}),
          /*
           * 🔴 And one stamped a minute in the FUTURE — clock skew between GHL
           * and us is routine. Without an upper bound on what counts, a later
           * lead inflates this one's position and the message says "4th today"
           * about the third.
           */
          ('${CLIENT_A}', 'future', 'camp_1', ARRAY[]::text[],
           ${at("2026-08-15T01:02:00Z")}, ${at("2026-08-15T01:02:00Z")}),
          ('${CLIENT_A}', 'g1', 'camp_1', ARRAY[]::text[],
           ${at("2026-08-15T01:00:00Z")}, NULL)
      `),
    );
    await alerts.alertNewLead(client(), "g1", new Date("2026-08-15T01:01:00Z"));
    const body = posted[0].body as { text: string; blocks: { text: { text: string } }[] };
    expect(body.blocks[0].text.text).toContain("3rd today");
  });

  it("reports the gap since the previous lead", async () => {
    // 9 days and 30 minutes back, so the gap cannot land on a knife edge.
    await seedLead("old", 60 * 24 * 9 + 30, { alerted: true });
    await seedLead("g1", 5);
    await alerts.alertNewLead(client(), "g1");
    const body = posted[0].body as { blocks: { text: { text: string } }[] };
    expect(body.blocks[0].text.text).toContain("First lead in 9 days");
  });

  it("says so when this is the first lead ever", async () => {
    await seedLead("g1", 5);
    await alerts.alertNewLead(client(), "g1");
    const body = posted[0].body as { blocks: { text: { text: string } }[] };
    expect(body.blocks[0].text.text).toContain("First lead ever");
  });

  it("builds a Discord body for a Discord destination", async () => {
    await seedLead("g1", 5);
    await alerts.alertNewLead(
      client({ alertWebhookEncrypted: encrypt("https://discord.com/api/webhooks/1/abc") }),
      "g1",
    );
    expect(posted[0].body).toHaveProperty("content");
    expect(posted[0].body).not.toHaveProperty("blocks");
  });
});

/* ------------------------------------------------------------------ *
 * Reading the setting back
 * ------------------------------------------------------------------ */

describe("describing the destination", () => {
  it("🔴 never returns the URL itself", async () => {
    /*
     * A Slack incoming-webhook URL IS the credential — anyone holding it can
     * post into the channel. Rendering it back into a settings form would put
     * it in the page source of every staff session.
     */
    await harness.db.execute(
      sql.raw(
        `INSERT INTO clients (id, name, slug, alert_webhook_encrypted, alerts_enabled)
         VALUES ('${CLIENT_A}', 'Alerted', 'alerted', '${encrypt(HOOK)}', true)
         ON CONFLICT (id) DO UPDATE SET alert_webhook_encrypted = EXCLUDED.alert_webhook_encrypted`,
      ),
    );
    const d = await alerts.describeDestination(CLIENT_A);
    expect(d).toEqual({ configured: true, target: "slack", enabled: true });
    expect(JSON.stringify(d)).not.toContain("hooks.slack.com");
  });
});
