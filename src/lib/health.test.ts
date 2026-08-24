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
 * The connection health checklist, against a real Postgres.
 *
 * ── Why this module in particular ─────────────────────────────────────
 *
 * `health.ts` is the thing that watches everything else. Its whole reason for
 * existing is that the spreadsheet it replaced failed SILENTLY — six empty
 * report blocks, SHOWN pinned at 0 beside three closed-won deals, two months of
 * leads against $0.00 spend — and nobody noticed for months, because a broken
 * pipe and a quiet month look identical in a grid of zeros.
 *
 * A health check that is wrong is therefore worse than no health check: it is
 * the same silence, now wearing a green tick. It had no tests.
 *
 * ── What is faked ─────────────────────────────────────────────────────
 *
 * Only the outbound HTTP clients. Every account list, every metric row and
 * every ledger read goes through real Postgres, because the checks under test
 * are the ones that reason about stored data.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

// The three credentials. Each check treats "no client" as not-connected, which
// keeps them out of the way of the data checks under test here.
vi.mock("@/lib/ghl/process", () => ({ getGhlClientAsync: async () => null }));
vi.mock("@/lib/ghl/oauth", () => ({ getInstallationForClient: async () => null }));
vi.mock("@/lib/meta/accounts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  metaClientForAccount: async () => null,
}));
vi.mock("@/lib/google/accounts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  googleClientForAccount: async () => null,
}));

let health: typeof import("./health");

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-08-18T17:00:00Z");

const client = (over: Partial<Client> = {}): Client =>
  ({
    id: CLIENT_A,
    name: "Parfaire",
    slug: "parfaire",
    timezone: TZ,
    metaCurrency: "USD",
    firstWebhookAt: new Date("2026-08-01T00:00:00Z"),
    lastWebhookAt: new Date("2026-08-18T12:00:00Z"),
    ...over,
  }) as Client;

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

/** One check out of a full report, by id. */
async function check(id: string, c: Client = client()) {
  const report = await health.runHealthChecks(c);
  const found = report.checks.find((x) => x.id === id);
  if (!found) throw new Error(`no check "${id}" in ${report.checks.map((x) => x.id)}`);
  return found;
}

/** N distinct leads landing in the ledger inside the trailing 30 days. */
async function seedLeads(n: number, clientId = CLIENT_A) {
  for (let i = 0; i < n; i++) {
    const opp = (
      await run(
        `INSERT INTO opportunities (client_id, ghl_opportunity_id)
         VALUES ('${clientId}', 'opp-${clientId.slice(0, 4)}-${i}') RETURNING id`,
      )
    ).rows[0].id;
    await run(
      `INSERT INTO stage_transitions
         (client_id, opportunity_id, to_stage_ghl_id, to_canonical, changed_at, dedupe_key)
       VALUES ('${clientId}', '${opp}', 'stage-new', 'new_lead',
               '2026-08-10T12:00:00Z', 'dk-${clientId.slice(0, 4)}-${i}')`,
    );
  }
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness = await createTestDb();
  health = await import("./health");
});

afterAll(async () => {
  vi.useRealTimers();
  await harness.close();
});

beforeEach(async () => {
  await run(
    `TRUNCATE stage_transitions, opportunities, pipeline_stages, contacts,
              fb_daily_metrics, google_daily_metrics, tiktok_daily_metrics,
              meta_ad_accounts, google_ad_accounts, tiktok_ad_accounts,
              sync_runs, clients RESTART IDENTITY CASCADE`,
  );
  for (const [id, slug] of [
    [CLIENT_A, "parfaire"],
    [CLIENT_B, "other"],
  ] as const) {
    await run(
      `INSERT INTO clients (id, name, slug) VALUES ('${id}', '${slug}', '${slug}')`,
    );
  }
});

