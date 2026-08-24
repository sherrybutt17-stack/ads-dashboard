import { BOOTSTRAP_AGENCY_ID } from "@/db/schema";

/**
 * Who may ride on OUR ad-platform credentials, and who must bring their own.
 *
 * ── The leak this closes ─────────────────────────────────────────────────
 *
 * 🔴 `MetaClient` fell back to `META_SYSTEM_USER_TOKEN` whenever a client had
 * no token of its own, and `getAccessToken` fell back to
 * `GOOGLE_ADS_REFRESH_TOKEN`. In a single-agency tool that is simply how the
 * product works. Opened to sign-up it becomes: **type any ad account id our
 * system user can see, and it verifies, attaches, and starts reporting a
 * stranger's spend.** No exploit needed — the connect wizard does it, and the
 * account id is the only thing the attacker has to guess.
 *
 * Google is worse in one respect. Every agency would ride the same MCC refresh
 * token and the same developer token, so one tenant's abuse suspends API access
 * for everybody, and there is no per-tenant remedy short of rotating a
 * credential the whole platform depends on.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 *
 * The shared credential serves the bootstrap agency ONLY.
 *
 * That is the agency this codebase was built for and is running as today, so
 * nothing about its behaviour changes — the system user token keeps working
 * exactly as it does now. Every agency created after it must supply its own
 * credential, via the OAuth flows that already exist for both platforms.
 *
 * The alternative — an env allowlist of agency ids — was rejected because it
 * would be edited under pressure ("just add them for now"), and the edit is
 * invisible in the code. Being the bootstrap agency is a property of the data,
 * not a setting somebody can widen at 2am.
 */

export function mayUseSharedCredential(agencyId: string): boolean {
  return agencyId === BOOTSTRAP_AGENCY_ID;
}

/**
 * A Meta access token for this agency: its own if it has one, ours if it is
 * allowed ours, and a clear instruction otherwise.
 *
 * Throws rather than returning null on purpose. A caller that got null would
 * have to decide what to do, and the tempting decision — carry on and let the
 * API 400 — produces "Meta returned an error" in the health panel instead of
 * "this account is not connected", which is the difference between a fixable
 * message and a mystery.
 */
export function metaTokenFor(agencyId: string, override?: string | null): string {
  if (override) return override;
  const shared = process.env.META_SYSTEM_USER_TOKEN;
  if (shared && mayUseSharedCredential(agencyId)) return shared;
  throw new Error(
    "This agency has no Facebook connection of its own. Connect a Facebook " +
      "account from the client's setup page before adding an ad account.",
  );
}

/** As `metaTokenFor`, for a Google Ads refresh token. */
export function googleRefreshTokenFor(
  agencyId: string,
  override?: string | null,
): string {
  if (override) return override;
  const shared = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  if (shared && mayUseSharedCredential(agencyId)) return shared;
  throw new Error(
    "This agency has no Google Ads connection of its own. Connect a Google " +
      "account from the client's setup page before adding a customer id.",
  );
}
