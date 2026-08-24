import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agencies,
  agencySettings,
  clientBranding,
  type AgencyMarkMode,
} from "@/db/schema";
import { NO_BRANDING, normalizeBrandColor, type ClientBranding } from "./branding";

/**
 * Reading and writing branding. The I/O half of `branding.ts`, which stays pure.
 */

export interface AgencySettings {
  /**
   * The name to PRINT — already resolved, never null unless nothing is known.
   *
   * 🔴 `agency_settings.agency_name` is null by default and its documented
   * meaning is "use `agencies.name`", but nothing implemented that fallback and
   * there is still no UI that sets an override. So every agency — the bootstrap
   * one included — rendered a report footer reading "Prepared by " followed by
   * nothing, on every PDF, share link and print view. A blank where a name
   * belongs is the exact silent-omission failure this product exists to
   * replace, and self-serve sign-up made it the default state of every new
   * tenant rather than an edge case.
   *
   * Resolved at read time rather than by backfilling the column, because the
   * column's null is meaningful: it means "follow the tenant's name", so an
   * agency that renames itself keeps a correct footer instead of carrying a
   * copy of its old name forever.
   */
  agencyName: string | null;
  /**
   * The stored override, or null when the tenant's own name is being used.
   *
   * Kept separate so a future settings form can show a placeholder rather than
   * pre-filling the resolved name — which the operator would then save, turning
   * "follow the tenant name" into a frozen copy of it by doing nothing.
   */
  agencyNameOverride: string | null;
  agencyMarkMode: AgencyMarkMode;
  supportEmail: string | null;
  hasLogo: boolean;
  logoVersion: number;
}

export const DEFAULT_AGENCY_SETTINGS: AgencySettings = {
  agencyName: null,
  agencyNameOverride: null,
  // Not `full`, and not `none`: `prepared_by` is the setting that signs the work
  // without competing with the client's own brand on their own report.
  agencyMarkMode: "prepared_by",
  supportEmail: null,
  hasLogo: false,
  logoVersion: 0,
};

/**
 * The agency's settings, seeded on first read.
 *
 * 🔴 Upsert-on-read rather than a migration seed, and this is not a stylistic
 * choice. This project has no migration RUNNER — `package.json` exposes
 * `db:generate` and `db:push`, and `db:push` diffs the schema against the
 * database without ever executing the SQL in `drizzle/`. An `INSERT` written
 * into a migration file would therefore never run, and every reader would find
 * an empty table and fall back forever, silently.
 *
 * Never throws: branding is chrome, and a settings-table failure must not take
 * down a dashboard full of real numbers.
 */
export async function getAgencySettings(
  agencyId: string,
): Promise<AgencySettings> {
  try {
    /*
     * Left join, not two queries: the tenant's name is the fallback for the
     * settings row's, and a settings row that does not exist yet still has a
     * tenant name to fall back to. One round trip answers both.
     */
    const [row] = await db
      .select({
        settings: agencySettings,
        tenantName: agencies.name,
      })
      .from(agencies)
      .leftJoin(agencySettings, eq(agencySettings.agencyId, agencies.id))
      .where(eq(agencies.id, agencyId))
      .limit(1);

    if (row?.settings) {
      const s = row.settings;
      return {
        // The override when set, the tenant's own name otherwise.
        agencyName: s.agencyName ?? row.tenantName ?? null,
        agencyNameOverride: s.agencyName,
        agencyMarkMode: s.agencyMarkMode,
        supportEmail: s.supportEmail,
        hasLogo: s.logoWordmark !== null,
        logoVersion: s.logoVersion,
      };
    }

    if (row) {
      /*
       * The tenant exists but has no settings row yet. Seed it, and answer with
       * the tenant's name rather than the module default — a brand-new agency's
       * first report must be signed, and its first report is very often the one
       * that goes to a client.
       */
      await db.insert(agencySettings).values({ agencyId }).onConflictDoNothing();
      return { ...DEFAULT_AGENCY_SETTINGS, agencyName: row.tenantName ?? null };
    }

    /*
     * No such agency. Nothing to seed against — `agency_settings.agency_id` is
     * a foreign key, so inserting here would fail the constraint rather than
     * create anything. The caller gets the defaults and an unsigned report,
     * which is correct: we do not know whose it is.
     */
    return DEFAULT_AGENCY_SETTINGS;
  } catch (err) {
    console.error("[branding] agency settings unavailable", err);
    return DEFAULT_AGENCY_SETTINGS;
  }
}

/**
 * One client's branding, resolved for render.
 *
 * Returns `NO_BRANDING` on any failure — including the table not existing yet,
 * which is the state between deploying this code and running the migration.
 * Chrome degrading to the default is invisible; a dashboard 500ing over a logo
 * is not.
 */
