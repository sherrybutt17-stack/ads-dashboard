import type { AdPlatform } from "@/lib/metrics/queries";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  contacts,
  fbDailyMetrics,
  googleAdAccounts,
  googleDailyMetrics,
  tiktokAdAccounts,
  tiktokDailyMetrics,
  metaAdAccounts,
  opportunities,
  pipelineStages,
  stageTransitions,
  syncRuns,
  REQUIRED_CANONICAL_STAGES,
  type Client,
} from "@/db/schema";
import { getGhlClientAsync } from "@/lib/ghl/process";
import { getInstallationForClient } from "@/lib/ghl/oauth";
import { activeAdAccounts, metaClientForAccount } from "@/lib/meta/accounts";
import { tokenExpiryState } from "@/lib/meta/oauth";
import {
  activeGoogleAccounts,
  googleClientForAccount,
} from "@/lib/google/accounts";
import { activeTiktokAccounts } from "@/lib/tiktok/accounts";
import { TiktokApiError, TiktokClient } from "@/lib/tiktok/client";
import { decryptNullable } from "@/lib/crypto";
import type { GoogleAdAccount, TiktokAdAccount } from "@/db/schema";
import { PLATFORM_LABEL } from "@/lib/platforms";
import {
  describeFailure,
  describeStoredFailure,
  redactDiagnostics,
  type RedactedFailure,
} from "@/lib/health-errors";
import { trailingWindowInclusive } from "@/lib/dates";
import { formatCurrency } from "@/lib/metrics/compute";
// Shared with the dashboard's own pipe status, so the checklist and the panels
// can never disagree about whether a client is behind.
import { getAdPipeStatus, FULL_SYNC_KINDS } from "@/lib/metrics/pipe-status";

/**
 * Connection health checks.
 *
 * This module exists because of how the system it replaces failed. The source
 * spreadsheet had six of seven report blocks completely empty, SHOWN stuck at 0
 * for its entire history alongside three closed-won deals, and two months of
 * leads recorded against $0.00 spend — and none of it was noticed, because a
 * broken pipe and a quiet month look identical in a grid of zeros.
 *
 * So the central distinction here is AMBER vs RED:
 *   - red   = we cannot get data (broken credential, unreachable account)
 *   - amber = we can get data, and the data says nothing is happening
 *   - green = flowing
 *
 * Collapsing amber into green hides dead pipes. Collapsing it into red trains
 * people to ignore alarms. Both failures are how you end up with a dashboard
 * nobody trusts.
 */

export type HealthLevel = "green" | "amber" | "red" | "unknown";

export interface HealthCheck {
  id: string;
  label: string;
  level: HealthLevel;
  message: string;
  /** What to do about it, when there is something to do. */
  hint?: string;
  /**
   * The raw upstream error, for superadmins only.
   *
   * Never populated for an agency or client viewer — see `health-errors.ts` for
   * what these strings turn out to contain. It exists at all because when the
   * classifier returns `unknown` the raw text is the only remaining lead, and
   * the alternative is querying the database by hand while a customer waits.
   */
  diagnostic?: string;
}

export interface HealthReport {
  clientId: string;
  overall: HealthLevel;
  checks: HealthCheck[];
  checkedAt: string;
}

/**
 * Who is reading the checklist.
 *
 * 🔴 Defaults to redacted. A caller that forgets this argument gets the safe
 * answer, so the failure mode of the next person to add a surface is a missing
 * diagnostic rather than a leaked one — the same principle that made
 * `getClientById` a compile error instead of a code-review item.
 */
export interface HealthViewer {
  /** True only for `staff` / `superadmin`. Agency owners are customers now. */
  superadmin?: boolean;
}

const WEBHOOK_QUIET_HOURS = 72;

