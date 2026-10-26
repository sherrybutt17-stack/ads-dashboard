import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Client } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * GoHighLevel OAuth — the install-to-client binding.
 *
 * ── Why this file exists ──────────────────────────────────────────────
 *
 * `claimInstallation` and the rebinding branch in `upsertInstallation` are both
 * tenant boundaries, and both were written as security fixes rather than as
 * features. Until now neither had a test, which is the exact failure this
 * codebase keeps naming elsewhere: a rule reachable only through a live OAuth
 * round-trip gets verified by whoever is confident rather than by the suite.
 *
 * A GHL installation is not an ordinary row. It holds live access and refresh
 * tokens for a sub-account, and whoever holds the binding reads that
 * sub-account's contacts, opportunities and stage transitions. Pointing the row
 * at the wrong client is not a display bug — it is one tenant reading another
 * tenant's CRM through credentials the platform handed over.
 *
 * ── What is asserted, and what is deliberately not ────────────────────
 *
 * The token HTTP is mocked; there is no value in testing that `fetch` posts a
 * form. What is asserted is everything that decides WHOSE the row becomes, plus
 * the refresh write-back — because GHL's refresh tokens are single-use, so a
 * refresh that returns without persisting locks the client out until they
 * reinstall, and that is not recoverable from our side.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

/**
 * The location-name lookup is cosmetic and the module already swallows its
 * errors, so it is stubbed rather than exercised — but stubbed to a KNOWN name,
 * so a test can tell "we stored what GHL said" from "we stored null".
 */
vi.mock("./client", () => ({
  GhlClient: class {
    async getLocation() {
      return { id: "loc-1", name: "Parfaire Medical" };
    }
  },
  GhlApiError: class extends Error {},
}));

let mod: typeof import("./oauth");

const AGENCY_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const AGENCY_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CLIENT_A1 = "11111111-1111-1111-1111-111111111111";
const CLIENT_A2 = "22222222-2222-2222-2222-222222222222";
const CLIENT_B1 = "33333333-3333-3333-3333-333333333333";
const INSTALL = "99999999-9999-4999-8999-999999999999";

/** Enough of a `Client` for the binding rules; the rest is never read here. */
const asClient = (id: string, agencyId: string, slug: string): Client =>
  ({ id, agencyId, slug }) as Client;

const originalKey = process.env.ENCRYPTION_KEY;
const originalId = process.env.GHL_CLIENT_ID;
const originalSecret = process.env.GHL_CLIENT_SECRET;

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const installRow = async (id = INSTALL) =>
  (
    await run(
      `SELECT client_id::text AS client_id, location_id, location_name,
              access_token_encrypted, refresh_token_encrypted, uninstalled_at,
              expires_at
         FROM ghl_installations WHERE id = '${id}'`,
    )
  ).rows[0];

const clientRow = async (id: string) =>
  (
    await run(
      `SELECT ghl_location_id, ghl_location_name, ghl_auth_method
         FROM clients WHERE id = '${id}'`,
    )
  ).rows[0];

/** Seed an installation directly, so a claim test does not depend on exchange. */
async function seedInstall(opts: {
  id?: string;
  locationId?: string;
  clientId?: string | null;
} = {}) {
  const id = opts.id ?? INSTALL;
  const clientId = opts.clientId === undefined ? null : opts.clientId;
  await run(
    `INSERT INTO ghl_installations
       (id, location_id, access_token_encrypted, refresh_token_encrypted,
        expires_at, location_name, client_id)
     VALUES ('${id}', '${opts.locationId ?? "loc-1"}', 'enc-access', 'enc-refresh',
             now() + interval '1 day', 'Parfaire Medical',
             ${clientId ? `'${clientId}'` : "NULL"})`,
  );
  return id;
}