export async function getClientBranding(clientId: string): Promise<ClientBranding> {
  try {
    const [row] = await db
      .select({
        displayName: clientBranding.displayName,
        brandColor: clientBranding.brandColor,
        reportContactLine: clientBranding.reportContactLine,
        // Deliberately NOT selecting the blobs — this runs on every dashboard
        // load and the bytes are only ever needed by the logo route.
        logoVersion: clientBranding.logoVersion,
        hasLogo: clientBranding.logoWordmarkType,
        brandColorAppliesToDashboard: clientBranding.brandColorAppliesToDashboard,
        clientEditable: clientBranding.clientEditable,
      })
      .from(clientBranding)
      .where(eq(clientBranding.clientId, clientId))
      .limit(1);

    if (!row) return NO_BRANDING;
    return {
      displayName: row.displayName,
      brandColor: row.brandColor,
      reportContactLine: row.reportContactLine,
      hasLogo: row.hasLogo !== null,
      logoVersion: row.logoVersion,
      appliesToDashboard: row.brandColorAppliesToDashboard,
      clientEditable: row.clientEditable,
    };
  } catch (err) {
    console.error("[branding] client branding unavailable", err);
    return NO_BRANDING;
  }
}

/** The logo bytes, for the slug-scoped asset route. */
export async function getClientLogo(
  clientId: string,
  which: "wordmark" | "square" = "wordmark",
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const [row] = await db
    .select({
      wordmark: clientBranding.logoWordmark,
      wordmarkType: clientBranding.logoWordmarkType,
      square: clientBranding.logoSquare,
      squareType: clientBranding.logoSquareType,
    })
    .from(clientBranding)
    .where(eq(clientBranding.clientId, clientId))
    .limit(1);

  if (!row) return null;
  const bytes = which === "square" ? row.square : row.wordmark;
  const contentType = which === "square" ? row.squareType : row.wordmarkType;
  if (!bytes || !contentType) return null;
  return { bytes, contentType };
}

/**
 * The client's logo as a `data:` URI, for the REPORT.
 *
 * 🔴 The report cannot use the asset route. `/api/c/<slug>/branding/logo` is
 * behind `clientAccessGuard`, and the whole point of a share link is that its
 * reader has no session — so the request 401s and the client's own logo renders
 * broken on the one document that exists to carry it. That is precisely the
 * failure the slug-scoped route was introduced to fix for client-role users,
 * reappearing one surface along.
 *
 * Inlining rather than opening the route to share tokens, for three reasons:
 * the bytes then survive being saved or emailed as HTML; there is no second
 * request to fail midway through a print; and the token never rides along in a
 * `Referer` header on a subresource fetch.
 *
 * The cost is honest — base64 is ~33% larger than the raw bytes, so a logo at
 * the 512 KB upload ceiling adds ~683 KB to the document. A wordmark that large
 * is already a mistake; the ceiling is what bounds this.
 *
 * Never throws: a report full of real numbers must not 500 over a logo.
 */