export async function runHealthChecks(
  client: Client,
  viewer: HealthViewer = {},
): Promise<HealthReport> {
  const checks: HealthCheck[] = [];

  checks.push(await checkGhlToken(client));
  checks.push(await checkStageMapping(client));
  checks.push(await checkUnmappedStages(client));
  checks.push(await checkWebhookAlive(client));

  /*
   * 🔴 Every platform's checks are opt-in, INCLUDING Meta's.
   *
   * Google's and TikTok's already were, so that a Meta-only client never saw a
   * red "Google not connected" that really just meant "not using Google". Meta
   * was exempt from its own rule, which pinned a Google-only client to red
   * forever: "No ad accounts connected", plus an ad-level attribution check
   * looking for a `meta_ad_id` that Google can never produce — `contacts` has
   * no equivalent column for it. Since the report takes the WORST level, their
   * overall badge could never be cleared by any action available to them, and a
   * permanent alarm is an ignored checklist.
   *
   * The exception is the case where skipping would hide a real problem: a
   * client with NO platform connected at all still gets the Meta checks, so
   * "connect an ad account" is said out loud rather than passing in silence.
   */
  const metaAccounts = await activeAdAccounts(client.id);
  const googleAccounts = await activeGoogleAccounts(client.id);
  const tiktokAccounts = await activeTiktokAccounts(client.id);
  const noPlatformAtAll =
    metaAccounts.length === 0 &&
    googleAccounts.length === 0 &&
    tiktokAccounts.length === 0;

  if (metaAccounts.length > 0 || noPlatformAtAll) {
    checks.push(await checkMetaToken(client));
    checks.push(await checkMetaFreshness(client));
  }

  if (googleAccounts.length > 0) {
    checks.push(await checkGoogleToken(client, googleAccounts));
    checks.push(await checkGoogleFreshness(client));
  }

  /*
   * TikTok, on the same opt-in rule — and it needed these checks more than
   * either sibling did, because until now `health.ts` did not mention TikTok at
   * all. A TikTok pipe could die in silence: no token check, no freshness
   * check, and a dashboard that reads $0, which is a legitimate state for a
   * paused advertiser. Exactly the failure this checklist exists to catch.
   */
  if (tiktokAccounts.length > 0) {
    checks.push(await checkTiktokToken(client, tiktokAccounts));
    checks.push(await checkTiktokFreshness(client));
  }

  checks.push(await checkSpendLeadCoherence(client));
  checks.push(await checkAttribution(client));
  // Ad-level attribution is a Meta-only capability — see the note on the check.
  if (metaAccounts.length > 0) {
    checks.push(await checkAdAttribution(client));
  }
  checks.push(await checkDealValues(client));

  return {
    clientId: client.id,
    overall: worst(checks.map((c) => c.level)),
    /*
     * 🔴 One chokepoint, deliberately.
     *
     * The individual checks always attach `diagnostic`; this line is the only
     * thing that decides whether it leaves the module. The alternative — each
     * check consulting the viewer — is five independent decisions and five
     * chances for the sixth check somebody adds next year to forget. Here
     * forgetting is impossible: a new check that sets `diagnostic` is stripped
     * by a line it never has to know about.
     */
    checks: redactDiagnostics(checks, viewer),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * The unredacted string, for the superadmin-only `diagnostic` field.
 *
 * Truncated: some of these are an entire JSON response body, and a health row
 * is a one-line surface. The head of the message is where the cause lives.
 */
function rawText(err: unknown, limit = 400): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * When several accounts fail at once, report the cause they share.
 *
 * A list of account names says WHICH connections are down; the shared cause
 * says why, and that is the difference between "reconnect these three" and
 * "wait, Meta is throttling us".
 *
 * Mixed causes return null and the caller keeps its generic wording. Picking
 * the first cause would describe one account and be confidently wrong about the
 * rest — and "your sign-in expired" attached to an account that was merely rate
 * limited is how you get someone re-authorising a healthy connection.
 */
function sharedFailure(failures: RedactedFailure[]): RedactedFailure | null {
  const [first] = failures;
  if (!first) return null;
  return failures.every((f) => f.cause === first.cause) ? first : null;
}

function worst(levels: HealthLevel[]): HealthLevel {
  if (levels.includes("red")) return "red";
  if (levels.includes("amber")) return "amber";
  if (levels.includes("unknown")) return "unknown";
  return "green";
}

/* ------------------------------------------------------------------ */

async function checkGhlToken(client: Client): Promise<HealthCheck> {
  const base = { id: "ghl_token", label: "GoHighLevel connection" };

  const hasCredential =
    client.ghlAuthMethod === "oauth" || Boolean(client.ghlTokenEncrypted);
  if (!hasCredential || !client.ghlLocationId) {
    return {
      ...base,
      level: "red",
      message: "Not connected",
      hint: "Install the marketplace app, or add a Private Integration Token, in Setup.",
    };
  }

  // An uninstalled app is a distinct failure from a bad token, and the fix is
  // different — say which it is rather than reporting a generic error.
  if (client.ghlAuthMethod === "oauth") {
    const installation = await getInstallationForClient(client.id);
    if (!installation) {
      return {
        ...base,
        level: "red",
        message: "No app installation found",
        hint: "Re-install the marketplace app on this sub-account.",
      };
    }
    if (installation.uninstalledAt) {
      return {
        ...base,
        level: "red",
        message: "App was uninstalled",
        hint: "The client removed the app. Stage changes are no longer being received — reinstall to resume recording.",
      };
    }
  }

  const ghl = await getGhlClientAsync(client);
  if (!ghl) {
    return {
      ...base,
      level: "red",
      message: "No usable credential (token refresh may have failed)",
      hint: "GHL refresh tokens are single-use; if one was lost the app must be reinstalled.",
    };
  }
  try {
    const loc = await ghl.getLocation(client.ghlLocationId);
    return {
      ...base,
      level: "green",
      message: `Connected to ${loc.name ?? client.ghlLocationId} (${
        client.ghlAuthMethod === "oauth" ? "app install" : "private token"
      })`,
    };
  } catch (err) {
    /*
     * Classified rather than surfaced raw. `GhlApiError` interpolates the whole
     * response body AND the request path — and the path carries the location
     * id, so the unredacted version put one sub-account's identifier on screen
     * as the headline of a failed check.
     */
    const failure = describeFailure(err, "ghl");
    return {
      ...base,
      level: "red",
      message: failure.message,
      hint: failure.hint,
      diagnostic: rawText(err),
    };
  }
}

/**
 * Every canonical stage should have at least one GHL stage bound to it.
 *
 * An unmapped stage silently zeroes that row of the funnel forever — which is
 * exactly what SHOWN = 0 looked like in the old sheet while wins were being
 * recorded downstream of it.
 */
async function checkStageMapping(client: Client): Promise<HealthCheck> {
  const base = { id: "stage_mapping", label: "Pipeline stage mapping" };
  const rows = await db
    .select({ canonical: pipelineStages.canonicalStage })
    .from(pipelineStages)
    .where(eq(pipelineStages.clientId, client.id));

  if (rows.length === 0) {
    return {
      ...base,
      level: "red",
      message: "No stages imported yet",
      hint: "Run the stage mapping step in Setup.",
    };
  }

  const mapped = new Set(rows.map((r) => r.canonical).filter(Boolean));
  // Required, not every canonical stage: `disqualified` is optional, and a
  // pipeline with no junk stage is a valid pipeline, not a broken one.
  const missing = REQUIRED_CANONICAL_STAGES.filter((s) => !mapped.has(s));

  if (missing.length === 0) {
    return {
      ...base,
      level: "green",
      message: `All ${REQUIRED_CANONICAL_STAGES.length} stages mapped${
        mapped.has("disqualified") ? " + disqualified" : ""
      }`,
    };
  }
  return {
    ...base,
    level: "amber",
    message: `${missing.length} unmapped: ${missing.join(", ")}`,
    hint: "Any stage left unmapped will read as zero in the funnel forever.",
  };
}

/** A stage the client added in GHL after onboarding. */
async function checkUnmappedStages(client: Client): Promise<HealthCheck> {
  const base = { id: "unknown_stages", label: "Unrecognised stages" };
  const rows = await db
    .select({ id: pipelineStages.ghlStageId, name: pipelineStages.ghlStageName })
    .from(pipelineStages)
    .where(
      and(
        eq(pipelineStages.clientId, client.id),
        eq(pipelineStages.discoveredFromWebhook, true),
        sql`${pipelineStages.canonicalStage} IS NULL`,
      ),
    );

  if (rows.length === 0) {
    return { ...base, level: "green", message: "None" };
  }
  return {
    ...base,
    level: "amber",
    message: `${rows.length} stage(s) seen in webhooks but not mapped`,
    hint: "Their transitions ARE being recorded and can be reclassified — map them in Setup.",
  };
}

async function checkWebhookAlive(client: Client): Promise<HealthCheck> {
  const base = { id: "webhook", label: "GHL webhook" };

  if (!client.firstWebhookAt) {
    return {
      ...base,
      level: "red",
      message: "No event ever received",
      hint: "The workflow webhook is not installed, or points at the wrong URL. Until it fires, no funnel history is being recorded — and it cannot be backfilled later.",
    };
  }

  const hoursSince = client.lastWebhookAt
    ? (Date.now() - client.lastWebhookAt.getTime()) / 3_600_000
    : Infinity;

  if (hoursSince > WEBHOOK_QUIET_HOURS) {
    return {
      ...base,
      level: "amber",
      message: `Quiet for ${Math.floor(hoursSince)}h`,
      hint: "Normal if the client has had no lead activity. Suspicious if ads are running.",
    };
  }
  return {
    ...base,
    level: "green",
    message: `Last event ${formatAgo(hoursSince)} ago`,
  };
}

/**
 * Meta connectivity across ALL of a client's ad accounts.
 *
 * Each account is checked independently — one broken account among several
 * should read as a specific problem, not drag the whole client to red or hide
 * behind a green. A single unreachable account is amber (partial data); every
 * account unreachable is red.
 */
async function checkMetaToken(client: Client): Promise<HealthCheck> {
  const base = { id: "meta_token", label: "Meta ad accounts" };
  const accounts = await activeAdAccounts(client.id);
  if (accounts.length === 0) {
    return { ...base, level: "red", message: "No ad accounts connected" };
  }

  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        const meta = metaClientForAccount(account, client.agencyId);
        const acct = await meta.getAdAccount(account.adAccountId);
        return { ok: true as const, name: acct.name ?? account.adAccountId };
      } catch (err) {
        return {
          ok: false as const,
          name: account.accountName ?? account.adAccountId,
          failure: describeFailure(err, "meta"),
          raw: rawText(err),
        };
      }
    }),
  );

  const broken = results.filter((r) => !r.ok);
  if (broken.length === 0) {
    /*
     * 🔴 Reachable today is not the same as reachable next month.
     *
     * An account connected through "Continue with Facebook" carries a USER
     * token, which lasts ~60 days and then stops; the system user token behind
     * a pasted account id never expires. Both read identically above — the API
     * call succeeds — right until the morning it does not.
     *
     * So a token inside its warning window downgrades an otherwise green check
     * to amber while there is still time to act, and one already past its date
     * is red even though the call may still have worked. Re-authorising can
     * need the client rather than the agency, which is why the window is two
     * weeks rather than two days.
     */
    const lapsing = accounts
      .map((a) => ({ account: a, state: tokenExpiryState(a.tokenExpiresAt) }))
      .filter((x) => x.state === "expiring" || x.state === "expired");

    if (lapsing.length > 0) {
      const dead = lapsing.filter((x) => x.state === "expired");
      const worst = dead.length > 0 ? dead : lapsing;
      const names = worst
        .map((x) => x.account.accountName ?? `act_${x.account.adAccountId}`)
        .join(", ");
      const when = worst[0].account.tokenExpiresAt;
      return {
        ...base,
        level: dead.length > 0 ? "red" : "amber",
        message:
          dead.length > 0
            ? `Facebook sign-in expired for ${names}`
            : `Facebook sign-in for ${names} expires ${
                when ? when.toISOString().slice(0, 10) : "soon"
              }`,
        hint: "Reconnect with Continue with Facebook on this page — spend stops updating when it lapses.",
      };
    }

    return {
      ...base,
      level: "green",
      message:
        accounts.length === 1
          ? results[0].name
          : `${accounts.length} accounts connected`,
    };
  }
  /*
   * 🔴 The hint used to read "Check the system user has access, or the
   * per-account token override."
   *
   * Written when the only reader was us, and it describes OUR shared system
   * user token to an agency that has no relationship with it — an instruction
   * they cannot follow, about infrastructure they should not know exists. The
   * classified cause replaces it: same diagnosis, addressed to whoever is
   * actually reading.
   */
  const shared = sharedFailure(broken.map((b) => b.failure));
  const diagnostic = broken.map((b) => `${b.name}: ${b.raw}`).join(" · ");

  if (broken.length === accounts.length) {
    return {
      ...base,
      level: "red",
      message: shared
        ? shared.message
        : `All ${accounts.length} ad account(s) unreachable`,
      hint: shared?.hint,
      diagnostic,
    };
  }
  return {
    ...base,
    level: "amber",
    message: `${broken.length} of ${accounts.length} accounts unreachable: ${broken
      .map((b) => b.name)
      .join(", ")}`,
    hint: shared
      ? `${shared.hint} That account's spend is missing from the totals until it reconnects.`
      : "That account's spend is missing from the totals until it reconnects.",
    diagnostic,
  };
}