describe("spend / lead coherence", () => {
  /*
   * The check named in CLAUDE.md after the exact corruption in the source
   * sheet: 25 leads recorded against $0.00 spend across May–Jun 2026, sitting
   * there unremarked. Its four states are the module's whole thesis in one
   * check — and getting any of them wrong reintroduces the silence.
   */

  it("nothing at all reads amber, not green", async () => {
    // A paused advertiser is a real, legitimate state. It must be visibly
    // distinct from flowing, or a dead pipe hides inside it.
    const c = await check("coherence");
    expect(c.level).toBe("amber");
    expect(c.message).toMatch(/paused/i);
  });

  it("🔴 leads against zero spend is red", async () => {
    await seedLeads(4);
    const c = await check("coherence");
    expect(c.level).toBe("red");
    expect(c.message).toContain("4 leads");
  });

  it("spend with no leads reaching the CRM is amber", async () => {
    await run(
      `INSERT INTO fb_daily_metrics (client_id, date, level, spend)
       VALUES ('${CLIENT_A}', '2026-08-10', 'campaign', 500)`,
    );
    const c = await check("coherence");
    expect(c.level).toBe("amber");
    expect(c.message).toMatch(/zero leads/i);
  });

  it("both flowing is green", async () => {
    await seedLeads(4);
    await run(
      `INSERT INTO fb_daily_metrics (client_id, date, level, spend)
       VALUES ('${CLIENT_A}', '2026-08-10', 'campaign', 500)`,
    );
    const c = await check("coherence");
    expect(c.level).toBe("green");
  });

  it("🔴 does not multiply spend by counting every insight level", async () => {
    /*
     * `fb_daily_metrics` holds the SAME money three times over: once as an
     * account row, once per campaign, once per ad. Every other query in the app
     * filters `level = 'campaign'`; a sum that does not is inflated by whatever
     * mix of levels the last sync happened to write — so the figure moves when
     * nothing about the spend did.
     */
    await seedLeads(2);
    for (const [level, spend] of [
      ["account", 500],
      ["campaign", 300],
      ["campaign", 200],
      ["ad", 200],
      ["ad", 300],
    ] as const) {
      await run(
        `INSERT INTO fb_daily_metrics (client_id, date, level, spend, meta_campaign_id)
         VALUES ('${CLIENT_A}', '2026-08-10', '${level}', ${spend}, 'c${spend}${level}')`,
      );
    }
    const c = await check("coherence");
    expect(c.level).toBe("green");
    // Written against the FORMATTED figure, with its separator. A bare "1500"
    // assertion silently stops testing anything the moment the message starts
    // rendering through `formatCurrency` — which is exactly what happened.
    expect(c.message).toContain("$500.00");
    expect(c.message).not.toMatch(/1,?500/);
  });

  it("🔴 a Google-only client with leads is not accused of spending nothing", async () => {
    /*
     * The false red. A client running Google or TikTok has no fb_daily_metrics
     * rows at all, so a Meta-only sum reads $0 — and the check reports "N leads
     * recorded against $0.00 spend" and suppresses their cost metrics, on a
     * client whose pipes are all working perfectly.
     *
     * This is precisely the failure this checklist exists to prevent, pointed
     * the other way: crying wolf trains people to ignore the one that matters.
     */
    await seedLeads(6);
    await run(
      `INSERT INTO google_ad_accounts (client_id, customer_id, currency)
       VALUES ('${CLIENT_A}', '123-456-7890', 'USD')`,
    );
    await run(
      `INSERT INTO google_daily_metrics (client_id, date, spend, currency)
       VALUES ('${CLIENT_A}', '2026-08-10', 900, 'USD')`,
    );
    const c = await check("coherence");
    expect(c.level).toBe("green");
    expect(c.message).toContain("$900.00");
  });

  it("🔴 a TikTok-only client likewise", async () => {
    await seedLeads(3);
    await run(
      `INSERT INTO tiktok_ad_accounts (client_id, advertiser_id, currency)
       VALUES ('${CLIENT_A}', '700000000000000', 'USD')`,
    );
    await run(
      `INSERT INTO tiktok_daily_metrics (client_id, date, spend, currency)
       VALUES ('${CLIENT_A}', '2026-08-10', 450, 'USD')`,
    );
    const c = await check("coherence");
    expect(c.level).toBe("green");
  });

  it("🔴 reports the client's own currency, not dollars", async () => {
    // A GBP account reading "$1,200.00" is a number the client cannot reconcile
    // against their own Ads Manager, on the one screen meant to build trust.
    await seedLeads(2);
    await run(
      `INSERT INTO fb_daily_metrics (client_id, date, level, spend)
       VALUES ('${CLIENT_A}', '2026-08-10', 'campaign', 1200)`,
    );
    const c = await check("coherence", client({ metaCurrency: "GBP" }));
    expect(c.message).toContain("£");
    expect(c.message).not.toContain("$");
  });

  it("🔴 never adds two currencies into one total", async () => {
    /*
     * A client running Meta in GBP and Google in USD has no single spend
     * figure. Adding them produces a number that is not money in any currency,
     * on a check whose job is to be believed — so both are reported, side by
     * side, and the reader does the conversion or does not.
     */
    await seedLeads(2);
    await run(
      `INSERT INTO fb_daily_metrics (client_id, date, level, spend)
       VALUES ('${CLIENT_A}', '2026-08-10', 'campaign', 1000)`,
    );
    await run(
      `INSERT INTO google_daily_metrics (client_id, date, spend, currency)
       VALUES ('${CLIENT_A}', '2026-08-10', 500, 'USD')`,
    );
    const c = await check("coherence", client({ metaCurrency: "GBP" }));
    expect(c.level).toBe("green");
    expect(c.message).toContain("£1,000.00");
    expect(c.message).toContain("$500.00");
    // The number that would exist only if the two had been added.
    expect(c.message).not.toMatch(/1,500/);
  });

  it("does not read another client's spend or leads", async () => {
    await seedLeads(5, CLIENT_B);
    await run(
      `INSERT INTO fb_daily_metrics (client_id, date, level, spend)
       VALUES ('${CLIENT_B}', '2026-08-10', 'campaign', 800)`,
    );
    const c = await check("coherence");
    expect(c.level).toBe("amber");
    expect(c.message).toMatch(/paused/i);
  });
});