/** A token endpoint that answers once with the given body. */
function mockToken(body: Record<string, unknown>, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeAll(async () => {
  harness = await createTestDb();
  // A real 32-byte key: `crypto.ts` refuses anything else, and these tests
  // assert on ciphertext that must round-trip.
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.GHL_CLIENT_ID = "test-client-id";
  process.env.GHL_CLIENT_SECRET = "test-client-secret";
  mod = await import("./oauth");
});

afterAll(async () => {
  await harness.close();
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
  if (originalId === undefined) delete process.env.GHL_CLIENT_ID;
  else process.env.GHL_CLIENT_ID = originalId;
  if (originalSecret === undefined) delete process.env.GHL_CLIENT_SECRET;
  else process.env.GHL_CLIENT_SECRET = originalSecret;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await run(`TRUNCATE ghl_installations, clients RESTART IDENTITY CASCADE`);
  for (const [id, slug, agency] of [
    [CLIENT_A1, "acme", AGENCY_A],
    [CLIENT_A2, "acme-two", AGENCY_A],
    [CLIENT_B1, "rival", AGENCY_B],
  ]) {
    await run(
      `INSERT INTO clients (id, name, slug, agency_id) VALUES ('${id}', '${slug}', '${slug}', '${agency}')`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * claimInstallation — who the install becomes
 * ------------------------------------------------------------------ */

describe("claimInstallation", () => {
  it("binds an unclaimed install and writes the location back onto the client", async () => {
    await seedInstall();

    await mod.claimInstallation(INSTALL, asClient(CLIENT_A1, AGENCY_A, "acme"));

    expect((await installRow())!.client_id).toBe(CLIENT_A1);
    /*
     * The write-back matters as much as the binding. `ghlLocationId` is
     * elsewhere a form field anyone may type; this is the one writer whose
     * value came out of a completed OAuth exchange, and `ghl_auth_method`
     * flipping to `oauth` is what tells the rest of the app to stop reaching
     * for a private integration token.
     */
    expect(await clientRow(CLIENT_A1)).toMatchObject({
      ghl_location_id: "loc-1",
      ghl_location_name: "Parfaire Medical",
      ghl_auth_method: "oauth",
    });
  });

  it("lets an agency move its own sub-account between its own clients", async () => {
    await seedInstall({ clientId: CLIENT_A1 });

    // Ordinary housekeeping: same tenant, different client of theirs.
    await mod.claimInstallation(INSTALL, asClient(CLIENT_A2, AGENCY_A, "acme-two"));

    expect((await installRow())!.client_id).toBe(CLIENT_A2);
    expect(await clientRow(CLIENT_A2)).toMatchObject({ ghl_auth_method: "oauth" });
  });

  it("🔴 refuses to move a claimed install across a tenant boundary", async () => {
    await seedInstall({ clientId: CLIENT_A1 });

    await expect(
      mod.claimInstallation(INSTALL, asClient(CLIENT_B1, AGENCY_B, "rival")),
    ).rejects.toThrow(/already connected elsewhere/i);

    // The refusal has to be total: a throw that left the row rewritten would be
    // worse than no check, because the caller sees an error and the tokens have
    // already moved.
    expect((await installRow())!.client_id).toBe(CLIENT_A1);
    expect(await clientRow(CLIENT_B1)).toMatchObject({ ghl_auth_method: "pit" });
  });

  it("does not name the tenant that holds the install", async () => {
    await seedInstall({ clientId: CLIENT_A1 });

    const err = await mod
      .claimInstallation(INSTALL, asClient(CLIENT_B1, AGENCY_B, "rival"))
      .catch((e: Error) => e);

    /*
     * A failed claim must not double as a lookup service. Naming the holder
     * would let anyone with a location id enumerate which agency runs which
     * sub-account — the competitive intelligence is the breach here, not the
     * access.
     */
    const message = (err as Error).message;
    for (const leak of [CLIENT_A1, AGENCY_A, "acme"]) {
      expect(message).not.toContain(leak);
    }
  });

  it("is idempotent when the same client claims twice", async () => {
    await seedInstall({ clientId: CLIENT_A1 });
    const client = asClient(CLIENT_A1, AGENCY_A, "acme");

    await mod.claimInstallation(INSTALL, client);
    await mod.claimInstallation(INSTALL, client);

    expect((await installRow())!.client_id).toBe(CLIENT_A1);
  });

  it("refuses an installation id that does not exist", async () => {
    await expect(
      mod.claimInstallation(
        "00000000-0000-4000-8000-000000000000",
        asClient(CLIENT_A1, AGENCY_A, "acme"),
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("treats a client whose agency cannot be resolved as a different tenant", async () => {
    /*
     * `agencyIdForClient` returns null for a client that does not exist, and
     * null must not compare equal to the caller's agency. A caller that could
     * pass a deleted client id and have the tenant check evaporate would be the
     * IDOR the null-handling note in `tenancy.ts` warns about.
     */
    await run(`UPDATE ghl_installations SET id = id`); // no-op, keeps shape obvious
    await seedInstall({ clientId: CLIENT_A1 });
    await run(`DELETE FROM clients WHERE id = '${CLIENT_A1}'`);
    // The FK sets client_id to null on delete, so re-point it by hand to model
    // a row whose holder has since vanished.
    await run(
      `UPDATE ghl_installations SET client_id = NULL WHERE id = '${INSTALL}'`,
    );

    // With no holder at all the claim is allowed — that is the unclaimed path.
    await mod.claimInstallation(INSTALL, asClient(CLIENT_B1, AGENCY_B, "rival"));
    expect((await installRow())!.client_id).toBe(CLIENT_B1);
  });
});

/* ------------------------------------------------------------------ *
 * exchangeCode / upsertInstallation — reinstall and rebinding
 * ------------------------------------------------------------------ */

describe("exchangeCode", () => {
  const token = (over: Record<string, unknown> = {}) => ({
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 86400,
    locationId: "loc-1",
    scope: "opportunities.readonly",
    ...over,
  });

  it("stores tokens encrypted, never in the clear", async () => {
    mockToken(token());

    const [row] = await mod.exchangeCode("code-1", null);

    const stored = await installRow(row.installation.id);
    expect(stored!.access_token_encrypted).not.toContain("access-1");
    expect(stored!.refresh_token_encrypted).not.toContain("refresh-1");
    // Still readable by us — an encrypted column that cannot be decrypted is
    // indistinguishable from a corrupted one until a sync fails at 2am.
    const { decrypt } = await import("@/lib/crypto");
    expect(decrypt(stored!.access_token_encrypted as string)).toBe("access-1");
    expect(decrypt(stored!.refresh_token_encrypted as string)).toBe("refresh-1");
  });

  it("🔴 asks for a Location token, not GHL's Company default", async () => {
    const fetchMock = mockToken(token());

    await mod.exchangeCode("code-1", null);

    const body = new URLSearchParams(
      (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    );
    expect(body.get("user_type")).toBe("Location");
  });

  /*
   * Agency-level installs. GHL's install screen is a multi-select for every new
   * (bulk-installable) app, and what comes back is the agency's Company token —
   * even with one sub-account ticked. It used to be refused; now each approved
   * sub-account gets its own Location token from it.
   */
  const agencyToken = (over: Record<string, unknown> = {}) => ({
    access_token: "agency-access",
    refresh_token: "agency-refresh",
    expires_in: 86400,
    userType: "Company",
    companyId: "comp-1",
    isBulkInstallation: true,
    ...over,
  });
  const locToken = (loc: string) => ({
    access_token: `access-${loc}`,
    refresh_token: `refresh-${loc}`,
    expires_in: 86400,
    userType: "Location",
    locationId: loc,
    scope: "opportunities.readonly",
  });
  type Init = { body?: string; headers?: Record<string, string> };

  /** GHL by URL: the code exchange, each sub-account's token (null = refused), the installed list. */
  function mockAgency(opts: {
    token: Record<string, unknown>;
    locations?: Record<string, Record<string, unknown> | null>;
    installed?: string[];
  }) {
    const fetchMock = vi.fn(async (url: string | URL, init?: Init) => {
      const u = String(url);
      if (u.includes("/oauth/locationToken")) {
        const body = opts.locations?.[new URLSearchParams(init?.body ?? "").get("locationId") ?? ""];
        return body
          ? { ok: true, status: 200, text: async () => JSON.stringify(body) }
          : { ok: false, status: 400, text: async () => JSON.stringify({ message: "Location not approved" }) };
      }
      if (u.includes("/oauth/installedLocations")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ locations: (opts.installed ?? []).map((id) => ({ _id: id, isInstalled: true })) }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(opts.token) };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const count = async () => (await run(`SELECT count(*)::int AS n FROM ghl_installations`)).rows[0].n;

  it("🔴 turns an agency install of one sub-account into that sub-account's own tokens", async () => {
    const fetchMock = mockAgency({ token: agencyToken({ approvedLocations: ["loc-1"] }), locations: { "loc-1": locToken("loc-1") } });

    const rows = await mod.exchangeCode("code-1", CLIENT_A1);

    expect(rows.map((r) => r.installation.locationId)).toEqual(["loc-1"]);
    // GHL's documented exchange: the agency's bearer token, form-encoded ids, the pinned version.
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/oauth/locationToken"))!;
    const init = call[1] as Required<Init>;
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({ companyId: "comp-1", locationId: "loc-1" });
    expect(init.headers.Authorization).toBe("Bearer agency-access");
    expect(init.headers.Version).toBe("2021-07-28");
    // The sub-account's own pair is what is stored — never the agency's.
    const stored = await installRow(rows[0].installation.id);
    const { decrypt } = await import("@/lib/crypto");
    expect(decrypt(stored!.access_token_encrypted as string)).toBe("access-loc-1");
    expect(decrypt(stored!.refresh_token_encrypted as string)).toBe("refresh-loc-1");
  });

  it("🔴 connects every sub-account of a multi-select install, and moves no client's binding", async () => {
    await seedInstall({ clientId: CLIENT_A1 });
    mockAgency({
      token: agencyToken({ approvedLocations: ["loc-1", "loc-2"] }),
      locations: { "loc-1": locToken("loc-1"), "loc-2": locToken("loc-2") },
    });

    // Started from another client's page: with two sub-accounts there is no telling which is its.
    const rows = await mod.exchangeCode("code-1", CLIENT_B1);

    expect(rows.map((r) => r.installation.locationId).sort()).toEqual(["loc-1", "loc-2"]);
    const bound = (await run(
      `SELECT location_id, client_id::text AS client_id FROM ghl_installations ORDER BY location_id`,
    )).rows;
    expect(bound).toEqual([
      { location_id: "loc-1", client_id: CLIENT_A1 },
      { location_id: "loc-2", client_id: null },
    ]);
  });

  it("falls back to where the app is installed when the token names no sub-account", async () => {
    const fetchMock = mockAgency({ token: agencyToken(), installed: ["loc-3"], locations: { "loc-3": locToken("loc-3") } });

    const rows = await mod.exchangeCode("code-1", null);

    expect(rows.map((r) => r.installation.locationId)).toEqual(["loc-3"]);
    const listed = new URL(String(fetchMock.mock.calls.find(([u]) => String(u).includes("/oauth/installedLocations"))![0]));
    // The parent app id: the client id's part before the dash.
    expect(Object.fromEntries(listed.searchParams)).toMatchObject({ companyId: "comp-1", appId: "test", isInstalled: "true" });
  });

  it("keeps the sub-accounts GHL gave tokens for when one is refused", async () => {
    mockAgency({
      token: agencyToken({ approvedLocations: ["loc-1", "loc-2"] }),
      locations: { "loc-1": null, "loc-2": locToken("loc-2") },
    });

    const rows = await mod.exchangeCode("code-1", null);

    expect(rows.map((r) => r.installation.locationId)).toEqual(["loc-2"]);
  });

  it("says which sub-accounts it is the first to hear of", async () => {
    await seedInstall({ clientId: CLIENT_A1 });
    mockAgency({
      token: agencyToken({ approvedLocations: ["loc-1", "loc-2"] }),
      locations: { "loc-1": locToken("loc-1"), "loc-2": locToken("loc-2") },
    });

    const subs = await mod.exchangeCode("code-1", null);

    expect(subs.map((s) => [s.installation.locationId, s.isNew]).sort()).toEqual([
      ["loc-1", false],
      ["loc-2", true],
    ]);
  });

  it("surfaces an agency install no sub-account of which could be connected, storing nothing", async () => {
    mockAgency({ token: agencyToken({ approvedLocations: ["loc-1"] }), locations: { "loc-1": null } });
    await expect(mod.exchangeCode("code-1", null)).rejects.toThrow(/sub-account token failed \(400\)/);

    mockAgency({ token: agencyToken({ companyId: undefined }) });
    await expect(mod.exchangeCode("code-1", null)).rejects.toThrow(/neither a sub-account nor an agency/);

    // An unusable row would show in the UI as a connected install that can never sync.
    expect(await count()).toBe(0);
  });

  it("preserves the existing binding when the same client reinstalls", async () => {
    await seedInstall({ clientId: CLIENT_A1 });
    mockToken(token());

    await mod.exchangeCode("code-1", CLIENT_A1);

    // A scope change or a re-consent must not cost the operator their mapping.
    const stored = (await run(
      `SELECT client_id::text AS client_id FROM ghl_installations WHERE location_id = 'loc-1'`,
    )).rows[0];
    expect(stored.client_id).toBe(CLIENT_A1);
  });

  it("preserves the existing binding when a marketplace install names no client", async () => {
    await seedInstall({ clientId: CLIENT_A1 });
    mockToken(token());

    // GHL-initiated installs arrive with no state cookie and therefore no
    // intended client. That is not a reason to orphan a working binding.
    await mod.exchangeCode("code-1", null);

    const stored = (await run(
      `SELECT client_id::text AS client_id FROM ghl_installations WHERE location_id = 'loc-1'`,
    )).rows[0];
    expect(stored.client_id).toBe(CLIENT_A1);
  });

  it("🔴 clears the binding when a reinstall names a different client", async () => {
    await seedInstall({ clientId: CLIENT_A1 });
    mockToken(token());

    await mod.exchangeCode("code-1", CLIENT_B1);

    /*
     * This is the sub-account-changes-hands case. The upsert deliberately omits
     * `clientId`, so without this clearing step agency B's fresh, working
     * tokens would land in a row still pointing at agency A's client — and A
     * would then read B's CRM through them. Dropping to null hands the decision
     * to `claimInstallation`, which is the only place that can authorize it.
     */
    const stored = (await run(
      `SELECT client_id::text AS client_id, access_token_encrypted
         FROM ghl_installations WHERE location_id = 'loc-1'`,
    )).rows[0];
    expect(stored.client_id).toBeNull();

    const { decrypt } = await import("@/lib/crypto");
    expect(decrypt(stored.access_token_encrypted as string)).toBe("access-1");
  });

  it("clears the uninstall marker on reinstall", async () => {
    await seedInstall({ clientId: CLIENT_A1 });
    await run(`UPDATE ghl_installations SET uninstalled_at = now()`);
    mockToken(token());

    await mod.exchangeCode("code-1", CLIENT_A1);

    const stored = (await run(
      `SELECT uninstalled_at FROM ghl_installations WHERE location_id = 'loc-1'`,
    )).rows[0];
    expect(stored.uninstalled_at).toBeNull();
  });

  it("surfaces a failed exchange rather than storing a half row", async () => {
    mockToken({ error: "invalid_grant" }, false, 400);

    await expect(mod.exchangeCode("stale-code", CLIENT_A1)).rejects.toThrow(/400/);
    expect((await run(`SELECT count(*)::int AS n FROM ghl_installations`)).rows[0].n).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * getValidAccessToken — the single-use refresh token
 * ------------------------------------------------------------------ */

describe("getValidAccessToken", () => {
  it("returns the stored token without a network call while it is still valid", async () => {
    const { encrypt } = await import("@/lib/crypto");
    const fetchMock = mockToken({});

    const value = await mod.getValidAccessToken({
      id: INSTALL,
      accessTokenEncrypted: encrypt("still-good"),
      refreshTokenEncrypted: encrypt("refresh-1"),
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    expect(value).toBe("still-good");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("🔴 persists the new pair before returning it", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    await seedInstall({ clientId: CLIENT_A1 });
    mockToken({
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_in: 86400,
    });

    const value = await mod.getValidAccessToken({
      id: INSTALL,
      accessTokenEncrypted: encrypt("expired"),
      refreshTokenEncrypted: encrypt("refresh-1"),
      expiresAt: new Date(Date.now() - 60_000),
    } as never);

    expect(value).toBe("access-2");
    /*
     * GHL invalidates the old refresh token the moment a new pair is issued.
     * If the write is lost, the token we just burned is gone and the only
     * recovery is a manual reinstall by the client — so the returned value
     * being right is not enough, the row has to hold it.
     */
    const stored = await installRow();
    expect(decrypt(stored!.access_token_encrypted as string)).toBe("access-2");
    expect(decrypt(stored!.refresh_token_encrypted as string)).toBe("refresh-2");
  });

  it("🔴 refreshes as a Location token", async () => {
    const { encrypt } = await import("@/lib/crypto");
    await seedInstall({ clientId: CLIENT_A1 });
    const fetchMock = mockToken({
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_in: 86400,
    });

    await mod.getValidAccessToken({
      id: INSTALL,
      accessTokenEncrypted: encrypt("expired"),
      refreshTokenEncrypted: encrypt("refresh-1"),
      expiresAt: new Date(Date.now() - 60_000),
    } as never);

    const body = new URLSearchParams(
      (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    );
    expect(body.get("user_type")).toBe("Location");
  });
});

/* ------------------------------------------------------------------ *
 * The install URL
 * ------------------------------------------------------------------ */

describe("buildAuthorizeUrl", () => {
  it("sends space-separated scopes and the state verbatim", async () => {
    const url = new URL(mod.buildAuthorizeUrl("client.nonce.sig"));

    // Comma-separated scopes are accepted by the URL and then silently ignored
    // by GHL, which surfaces much later as a 401 on the first real call.
    expect(url.searchParams.get("scope")).toBe(mod.GHL_SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("client.nonce.sig");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(mod.redirectUri());
  });
});

/* ------------------------------------------------------------------ *
 * installFor — which sub-account of an install is the client's
 * ------------------------------------------------------------------ */

describe("installFor", () => {
  const sub = (locationId: string, clientId: string | null, isNew = false) => ({
    installation: { id: `inst-${locationId}`, locationId, clientId } as never,
    isNew,
  });
  const pick = (subs: Array<ReturnType<typeof sub>>, clientId = CLIENT_A2) =>
    (mod.installFor(clientId, subs) as { locationId: string } | null)?.locationId ?? null;

  it("🔴 takes the sub-account just ticked over the agency's others — Aloha alongside King LASIK", () => {
    expect(pick([sub("king-lasik", CLIENT_A1), sub("aloha", null, true)])).toBe("aloha");
    // Even beside another sub-account no client holds, from an earlier install.
    expect(pick([sub("king-lasik", CLIENT_A1), sub("older", null), sub("aloha", null, true)])).toBe("aloha");
  });

  it("takes the client's own sub-account on a reconnect", () => {
    expect(pick([sub("king-lasik", CLIENT_A1), sub("aloha", CLIENT_A2)])).toBe("aloha");
  });

  it("takes the one no client holds, when nothing is new", () => {
    expect(pick([sub("king-lasik", CLIENT_A1), sub("aloha", null)])).toBe("aloha");
  });

  it("🔴 never guesses: two new, two free, or only other clients' sub-accounts leave it to a person", () => {
    expect(pick([sub("a", null, true), sub("b", null, true)])).toBeNull();
    expect(pick([sub("a", null), sub("b", null)])).toBeNull();
    expect(pick([sub("a", CLIENT_A1), sub("b", CLIENT_B1)])).toBeNull();
  });

  it("takes a lone sub-account as before — claiming it still checks who holds it", () => {
    expect(pick([sub("a", CLIENT_B1)])).toBe("a");
  });
});