/**
 * Freshness, derived from the SAME state machine the dashboard panels use.
 *
 * Sharing it is the point: a checklist that says "last sync failed" over a
 * dashboard that says the data is current gives the operator two contradictory
 * answers to one question, and they will believe whichever they saw last. Here
 * the shared derivation decides trust, and this function adds the one thing a
 * checklist should say that a chart should not — that runs are failing even
 * though the figures happen to be current.
 *
 * Reads full syncs only, never `*_intraday`: the intraday refresh fires on any
 * page view, so counting it let a page load stand in for the nightly
 * reconciliation — a client someone opens each morning read "synced 4m ago"
 * while the trailing-28-day re-pull had been dead for a week.
 */
async function checkFreshness(
  client: Client,
  platform: AdPlatform,
): Promise<HealthCheck> {
  /*
   * 🔴 Both of these were ternaries on `=== "google"`, so TikTok fell into
   * Meta's else-branch: the TikTok freshness row was labelled "Meta data
   * freshness" and read Meta's `meta_daily` runs. It reported a healthy Meta
   * cron as TikTok's, which is the one answer worse than reporting nothing.
   *
   * The label now comes from the shared map, and the sync kind from
   * `FULL_SYNC_KINDS` — the same record `getAdPipeStatus` reads, so the two
   * halves of this function cannot drift onto different tables again.
   */
  const name = PLATFORM_LABEL[platform];
  const base = { id: `${platform}_fresh`, label: `${name} data freshness` };

  const [pipe, [lastTerminal]] = await Promise.all([
    getAdPipeStatus(client, platform),
    db
      .select({ status: syncRuns.status, error: syncRuns.error })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.clientId, client.id),
          inArray(syncRuns.kind, [...FULL_SYNC_KINDS[platform]]),
          sql`${syncRuns.status} <> 'running'`,
        ),
      )
      .orderBy(desc(syncRuns.startedAt))
      .limit(1),
  ]);

  const ago = pipe.hoursSinceSuccess;

  switch (pipe.state) {
    case "not_connected":
      // The token check already reports this as red; saying it twice would make
      // one missing account look like two separate faults.
      return { ...base, level: "amber", message: "No ad account connected" };

    case "backfilling":
      /*
       * Amber, not green and not red. Nothing is broken — a first import is
       * running right now — but there is no data behind this client yet, and
       * green would say there is. The distinction the whole checklist turns on:
       * amber means "we can see it and it says nothing is here", which is
       * exactly true while the first pull is still in flight.
       */
      return {
        ...base,
        level: "amber",
        message: `First ${name} import running`,
        hint: "Started within the last half hour. This resolves itself; re-test in a few minutes.",
      };

    case "never_synced":
      return {
        ...base,
        level: "amber",
        message: "Never fully synced",
        hint: `The trailing-window ${name} reconciliation has not run for this client yet.`,
      };

    case "unreachable": {
      /*
       * 🔴 This read `Last sync failed: ${pipe.lastError}`.
       *
       * `sync_runs.error` is the widest of all these surfaces, because it holds
       * the stringified form of whatever killed the job — a Graph error naming
       * our app id, a Google payload carrying our MCC, or a Postgres failure
       * that was never written for anyone to read. It went out as the headline
       * of a red row.
       */
      const failure = describeStoredFailure(pipe.lastError, platform);
      return {
        ...base,
        level: "red",
        message: failure ? `Last sync failed — ${failure.message}` : "Last sync failed",
        hint: [
          failure?.hint,
          "Nothing has synced successfully since, so the figures on the dashboard are frozen at their last good values.",
        ]
          .filter(Boolean)
          .join(" "),
        diagnostic: pipe.lastError ?? undefined,
      };
    }

    case "stale":
      return {
        ...base,
        level: "amber",
        message: `Last synced ${formatAgo(ago ?? 0)} ago`,
        hint: `The nightly ${name} cron may not be running.`,
      };

    case "live":
      // Current data, but the most recent completed run still failed. Worth an
      // amber here — it is the early warning before it becomes red — while the
      // dashboard correctly keeps showing the numbers without an alarm.
      if (lastTerminal?.status === "failed") {
        // Same redaction as the `unreachable` branch above, and for the same
        // reason — this hint was the raw `sync_runs.error` with nothing around it.
        const failure = describeStoredFailure(lastTerminal.error, platform);
        return {
          ...base,
          level: "amber",
          message: `Synced ${formatAgo(ago ?? 0)} ago, but the last run failed`,
          hint: failure ? `${failure.message}. ${failure.hint ?? ""}`.trim() : undefined,
          diagnostic: lastTerminal.error ?? undefined,
        };
      }
      return { ...base, level: "green", message: `Synced ${formatAgo(ago ?? 0)} ago` };
  }
}