describe("attribution, on a client who does not run Meta", () => {
  /*
   * 🔴 The same blindness the coherence check had, and worse here, because the
   * hints actively misdirect: they tell a client to add URL parameters they
   * already added, to ads on a platform they do not run.
   *
   * `parseAttribution` routes each id to EXACTLY ONE platform's column — a
   * Google lead's campaign id lands in `google_campaign_id` and deliberately
   * never in `meta_campaign_id`, because guessing would move the lead's whole
   * pipeline value to the wrong platform's cost-per-lead. So a perfectly
   * attributed Google client reads as entirely unattributed.
   */

  async function googleOnly(leads = 5) {
    await run(
      `INSERT INTO google_ad_accounts (client_id, customer_id, currency)
       VALUES ('${CLIENT_A}', '123-456-7890', 'USD')`,
    );
    for (let i = 0; i < leads; i++) {
      await run(
        `INSERT INTO contacts (client_id, ghl_contact_id, google_campaign_id, gclid)
         VALUES ('${CLIENT_A}', 'g-${i}', '2200000000${i}', 'Cj0KCQ${i}')`,
      );
    }
  }

  it("🔴 counts a Google campaign id as attribution", async () => {
    await googleOnly();
    const c = await check("attribution");
    expect(c.level).toBe("green");
    expect(c.message).toContain("5 of 5");
  });

  it("🔴 does not demand a Meta ad id from a client with no Meta account", async () => {
    /*
     * `contacts` has no google_ad_id or tiktok_ad_id column at all — ad-level
     * attribution is a Meta-only capability here. So this check can NEVER pass
     * for a Google-only client, and since the report takes the worst level, it
     * pinned their overall badge to red permanently, with no action available
     * that could ever clear it. A permanent alarm is an ignored checklist.
     */
    await googleOnly();
    const report = await health.runHealthChecks(client());
    expect(report.checks.map((x) => x.id)).not.toContain("ad_attribution");
  });

  it("🔴 nor does it show Meta connection checks to a Google-only client", async () => {
    // The rule already applied in the other direction: a Meta-only client is
    // not nagged about Google. It has to hold both ways or it is not a rule.
    await googleOnly();
    const report = await health.runHealthChecks(client());
    expect(report.checks.map((x) => x.id)).not.toContain("meta_token");
    expect(report.checks.map((x) => x.id)).toContain("google_token");
  });

  it("still demands SOMETHING of a client with no platform at all", async () => {
    /*
     * The limit of the rule above. Skipping Meta because "they run Google" is
     * right; skipping it because they run nothing would turn a wholly
     * unconnected client green — which is the silence this module exists to
     * break.
     */
    const report = await health.runHealthChecks(client());
    expect(report.checks.map((x) => x.id)).toContain("meta_token");
    expect(report.checks.find((x) => x.id === "meta_token")?.level).toBe("red");
  });

  it("keeps the Meta ad-id check for a client who does run Meta", async () => {
    await run(
      `INSERT INTO meta_ad_accounts (client_id, ad_account_id, currency)
       VALUES ('${CLIENT_A}', 'act_123', 'USD')`,
    );
    await run(
      `INSERT INTO contacts (client_id, ghl_contact_id, meta_campaign_id)
       VALUES ('${CLIENT_A}', 'm-1', '120200000000000001')`,
    );
    const report = await health.runHealthChecks(client());
    expect(report.checks.map((x) => x.id)).toContain("ad_attribution");
    expect(report.checks.find((x) => x.id === "ad_attribution")?.level).toBe("red");
    // …and its campaign id still counts, which "any platform" must not cost it.
    expect(report.checks.find((x) => x.id === "attribution")?.level).toBe("green");
  });

  it("🔴 counts each platform's own column, and none of them twice", async () => {
    /*
     * Three leads, one per platform, each attributed in its own column. The
     * failure this guards is a COALESCE list that drops one of the three —
     * which reads as a partial-attribution amber and sends someone to fix URL
     * parameters that were never broken.
     */
    for (const [i, col] of [
      "meta_campaign_id",
      "google_campaign_id",
      "tiktok_campaign_id",
    ].entries()) {
      await run(
        `INSERT INTO contacts (client_id, ghl_contact_id, ${col})
         VALUES ('${CLIENT_A}', 'x-${i}', '99000000${i}')`,
      );
    }
    // A fourth carrying nothing, so a check that counted rows rather than ids
    // would read 4 of 4 instead of 3 of 4.
    await run(
      `INSERT INTO contacts (client_id, ghl_contact_id) VALUES ('${CLIENT_A}', 'x-none')`,
    );

    const c = await check("attribution");
    expect(c.message).toContain("3 of 4");
  });
});

