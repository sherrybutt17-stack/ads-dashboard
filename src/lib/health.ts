import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  contacts,
  fbDailyMetrics,
  metaAdAccounts,
  pipelineStages,
  stageTransitions,
  syncRuns,
  CANONICAL_STAGES,
  type Client,
} from "@/db/schema";
import { getGhlClientAsync } from "@/lib/ghl/process";
import { getInstallationForClient } from "@/lib/ghl/oauth";
import { activeAdAccounts, metaClientForAccount } from "@/lib/meta/accounts";
import {
  activeGoogleAccounts,
  googleClientForAccount,
} from "@/lib/google/accounts";
import type { GoogleAdAccount } from "@/db/schema";
import { trailingWindowInclusive } from "@/lib/dates";

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
}

export interface HealthReport {
  clientId: string;
  overall: HealthLevel;
  checks: HealthCheck[];
  checkedAt: string;
}

const WEBHOOK_QUIET_HOURS = 72;

export async function runHealthChecks(client: Client): Promise<HealthReport> {
  const checks: HealthCheck[] = [];

  checks.push(await checkGhlToken(client));
  checks.push(await checkStageMapping(client));
  checks.push(await checkUnmappedStages(client));
  checks.push(await checkWebhookAlive(client));
  checks.push(await checkMetaToken(client));
  checks.push(await checkMetaFreshness(client));

  // Google is optional — a client can run Meta only. Its checks appear only once
  // at least one Google account is attached, so a Meta-only client never shows a
  // red "Google not connected" that is really just "not using Google".
  const googleAccounts = await activeGoogleAccounts(client.id);
  if (googleAccounts.length > 0) {
    checks.push(await checkGoogleToken(client, googleAccounts));
    checks.push(await checkGoogleFreshness(client));
  }

  checks.push(await checkSpendLeadCoherence(client));
  checks.push(await checkAttribution(client));

  return {
    clientId: client.id,
    overall: worst(checks.map((c) => c.level)),
    checks,
    checkedAt: new Date().toISOString(),
  };
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
    return {
      ...base,
      level: "red",
      message: err instanceof Error ? err.message : "Location unreachable",
      hint: "The credential may have been revoked, or it belongs to a different sub-account.",
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
  const missing = CANONICAL_STAGES.filter((s) => !mapped.has(s));

  if (missing.length === 0) {
    return { ...base, level: "green", message: "All 7 stages mapped" };
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
        const meta = metaClientForAccount(account);
        const acct = await meta.getAdAccount(account.adAccountId);
        return { ok: true as const, name: acct.name ?? account.adAccountId };
      } catch (err) {
        return {
          ok: false as const,
          name: account.accountName ?? account.adAccountId,
          error: err instanceof Error ? err.message : "unreachable",
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
  if (broken.length === accounts.length) {
    return {
      ...base,
      level: "red",
      message: `All ${accounts.length} ad account(s) unreachable`,
      hint: "Check the system user has access, or the per-account token override.",
    };
  }
  return {
    ...base,
    level: "amber",
    message: `${broken.length} of ${accounts.length} accounts unreachable: ${broken
      .map((b) => b.name)
      .join(", ")}`,
    hint: "That account's spend is missing from the totals until it reconnects.",
  };
}

async function checkMetaFreshness(client: Client): Promise<HealthCheck> {
  const base = { id: "meta_fresh", label: "Meta data freshness" };
  const [lastRun] = await db
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.clientId, client.id), eq(syncRuns.kind, "meta_daily")))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  if (!lastRun) {
    return { ...base, level: "amber", message: "Never synced" };
  }
  if (lastRun.status === "failed") {
    return {
      ...base,
      level: "red",
      message: `Last sync failed: ${lastRun.error ?? "unknown error"}`,
    };
  }
  const hours = (Date.now() - lastRun.startedAt.getTime()) / 3_600_000;
  if (hours > 36) {
    return {
      ...base,
      level: "amber",
      message: `Last synced ${formatAgo(hours)} ago`,
      hint: "The nightly cron may not be running.",
    };
  }
  return { ...base, level: "green", message: `Synced ${formatAgo(hours)} ago` };
}

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
        const google = googleClientForAccount(account);
        const info = await google.getCustomer(account.customerId);
        return { ok: true as const, name: info.descriptiveName ?? account.customerId };
      } catch (err) {
        return {
          ok: false as const,
          name: account.accountName ?? account.customerId,
          error: err instanceof Error ? err.message : "unreachable",
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
  if (broken.length === accounts.length) {
    return {
      ...base,
      level: "red",
      message: `All ${accounts.length} account(s) unreachable`,
      hint: "Check the MCC link is accepted, the developer token is valid, or the per-account refresh token override.",
    };
  }
  return {
    ...base,
    level: "amber",
    message: `${broken.length} of ${accounts.length} accounts unreachable: ${broken
      .map((b) => b.name)
      .join(", ")}`,
    hint: "That account's spend is missing from the totals until it reconnects.",
  };
}

async function checkGoogleFreshness(client: Client): Promise<HealthCheck> {
  const base = { id: "google_fresh", label: "Google data freshness" };
  const [lastRun] = await db
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.clientId, client.id), eq(syncRuns.kind, "google_daily")))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  if (!lastRun) {
    return { ...base, level: "amber", message: "Never synced" };
  }
  if (lastRun.status === "failed") {
    return {
      ...base,
      level: "red",
      message: `Last sync failed: ${lastRun.error ?? "unknown error"}`,
    };
  }
  const hours = (Date.now() - lastRun.startedAt.getTime()) / 3_600_000;
  if (hours > 36) {
    return {
      ...base,
      level: "amber",
      message: `Last synced ${formatAgo(hours)} ago`,
      hint: "The nightly Google cron may not be running.",
    };
  }
  return { ...base, level: "green", message: `Synced ${formatAgo(hours)} ago` };
}