const checkMetaFreshness = (client: Client) => checkFreshness(client, "meta");

/**
 * Google Ads connectivity across all of a client's linked customer accounts —
 * the sibling of `checkMetaToken`. One unreachable account among several is
 * amber (partial data); every account unreachable is red.
 */
async function checkGoogleToken(
  client: Client,
  accounts: GoogleAdAccount[],
): Promise<HealthCheck> {
  const base = { id: "google_token", label: "Google Ads accounts" };
  if (accounts.length === 0) {
    return { ...base, level: "red", message: "No ad accounts connected" };
  }

  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        const google = googleClientForAccount(account, client.agencyId);
        const info = await google.getCustomer(account.customerId);
        return { ok: true as const, name: info.descriptiveName ?? account.customerId };
      } catch (err) {
        return {
          ok: false as const,
          name: account.accountName ?? account.customerId,
          failure: describeFailure(err, "google"),
          raw: rawText(err),
        };
      }
    }),
  );

  const broken = results.filter((r) => !r.ok);
  if (broken.length === 0) {
    return {
      ...base,
      level: "green",
      message:
        accounts.length === 1
          ? results[0].name
          : `${accounts.length} accounts connected`,
    };
  }

  /*
   * 🔴 The worst of the three old hints: "Check the MCC link is accepted, the
   * developer token is valid, or the per-account refresh token override."
   *
   * Every noun in it is ours. The MCC is our manager account, the developer
   * token is our Google Ads API credential, and one agency abusing it suspends
   * everyone — which makes its approval state exactly the thing not to narrate
   * to tenants. Google's own error bodies compound it: `google/client.ts`
   * interpolates the entire response, and those payloads carry `loginCustomerId`
   * verbatim.
   */
  const shared = sharedFailure(broken.map((b) => b.failure));
  const diagnostic = broken.map((b) => `${b.name}: ${b.raw}`).join(" · ");

  if (broken.length === accounts.length) {
    return {
      ...base,
      level: "red",
      message: shared
        ? shared.message
        : `All ${accounts.length} account(s) unreachable`,
      hint: shared?.hint,
      diagnostic,
    };
  }
  return {
    ...base,
    level: "amber",
    message: `${broken.length} of ${accounts.length} accounts unreachable: ${broken
      .map((b) => b.name)
      .join(", ")}`,
    hint: shared
      ? `${shared.hint} That account's spend is missing from the totals until it reconnects.`
      : "That account's spend is missing from the totals until it reconnects.",
    diagnostic,
  };
}