describe("stage mapping", () => {
  it("is red until every canonical stage is bound", async () => {
    const c = await check("stage_mapping");
    expect(c.level).toBe("red");
  });

  it("🔴 an unmapped stage discovered from a webhook is surfaced, not swallowed", async () => {
    /*
     * A client adding a stage in GHL after onboarding. The event is kept — that
     * is `process.ts`'s job — but the transition lands with a null canonical,
     * so it counts toward nothing until an operator maps it. Silence here is
     * how a funnel quietly stops counting a stage.
     */
    await run(
      `INSERT INTO pipeline_stages (client_id, ghl_pipeline_id, ghl_stage_id, canonical_stage, discovered_from_webhook)
       VALUES ('${CLIENT_A}', 'pip', 'brand-new-stage', NULL, true)`,
    );
    const c = await check("unknown_stages");
    expect(c.level).not.toBe("green");
  });
});

describe("webhook liveness", () => {
  it("🔴 never having received an event is red, not merely quiet", async () => {
    const c = await check("webhook", client({ firstWebhookAt: null, lastWebhookAt: null }));
    expect(c.level).toBe("red");
    // The consequence is what makes this urgent rather than cosmetic.
    expect(c.hint).toMatch(/cannot be backfilled/i);
  });

  it("a long quiet spell on a live pipe is amber", async () => {
    const c = await check(
      "webhook",
      client({ lastWebhookAt: new Date("2026-08-10T00:00:00Z") }),
    );
    expect(c.level).toBe("amber");
  });

  it("recent activity is green", async () => {
    const c = await check("webhook");
    expect(c.level).toBe("green");
  });
});

