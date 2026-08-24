import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";

/**
 * Storing branding: the logo bytes, and the version that busts their cache.
 *
 * ── Why the version number is the part worth testing ──────────────────
 *
 * Both logo endpoints serve bytes with `Cache-Control: immutable,
 * max-age=31536000` and rely entirely on the `?v=` in their URL changing when
 * the image does. That makes an integer column load-bearing for a whole
 * feature: if it does not move, a replaced logo keeps serving from cache for a
 * YEAR, and the upload looks like it silently failed.
 *
 * Both forms also increment their own LOCAL copy after saving, so the preview
 * updates either way. The failure only appears on the next page load — which is
 * the worst possible shape for a bug, because the person who uploaded the logo
 * has already seen it work and moved on.
 *
 * The upsert itself is the other half. `logo_version + 1` is valid on the
 * conflict path and invalid inside `VALUES`, and Drizzle emits one statement
 * for both — so getting this wrong does not produce a wrong number, it produces
 * a statement Postgres refuses to parse, on every write, whether or not the row
 * exists.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let mod: typeof import("./branding-store");

const AGENCY = "aaaaaaaa-0000-4000-8000-00000000000a";
const CLIENT = "11111111-1111-1111-1111-111111111111";
const png = (b: string) => ({ bytes: Buffer.from(b), contentType: "image/png" });

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const clientRow = async () =>
  (
    await run(
      `SELECT display_name, brand_color, client_editable, logo_version,
              encode(logo_wordmark, 'escape') AS logo, logo_wordmark_type
         FROM client_branding WHERE client_id = '${CLIENT}'`,
    )
  ).rows[0];

const agencyRow = async () =>
  (
    await run(
      `SELECT agency_name, support_email, logo_version,
              encode(logo_wordmark, 'escape') AS logo
         FROM agency_settings WHERE agency_id = '${AGENCY}'`,
    )
  ).rows[0];

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./branding-store");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await run(
    `TRUNCATE client_branding, agency_settings, agencies, clients RESTART IDENTITY CASCADE`,
  );
  await run(
    `INSERT INTO agencies (id, name, slug) VALUES ('${AGENCY}', 'Growth Guild', 'growth-guild')`,
  );
  await run(
    `INSERT INTO clients (id, name, slug, agency_id) VALUES ('${CLIENT}', 'Acme', 'acme', '${AGENCY}')`,
  );
});

/* ------------------------------------------------------------------ *
 * Client branding
 * ------------------------------------------------------------------ */