const checkGoogleFreshness = (client: Client) => checkFreshness(client, "google");

/**
 * TikTok advertiser connectivity — the third sibling of `checkMetaToken`.
 *
 * ── 🔴 Why a revoked TikTok grant reads differently ───────────────────
 *
 * Meta's version warns on an approaching expiry, because a "Continue with
 * Facebook" token lapses after ~60 days. TikTok tokens do not expire and there
 * is no refresh token, so there is no date to warn about and no amber window to
 * act inside — the connection is either live or it was revoked, with nothing in
 * between and no notice.
 *
 * That makes the reachability call the ONLY warning that exists here, which is
 * why TikTok error 40105 is named explicitly rather than folded into a generic
 * "unreachable": it means the authorizing user lost access to the advertiser,
 * and the fix is a person re-authorizing, not a retry.
 */
async function checkTiktokToken(
  client: Client,
  accounts: TiktokAdAccount[],
): Promise<HealthCheck> {
  const base = { id: "tiktok_token", label: "TikTok advertisers" };
  if (accounts.length === 0) {
    return { ...base, level: "red", message: "No advertisers connected" };
  }

  const results = await Promise.all(
    accounts.map(async (account) => {
      const name = account.advertiserName ?? account.advertiserId;
      const token = decryptNullable(account.accessTokenEncrypted);
      const failed = (err: unknown, revoked: boolean) => ({
        ok: false as const,
        name,
        revoked,
        failure: describeFailure(err, "tiktok"),
        raw: rawText(err),
      });
      if (!token) return failed("No TikTok access token.", false);
      try {
        const info = await new TiktokClient(token).getAdvertiser(account.advertiserId);
        if (!info) {
          return failed("Advertiser not visible to this authorization", true);
        }
        return { ok: true as const, name: info.advertiser_name ?? name };
      } catch (err) {
        // 40105 is documented and specific; everything else stays generic on
        // purpose, because a wrong classification sends the operator to
        // re-authorize an account that was merely rate-limited.
        return failed(err, err instanceof TiktokApiError && err.isAuth);
      }
    }),
  );

  const broken = results.filter((r) => !r.ok);
  if (broken.length === 0) {
    return {
      ...base,
      level: "green",
      message:
        accounts.length === 1
          ? results[0].name
          : `${accounts.length} advertisers connected`,
    };
  }

  /*
   * The revoked wording is kept as a special case rather than folded into the
   * classifier, because it is the one TikTok failure whose CAUSE is worth
   * spelling out: tokens here never expire and there is no refresh, so a
   * revocation arrives with no warning and looks exactly like an outage.
   */
  const shared = sharedFailure(broken.map((b) => b.failure));
  const hint = broken.some((b) => b.revoked)
    ? "The TikTok account that authorised this lost access to the advertiser. Reconnect with Continue with TikTok on the setup page."
    : (shared?.hint ??
      "That advertiser's spend is missing from the totals until it reconnects.");
  const diagnostic = broken.map((b) => `${b.name}: ${b.raw}`).join(" · ");

  if (broken.length === accounts.length) {
    return {
      ...base,
      level: "red",
      message: `All ${accounts.length} advertiser(s) unreachable`,
      hint,
      diagnostic,
    };
  }
  return {
    ...base,
    level: "amber",
    message: `${broken.length} of ${accounts.length} advertisers unreachable: ${broken
      .map((b) => b.name)
      .join(", ")}`,
    hint,
    diagnostic,
  };
}