describe("the report as a whole", () => {
  it("🔴 takes the worst level, so one red cannot hide behind greens", async () => {
    const report = await health.runHealthChecks(
      client({ firstWebhookAt: null, lastWebhookAt: null }),
    );
    expect(report.overall).toBe("red");
  });

  it("🔴 withholds raw upstream errors from a non-superadmin", async () => {
    const report = await health.runHealthChecks(client());
    expect(report.checks.every((c) => c.diagnostic === undefined)).toBe(true);
  });
});

describe("the client-list badge", () => {
  /*
   * 🔴 `quickHealth` is the same judgement as the full report, rendered as one
   * dot on the agency's client list — and it is the one people actually look
   * at. It counted Meta ad accounts and nothing else, so a client running
   * Google or TikTok showed a permanent red dot beside a working account, with
   * no setup step that could ever turn it green.
   *
   * It is a separate function from `runHealthChecks` for speed, which is fine —
   * but it must not reach a DIFFERENT verdict about the same facts, or the
   * list and the detail page contradict each other.
   */

  const connected = (over: Partial<Client> = {}) =>
    client({ ghlAuthMethod: "pit", ghlTokenEncrypted: "tok", lastSyncedAt: NOW, ...over });

  it("🔴 a Google-only client is not red for having no Meta account", async () => {
    await run(
      `INSERT INTO google_ad_accounts (client_id, customer_id, status)
       VALUES ('${CLIENT_A}', '123-456-7890', 'active')`,
    );
    expect(await health.quickHealth(connected())).toBe("green");
  });

  it("🔴 a TikTok-only client likewise", async () => {
    await run(
      `INSERT INTO tiktok_ad_accounts (client_id, advertiser_id, status)
       VALUES ('${CLIENT_A}', '700000000000000', 'active')`,
    );
    expect(await health.quickHealth(connected())).toBe("green");
  });

  it("no ad platform at all is still red", async () => {
    expect(await health.quickHealth(connected())).toBe("red");
  });

  it("a removed account does not keep the badge green", async () => {
    // The status filter matters: a disconnected account still has a row.
    await run(
      `INSERT INTO google_ad_accounts (client_id, customer_id, status)
       VALUES ('${CLIENT_A}', '123-456-7890', 'removed')`,
    );
    expect(await health.quickHealth(connected())).toBe("red");
  });

  it("stays red while no webhook has ever arrived", async () => {
    // The irreplaceable pipe. Ads connected but no ledger is not a green state.
    await run(
      `INSERT INTO meta_ad_accounts (client_id, ad_account_id) VALUES ('${CLIENT_A}', 'act_1')`,
    );
    expect(await health.quickHealth(connected({ firstWebhookAt: null }))).toBe("red");
  });

  it("goes amber when the ad data has gone stale", async () => {
    await run(
      `INSERT INTO meta_ad_accounts (client_id, ad_account_id) VALUES ('${CLIENT_A}', 'act_1')`,
    );
    expect(
      await health.quickHealth(
        connected({ lastSyncedAt: new Date("2026-08-15T00:00:00Z") }),
      ),
    ).toBe("amber");
  });

  it("is red without a GHL connection, whatever the ads are doing", async () => {
    await run(
      `INSERT INTO meta_ad_accounts (client_id, ad_account_id) VALUES ('${CLIENT_A}', 'act_1')`,
    );
    expect(await health.quickHealth(connected({ ghlTokenEncrypted: null }))).toBe("red");
  });

  it("does not count another client's ad accounts, on any platform", async () => {
    // All three, because the count is three subqueries and a missing tenant
    // predicate on any ONE of them leaks — a single-platform fixture would
    // leave the other two untested.
    await run(
      `INSERT INTO meta_ad_accounts (client_id, ad_account_id) VALUES ('${CLIENT_B}', 'act_9')`,
    );
    await run(
      `INSERT INTO google_ad_accounts (client_id, customer_id, status)
       VALUES ('${CLIENT_B}', '999-999-9999', 'active')`,
    );
    await run(
      `INSERT INTO tiktok_ad_accounts (client_id, advertiser_id, status)
       VALUES ('${CLIENT_B}', '799999999999999', 'active')`,
    );
    expect(await health.quickHealth(connected())).toBe("red");
  });
});