describe("saveClientBranding", () => {
  it("🔴 stores a logo as the very first branding write", async () => {
    /*
     * The insert path. This threw — `logo_version + 1` is a column reference,
     * and Postgres rejects one inside `VALUES` — so a client whose first
     * branding action was uploading a logo got the generic write-failure
     * message, which blames an unapplied migration.
     */
    await mod.saveClientBranding(CLIENT, { logo: png("first") });

    const row = await clientRow();
    expect(row.logo).toBe("first");
    expect(row.logo_wordmark_type).toBe("image/png");
    // A first logo is version 1, not 0 — 0 is "no logo has ever been set", and
    // the URL must differ from the one a placeholder was fetched with.
    expect(row.logo_version).toBe(1);
  });

  it("🔴 stores a logo when the branding row already exists", async () => {
    await mod.saveClientBranding(CLIENT, { displayName: "Acme" });

    // The conflict path — which also failed, because the invalid VALUES clause
    // makes the whole statement unparseable regardless of which branch runs.
    await mod.saveClientBranding(CLIENT, { logo: png("second") });

    const row = await clientRow();
    expect(row.logo).toBe("second");
    expect(row.display_name).toBe("Acme");
  });

  it("🔴 bumps the version on every logo write", async () => {
    await mod.saveClientBranding(CLIENT, { logo: png("a") });
    expect((await clientRow()).logo_version).toBe(1);

    await mod.saveClientBranding(CLIENT, { logo: png("b") });
    expect((await clientRow()).logo_version).toBe(2);

    await mod.saveClientBranding(CLIENT, { logo: png("c") });
    expect((await clientRow()).logo_version).toBe(3);
  });

  it("🔴 bumps the version when the logo is REMOVED", async () => {
    await mod.saveClientBranding(CLIENT, { logo: png("a") });

    await mod.saveClientBranding(CLIENT, { logo: null });

    // Deleting is a change to the image too. Without the bump the URL is
    // unchanged and the browser keeps rendering the logo that was deleted.
    const row = await clientRow();
    expect(row.logo).toBeNull();
    expect(row.logo_version).toBe(2);
  });

  it("does not touch the version when no logo key is present", async () => {
    await mod.saveClientBranding(CLIENT, { logo: png("a") });
    await mod.saveClientBranding(CLIENT, { displayName: "Renamed" });

    // A name change must not invalidate a cached image; that is a needless
    // re-download on every settings save.
    const row = await clientRow();
    expect(row.logo_version).toBe(1);
    expect(row.display_name).toBe("Renamed");
  });

  it("🔴 writes only the keys it was given", async () => {
    await mod.saveClientBranding(CLIENT, {
      displayName: "Acme",
      clientEditable: true,
    });

    /*
     * The client-facing endpoint must be structurally incapable of touching
     * `clientEditable` — "we only put allowed keys in the object" is a weaker
     * guarantee than "the writer only ever writes named keys". So a later
     * partial update must leave the flag exactly where it was.
     */
    await mod.saveClientBranding(CLIENT, { displayName: "Acme Two" });

    const row = await clientRow();
    expect(row.client_editable).toBe(true);
    expect(row.display_name).toBe("Acme Two");
  });

  it("normalizes the brand colour in the writer, not at the boundary", async () => {
    const { normalizeBrandColor } = await import("./branding");
    const raw = "#ABCDEF";

    await mod.saveClientBranding(CLIENT, { brandColor: raw });

    /*
     * Asserted against the function rather than a hardcoded hex: WHAT it
     * produces is `branding.test.ts`'s job (it searches on measured contrast,
     * so the output is not a simple transform of the input). What matters here
     * is that the WRITER applies it at all — normalising in the writer is what
     * makes it impossible for a caller to skip and store a colour that renders
     * illegibly on one of the two themes.
     */
    const stored = (await clientRow()).brand_color;
    expect(stored).toBe(normalizeBrandColor(raw));
    expect(stored).not.toBe(raw.toLowerCase());
  });

  it("turns a blank name into null rather than storing whitespace", async () => {
    await mod.saveClientBranding(CLIENT, { displayName: "   " });
    // Null means "fall back to the client's real name"; an empty string renders
    // as a gap where a name belongs.
    expect((await clientRow()).display_name).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Agency settings
 * ------------------------------------------------------------------ */

describe("saveAgencySettings", () => {
  it("🔴 bumps the logo version, which nothing did", async () => {
    await mod.saveAgencySettings(AGENCY, { logo: png("mark-1") });
    expect((await agencyRow()).logo_version).toBe(1);

    await mod.saveAgencySettings(AGENCY, { logo: png("mark-2") });

    // Without this the URL stayed `?v=0` forever and the previous wordmark was
    // served from an immutable one-year cache.
    const row = await agencyRow();
    expect(row.logo).toBe("mark-2");
    expect(row.logo_version).toBe(2);
  });

  it("seeds the row on first write", async () => {
    await mod.saveAgencySettings(AGENCY, { supportEmail: "help@x.test" });
    expect((await agencyRow()).support_email).toBe("help@x.test");
  });

  it("leaves the version alone for a non-logo change", async () => {
    await mod.saveAgencySettings(AGENCY, { logo: png("mark") });
    await mod.saveAgencySettings(AGENCY, { agencyName: "Growth Guild" });

    const row = await agencyRow();
    expect(row.logo_version).toBe(1);
    expect(row.agency_name).toBe("Growth Guild");
  });

  it("stores a blank override as null, so the tenant name is used", async () => {
    await mod.saveAgencySettings(AGENCY, { agencyName: "  " });
    // Null is meaningful here: it means "follow `agencies.name`", so an agency
    // that renames itself keeps a correct footer.
    expect((await agencyRow()).agency_name).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Reading back
 * ------------------------------------------------------------------ */

describe("getAgencySettings", () => {
  it("🔴 falls back to the tenant's own name when no override is set", async () => {
    const settings = await mod.getAgencySettings(AGENCY);

    /*
     * Nothing implemented this fallback originally, so every report footer read
     * "Prepared by " followed by nothing — on every PDF, share link and print
     * view. A blank where a name belongs is the exact silent omission this
     * product exists to replace.
     */
    expect(settings.agencyName).toBe("Growth Guild");
    expect(settings.agencyNameOverride).toBeNull();
  });

  it("prefers an explicit override, and reports it separately", async () => {
    await mod.saveAgencySettings(AGENCY, { agencyName: "GG Media" });

    const settings = await mod.getAgencySettings(AGENCY);
    expect(settings.agencyName).toBe("GG Media");
    // Kept apart so a settings form can show a placeholder rather than
    // pre-filling the resolved name — which the operator would then save,
    // freezing "follow the tenant name" into a copy of it by doing nothing.
    expect(settings.agencyNameOverride).toBe("GG Media");
  });

  it("reports the stored logo version, so the URL can bust its cache", async () => {
    await mod.saveAgencySettings(AGENCY, { logo: png("mark") });

    const settings = await mod.getAgencySettings(AGENCY);
    expect(settings.hasLogo).toBe(true);
    expect(settings.logoVersion).toBe(1);
  });

  it("🔴 never throws — branding is chrome, and must not take a dashboard down", async () => {
    await run(`ALTER TABLE agency_settings RENAME TO agency_settings_hidden`);

    const settings = await mod.getAgencySettings(AGENCY);
    expect(settings).toEqual(mod.DEFAULT_AGENCY_SETTINGS);

    await run(`ALTER TABLE agency_settings_hidden RENAME TO agency_settings`);
  });
});

describe("getAgencyLogo", () => {
  it("returns the bytes and type once one is stored", async () => {
    await mod.saveAgencySettings(AGENCY, { logo: png("mark") });

    const logo = await mod.getAgencyLogo(AGENCY);
    expect(logo?.contentType).toBe("image/png");
    expect(logo?.bytes.toString()).toBe("mark");
  });

  it("returns null for an agency with none, and for an unknown one", async () => {
    expect(await mod.getAgencyLogo(AGENCY)).toBeNull();
    expect(
      await mod.getAgencyLogo("00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });
});