const checkTiktokFreshness = (client: Client) => checkFreshness(client, "tiktok");

/**
 * The check the old spreadsheet most needed and did not have.
 *
 * Leads arriving with zero spend, or spend with no leads at all, are both
 * incoherent states that indicate a broken feed rather than a bad month.
 */
/**
 * Spend on every platform this client actually runs, with the currency each
 * reports in.
 *
 * 🔴 Three separate reads rather than one sum, for two reasons that both bite.
 *
 * `fb_daily_metrics` stores the SAME money at up to three levels — account,
 * campaign and ad — so an unfiltered SUM reports two to three times the real
 * spend, and the figure moves whenever the mix of levels the last sync wrote
 * changes. Every other query in the app filters to `campaign`; this one now
 * does too.
 *
 * And the currencies are not interchangeable. A client running Meta in GBP and
 * Google in USD has no single total, so the caller is handed the parts and
 * decides what can honestly be added.
 */
async function platformSpend(
  client: Client,
  window: { startKey: string },
): Promise<{ platform: AdPlatform; spend: number; currency: string }[]> {
  const [meta, google, tiktok] = await Promise.all([
    db
      .select({ spend: sql<string>`COALESCE(SUM(${fbDailyMetrics.spend}), 0)` })
      .from(fbDailyMetrics)
      .where(
        and(
          eq(fbDailyMetrics.clientId, client.id),
          // The level filter. Without it the same spend is counted once per level.
          eq(fbDailyMetrics.level, "campaign"),
          gte(fbDailyMetrics.date, window.startKey),
        ),
      ),
    db
      .select({
        spend: sql<string>`COALESCE(SUM(${googleDailyMetrics.spend}), 0)`,
        currency: sql<string | null>`MAX(${googleDailyMetrics.currency})`,
      })
      .from(googleDailyMetrics)
      .where(
        and(
          eq(googleDailyMetrics.clientId, client.id),
          gte(googleDailyMetrics.date, window.startKey),
        ),
      ),
    db
      .select({
        spend: sql<string>`COALESCE(SUM(${tiktokDailyMetrics.spend}), 0)`,
        currency: sql<string | null>`MAX(${tiktokDailyMetrics.currency})`,
      })
      .from(tiktokDailyMetrics)
      .where(
        and(
          eq(tiktokDailyMetrics.clientId, client.id),
          gte(tiktokDailyMetrics.date, window.startKey),
        ),
      ),
  ]);

  const fallback = client.metaCurrency ?? "USD";
  return (
    [
      { platform: "meta" as const, spend: Number(meta[0]?.spend ?? 0), currency: fallback },
      {
        platform: "google" as const,
        spend: Number(google[0]?.spend ?? 0),
        currency: google[0]?.currency ?? fallback,
      },
      {
        platform: "tiktok" as const,
        spend: Number(tiktok[0]?.spend ?? 0),
        currency: tiktok[0]?.currency ?? fallback,
      },
    ]
      // A platform with no rows is not connected, or not spending; either way it
      // contributes nothing and naming it would only add noise.
      .filter((p) => p.spend > 0)
  );
}

/**
 * Render the spend side of the verdict without ever adding two currencies.
 *
 * One currency across the contributing platforms is one figure. More than one
 * is reported side by side — a client running Meta in GBP and Google in USD is
 * owed two numbers, not an invented third.
 */
function describeSpend(
  parts: { platform: AdPlatform; spend: number; currency: string }[],
): string {
  const currencies = new Set(parts.map((p) => p.currency));
  if (currencies.size <= 1) {
    const total = parts.reduce((a, p) => a + p.spend, 0);
    return formatCurrency(total, parts[0]?.currency ?? "USD");
  }
  return parts
    .map((p) => `${formatCurrency(p.spend, p.currency)} ${PLATFORM_LABEL[p.platform]}`)
    .join(" + ");
}

/**
 * Do the money and the leads tell the same story?
 *
 * The check named in the plan after the exact corruption in the source sheet:
 * 25 leads recorded against $0.00 spend, sitting unremarked for two months.
 *
 * 🔴 It reads EVERY platform, not just Meta. A client running Google or TikTok
 * has no `fb_daily_metrics` rows at all, so a Meta-only sum reads zero and this
 * check would report "N leads recorded against $0.00 spend" — a red alarm, and
 * suppressed cost metrics, on a client whose pipes are all working. Crying wolf
 * here is not a lesser failure than missing the real thing; it is how people
 * learn to scroll past the checklist.
 */