export async function getClientLogoDataUri(
  clientId: string,
): Promise<string | null> {
  try {
    const logo = await getClientLogo(clientId);
    if (!logo) return null;
    return `data:${logo.contentType};base64,${logo.bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The AGENCY's wordmark, inlined for the report.
 *
 * Same reason as the client one: `/api/agency/logo` requires a session and a
 * share link's reader has none, so a linked wordmark renders broken on exactly
 * the document it exists to sign. Bytes go in the HTML.
 *
 * Never throws — a missing signature must not take down a report full of real
 * numbers.
 */
export async function getAgencyLogoDataUri(
  agencyId: string,
): Promise<string | null> {
  try {
    const logo = await getAgencyLogo(agencyId);
    if (!logo) return null;
    return `data:${logo.contentType};base64,${logo.bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export interface BrandingUpdate {
  displayName?: string | null;
  brandColor?: string | null;
  reportContactLine?: string | null;
  brandColorAppliesToDashboard?: boolean;
  clientEditable?: boolean;
  logo?: { bytes: Buffer; contentType: string } | null;
  updatedBy?: string | null;
}

/**
 * Write branding for one client.
 *
 * Only the keys explicitly present are written — never a spread of the whole
 * object. That matters for W3: a client-facing endpoint must be structurally
 * incapable of touching `clientEditable`, and "we only put the allowed keys in
 * the object" is a weaker guarantee than "the writer only ever writes named
 * keys".
 *
 * `brandColor` is normalised HERE rather than at the boundary, so no caller can
 * skip it and store a colour that renders illegibly on one of the two themes.
 */
export async function saveClientBranding(
  clientId: string,
  update: BrandingUpdate,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };

  if ("displayName" in update) set.displayName = emptyToNull(update.displayName);
  if ("reportContactLine" in update) {
    set.reportContactLine = emptyToNull(update.reportContactLine);
  }
  if ("brandColor" in update) {
    set.brandColor = update.brandColor ? normalizeBrandColor(update.brandColor) : null;
  }
  if ("brandColorAppliesToDashboard" in update) {
    set.brandColorAppliesToDashboard = update.brandColorAppliesToDashboard;
  }
  if ("clientEditable" in update) set.clientEditable = update.clientEditable;
  if ("updatedBy" in update) set.updatedBy = update.updatedBy;

  /*
   * 🔴 The INSERT and the UPDATE need DIFFERENT values for `logoVersion`, and
   * conflating them broke every logo upload outright.
   *
   * `logo_version + 1` is correct on the conflict path and invalid on the
   * insert path: Postgres rejects a column reference inside `VALUES`, and
   * Drizzle emits ONE statement, so the whole upsert failed to parse — even
   * when the row already existed and the update branch was the one that would
   * have run. The route then returned its generic write-failure message, which
   * blames an unapplied migration, so the symptom pointed away from the cause.
   *
   * The insert case wants a literal (a first logo is version 1); only the
   * update case wants the increment. As SQL rather than read-then-write, so two
   * concurrent uploads cannot read the same version and write the same number.
   *
   * Bumped on a DELETE too — the URL has to change or a cached image outlives
   * the change that removed it.
   */
  const insertValues: Record<string, unknown> = { ...set };
  if ("logo" in update) {
    set.logoWordmark = update.logo?.bytes ?? null;
    set.logoWordmarkType = update.logo?.contentType ?? null;
    insertValues.logoWordmark = set.logoWordmark;
    insertValues.logoWordmarkType = set.logoWordmarkType;
    insertValues.logoVersion = 1;
    set.logoVersion = sql`${clientBranding.logoVersion} + 1`;
  }

  await db
    .insert(clientBranding)
    .values({ clientId, ...(insertValues as object) })
    .onConflictDoUpdate({ target: clientBranding.clientId, set });
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Agency-side settings write. Staff only, always. */
export async function saveAgencySettings(
  agencyId: string,
  update: {
  agencyName?: string | null;
  agencyMarkMode?: AgencyMarkMode;
  supportEmail?: string | null;
  logo?: { bytes: Buffer; contentType: string } | null;
  },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if ("agencyName" in update) set.agencyName = emptyToNull(update.agencyName);
  if ("agencyMarkMode" in update) set.agencyMarkMode = update.agencyMarkMode;
  if ("supportEmail" in update) set.supportEmail = emptyToNull(update.supportEmail);
  /*
   * 🔴 `logoVersion` is bumped here for the same reason the client one is, and
   * it was missing entirely.
   *
   * `/api/agency/logo` serves the bytes with `Cache-Control: immutable,
   * max-age=31536000` and relies on the `?v=` in its URL changing — its own
   * comment says "bumped on every upload". Nothing bumped it. The settings form
   * increments its LOCAL copy after a save, so the preview updated and the
   * upload looked fine; on the next page load the version came back as 0, the
   * URL was unchanged, and the browser served the previous logo from cache for
   * a year.
   *
   * Split across insert and update for the reason written out on
   * `saveClientBranding` above.
   */
  const insertValues: Record<string, unknown> = { ...set };
  if ("logo" in update) {
    set.logoWordmark = update.logo?.bytes ?? null;
    set.logoWordmarkType = update.logo?.contentType ?? null;
    insertValues.logoWordmark = set.logoWordmark;
    insertValues.logoWordmarkType = set.logoWordmarkType;
    insertValues.logoVersion = 1;
    set.logoVersion = sql`${agencySettings.logoVersion} + 1`;
  }

  await db
    .insert(agencySettings)
    .values({ agencyId, ...(insertValues as object) })
    .onConflictDoUpdate({ target: agencySettings.agencyId, set });
}

export async function getAgencyLogo(agencyId: string): Promise<{
  bytes: Buffer;
  contentType: string;
} | null> {
  const [row] = await db
    .select({
      bytes: agencySettings.logoWordmark,
      contentType: agencySettings.logoWordmarkType,
    })
    .from(agencySettings)
    .where(eq(agencySettings.agencyId, agencyId))
    .limit(1);
  if (!row?.bytes || !row.contentType) return null;
  return { bytes: row.bytes, contentType: row.contentType };
}