/**
 * The check the old spreadsheet most needed and did not have.
 *
 * Leads arriving with zero spend, or spend with no leads at all, are both
 * incoherent states that indicate a broken feed rather than a bad month.
 */
async function checkSpendLeadCoherence(client: Client): Promise<HealthCheck> {
  const base = { id: "coherence", label: "Spend / lead coherence" };
  const window = trailingWindowInclusive(30, client.timezone);

  const [spendRow] = await db
    .select({
      spend: sql<string>`COALESCE(SUM(${fbDailyMetrics.spend}), 0)`,
      days: sql<number>`COUNT(DISTINCT ${fbDailyMetrics.date})::int`,
    })
    .from(fbDailyMetrics)
    .where(
      and(
        eq(fbDailyMetrics.clientId, client.id),
        gte(fbDailyMetrics.date, window.startKey),
      ),
    );

  const [leadRow] = await db
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
    );

  const spend = Number(spendRow?.spend ?? 0);
  const leads = Number(leadRow?.leads ?? 0);

  if (spend === 0 && leads === 0) {
    return {
      ...base,
      level: "amber",
      message: "No spend and no leads in 30 days — ads appear paused",
      hint: "This is a deliberate 'nothing is happening' state, not an error.",
    };
  }
  if (spend === 0 && leads > 0) {
    return {
      ...base,
      level: "red",
      message: `${leads} leads recorded against $0.00 spend`,
      hint: "Either the Meta spend feed is broken, or these leads are not paid-acquired. Cost-per metrics are being suppressed until this resolves.",
    };
  }
  if (spend > 0 && leads === 0) {
    return {
      ...base,
      level: "amber",
      message: `$${spend.toFixed(2)} spent, zero leads reached the CRM`,
      hint: "Check the lead form, the landing page, and that the GHL workflow is firing.",
    };
  }
  return {
    ...base,
    level: "green",
    message: `$${spend.toFixed(2)} spend, ${leads} leads`,
  };
}

/**
 * Is UTM attribution actually reaching contacts?
 *
 * GHL does not natively store Meta ad ids, so per-campaign cost breakdowns
 * depend entirely on URL parameters being present on the live ads. A setup that
 * was intended but never applied looks exactly like a client with no campaigns.
 */
async function checkAttribution(client: Client): Promise<HealthCheck> {
  const base = { id: "attribution", label: "Campaign attribution" };
  const window = trailingWindowInclusive(30, client.timezone);

  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      attributed: sql<number>`COUNT(${contacts.metaCampaignId})::int`,
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

  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(metaAdAccounts)
    .where(
      and(
        eq(metaAdAccounts.clientId, client.id),
        eq(metaAdAccounts.status, "active"),
      ),
    );

  if (!ghlConnected || Number(count) === 0) return "red";
  if (!client.firstWebhookAt) return "red";
  const staleHours = client.lastSyncedAt
    ? (Date.now() - client.lastSyncedAt.getTime()) / 3_600_000
    : Infinity;
  if (staleHours > 36) return "amber";
  return "green";
}