async function checkSpendLeadCoherence(client: Client): Promise<HealthCheck> {
  const base = { id: "coherence", label: "Spend / lead coherence" };
  const window = trailingWindowInclusive(30, client.timezone);

  const [parts, leadRows] = await Promise.all([
    platformSpend(client, window),
    db
      .select({
        leads: sql<number>`COUNT(DISTINCT ${stageTransitions.opportunityId})::int`,
      })
      .from(stageTransitions)
      .where(
        and(
          eq(stageTransitions.clientId, client.id),
          eq(stageTransitions.toCanonical, "new_lead"),
          gte(stageTransitions.changedAt, window.startUtc),
        ),
      ),
  ]);

  // Positivity only — safe across currencies in a way a comparison would not be.
  const spending = parts.length > 0;
  const leads = Number(leadRows[0]?.leads ?? 0);

  if (!spending && leads === 0) {
    return {
      ...base,
      level: "amber",
      message: "No spend and no leads in 30 days — ads appear paused",
      hint: "This is a deliberate 'nothing is happening' state, not an error.",
    };
  }
  if (!spending && leads > 0) {
    return {
      ...base,
      level: "red",
      message: `${leads} leads recorded against no spend on any platform`,
      hint: "Either an ad platform's spend feed is broken, or these leads are not paid-acquired. Cost-per metrics are being suppressed until this resolves.",
    };
  }
  if (spending && leads === 0) {
    return {
      ...base,
      level: "amber",
      message: `${describeSpend(parts)} spent, zero leads reached the CRM`,
      hint: "Check the lead form, the landing page, and that the GHL workflow is firing.",
    };
  }
  return {
    ...base,
    level: "green",
    message: `${describeSpend(parts)} spend, ${leads} leads`,
  };
}

/**
 * Is UTM attribution actually reaching contacts, on any platform they run?
 *
 * GHL does not natively store ad-platform ids, so per-campaign cost breakdowns
 * depend entirely on URL parameters being present on the live ads. A setup that
 * was intended but never applied looks exactly like a client with no campaigns.
 */
async function checkAttribution(client: Client): Promise<HealthCheck> {
  const base = { id: "attribution", label: "Campaign attribution" };
  const window = trailingWindowInclusive(30, client.timezone);

  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      /*
       * 🔴 Any platform's campaign id counts. `parseAttribution` routes each id
       * to EXACTLY ONE platform's column — a Google lead's campaign id lands in
       * `google_campaign_id` and deliberately never in `meta_campaign_id`,
       * because guessing would move that lead's whole pipeline value to the
       * wrong platform's cost-per-lead. Counting only the Meta column therefore
       * reported a perfectly attributed Google client as entirely unattributed,
       * under a hint telling them to add URL parameters they already had.
       */
      attributed: sql<number>`COUNT(COALESCE(
        ${contacts.metaCampaignId}, ${contacts.googleCampaignId}, ${contacts.tiktokCampaignId}
      ))::int`,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.clientId, client.id),
        gte(contacts.createdAt, window.startUtc),
      ),
    );

  const total = Number(row?.total ?? 0);
  const attributed = Number(row?.attributed ?? 0);

  if (total === 0) {
    return { ...base, level: "amber", message: "No contacts in the last 30 days" };
  }
  if (attributed === 0) {
    return {
      ...base,
      level: "amber",
      message: `0 of ${total} contacts carry a campaign id`,
      hint: "Add URL parameters to the ads (campaign_id, ad_id, ad_group_id). Without them, totals are accurate but per-campaign cost cannot be split.",
    };
  }
  const pct = Math.round((attributed / total) * 100);
  return {
    ...base,
    level: pct >= 60 ? "green" : "amber",
    message: `${attributed} of ${total} contacts attributed (${pct}%)`,
    hint: pct < 60 ? "Leads predating the UTM setup stay unattributed." : undefined,
  };
}

/**
 * Is the AD id reaching contacts — the one thing creative-level revenue needs?
 *
 * Deliberately separate from `checkAttribution`, which passes on a campaign id.
 * These are different pipes with different fixes and different consequences:
 *
 *   · campaign id missing → per-campaign cost cannot be split
 *   · **ad id missing → "which creative brings customers" cannot be answered at
 *     all**, and the creative grid's revenue column stays withheld
 *
 * Folding the second into the first would let a client see a green
 * "attribution" tick while the strongest thing in the product silently computes
 * nothing — which is exactly the class of silent gap this checklist exists for.
 *
 * Measured live on 2026-08-12: 1 of 1,595 contacts carried an ad id, and 0 of 64
 * closed-won deals did. So this reads red today, correctly.
 *
 * Amber, not red, when nothing is running: no leads means no evidence either way.
 */
async function checkAdAttribution(client: Client): Promise<HealthCheck> {
  const base = { id: "ad_attribution", label: "Ad-level attribution" };
  const window = trailingWindowInclusive(30, client.timezone);

  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      withAd: sql<number>`COUNT(${contacts.metaAdId})::int`,
    })
    .from(contacts)
    .where(
      and(eq(contacts.clientId, client.id), gte(contacts.createdAt, window.startUtc)),
    );

  const total = Number(row?.total ?? 0);
  const withAd = Number(row?.withAd ?? 0);

  if (total === 0) {
    return { ...base, level: "amber", message: "No contacts in the last 30 days" };
  }

  const hint =
    "GoHighLevel has no native field for a Meta ad id. Add ad_id={{ad.id}} to each ad's URL parameters — leads already in the system cannot be traced retroactively.";

  if (withAd === 0) {
    return {
      ...base,
      level: "red",
      message: `0 of ${total} leads carry an ad id`,
      hint: `${hint} Until then, per-creative revenue and cost-per-customer cannot be computed.`,
    };
  }

  const pct = Math.round((withAd / total) * 100);
  return {
    ...base,
    level: pct >= 60 ? "green" : "amber",
    message: `${withAd} of ${total} leads carry an ad id (${pct}%)`,
    hint: pct < 60 ? hint : undefined,
  };
}

/**
 * Are closed deals carrying a value?
 *
 * Without this, revenue and ROAS quietly report dashes and nobody learns why.
 * That is precisely the failure this whole product replaced — a report that
 * silently stopped populating and went unnoticed for months — so an operational
 * gap that empties a headline metric has to be visible as a broken pipe, not
 * inferred from an absence.
 *
 * Verified live on 2026-08-12: 43 of 64 closed-won opportunities carried a
 * value, and **none created since March did**. A 90-day window therefore reads
 * red today, which is the correct and useful answer.
 *
 * Amber rather than red for partial coverage: some deals genuinely have no
 * monetary value (a referral, a comp), so a mixed picture is a nudge, not a
 * fault. Zero coverage with real closes is a fault.
 */
async function checkDealValues(client: Client): Promise<HealthCheck> {
  const base = { id: "deal_values", label: "Deal values recorded" };
  const window = trailingWindowInclusive(90, client.timezone);

  const [row] = await db
    .select({
      won: sql<number>`COUNT(DISTINCT ${opportunities.id})::int`,
      valued: sql<number>`COUNT(DISTINCT ${opportunities.id}) FILTER (WHERE ${opportunities.monetaryValue} > 0)::int`,
    })
    .from(stageTransitions)
    .innerJoin(
      opportunities,
      eq(opportunities.id, stageTransitions.opportunityId),
    )
    .where(
      and(
        eq(stageTransitions.clientId, client.id),
        eq(stageTransitions.toCanonical, "closed_won"),
        gte(stageTransitions.changedAt, window.startUtc),
      ),
    );

  const won = Number(row?.won ?? 0);
  const valued = Number(row?.valued ?? 0);

  if (won === 0) {
    // Nothing closed is a sales outcome, not a tracking fault.
    return { ...base, level: "green", message: "No closed deals in the last 90 days" };
  }
  if (valued === 0) {
    return {
      ...base,
      level: "red",
      message: `0 of ${won} closed deals have a value`,
      hint: "Revenue and ROAS cannot be computed. Set the opportunity value in GoHighLevel when marking a deal won — no amount of syncing can recover a value that was never entered.",
    };
  }
  const pct = Math.round((valued / won) * 100);
  return {
    ...base,
    level: pct >= 80 ? "green" : "amber",
    message: `${valued} of ${won} closed deals valued (${pct}%)`,
    hint:
      pct < 80
        ? "Revenue and ROAS understate by the missing share. The dashboard labels the coverage rather than presenting a partial figure as the total."
        : undefined,
  };
}

function formatAgo(hours: number): string {
  if (!Number.isFinite(hours)) return "never";
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))}m`;
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Cheap health for the client-list badge — one indexed count, no external API
 * calls. The full checklist (runHealthChecks) does the live verification.
 */
export async function quickHealth(client: Client): Promise<HealthLevel> {
  const ghlConnected =
    client.ghlAuthMethod === "oauth"
      ? Boolean(client.ghlLocationId)
      : Boolean(client.ghlTokenEncrypted);

  /*
   * 🔴 Any ad platform, not just Meta.
   *
   * This counted Meta ad accounts alone, so a client running Google or TikTok
   * carried a permanent red dot on the agency's client list — beside a working
   * account, with no setup step that could ever clear it. It is a separate
   * function from `runHealthChecks` for speed, which is fine; reaching a
   * DIFFERENT verdict about the same facts is not, because the list and the
   * detail page then contradict each other in front of the operator.
   */
  const accounts = await db.execute<{ count: number }>(sql`
    SELECT (
      (SELECT COUNT(*) FROM ${metaAdAccounts}
         WHERE ${metaAdAccounts.clientId} = ${client.id}
           AND ${metaAdAccounts.status} = 'active')
    + (SELECT COUNT(*) FROM ${googleAdAccounts}
         WHERE ${googleAdAccounts.clientId} = ${client.id}
           AND ${googleAdAccounts.status} = 'active')
    + (SELECT COUNT(*) FROM ${tiktokAdAccounts}
         WHERE ${tiktokAdAccounts.clientId} = ${client.id}
           AND ${tiktokAdAccounts.status} = 'active')
    )::int AS count
  `);

  const connectedAccounts = Number(accounts.rows?.[0]?.count ?? 0);

  if (!ghlConnected || connectedAccounts === 0) return "red";
  if (!client.firstWebhookAt) return "red";
  const staleHours = client.lastSyncedAt
    ? (Date.now() - client.lastSyncedAt.getTime()) / 3_600_000
    : Infinity;
  if (staleHours > 36) return "amber";
  return "green";
}
