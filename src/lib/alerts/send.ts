import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, contacts, type Client } from "@/db/schema";
import { decryptNullable } from "@/lib/crypto";
import { paidLeadPredicate } from "@/lib/metrics/queries";
import {
  classifyWebhookUrl,
  composeBody,
  decideAlert,
  MAX_PER_HOUR,
  type AlertContext,
  type AlertLead,
  type SkipReason,
} from "./compose";
import { appBaseUrl } from "@/lib/app-url";

/**
 * Sending the alert: the claim, the lookup and the one outbound request.
 *
 * Three rules, all of them about not damaging the thing this sits inside.
 *
 * **1 · The webhook receiver must not get slower or more fragile.** It exists
 * to persist a payload and return 200 fast, because a non-2xx triggers a GHL
 * retry storm and a lost transition is unrecoverable. So this is called from
 * `after()` — the response is already sent, and nothing here can turn a
 * successful ingest into a failed one.
 *
 * **2 · Nothing here may throw.** Every path returns a reason instead. An alert
 * is a courtesy; the ledger is the product.
 *
 * **3 · The claim is the lock.** `UPDATE … WHERE alerted_at IS NULL RETURNING`
 * is atomic, so of a dozen retried deliveries exactly one wins the row and
 * sends. Read-then-write would put twelve identical pings in the channel.
 */

/** How long to wait on the destination before giving up entirely. */
const TIMEOUT_MS = 5_000;

export type AlertOutcome =
  | { sent: true }
  | { sent: false; reason: SkipReason | "bad_destination" | "failed"; detail?: string };

/**
 * Fire a new-lead alert, if this lead deserves one.
 *
 * `ghlContactId` rather than our row id, because the caller is a webhook
 * handler that only ever knows GHL's identifier.
 */
export async function alertNewLead(
  client: Client,
  ghlContactId: string,
  now: Date = new Date(),
): Promise<AlertOutcome> {
  try {
    return await run(client, ghlContactId, now);
  } catch (err) {
    // Rule 2. A failure here has already been paid for by the caller returning
    // 200, and must never propagate into the ingest path.
    console.error("[alerts] send failed", err);
    return { sent: false, reason: "failed", detail: String(err) };
  }
}

async function run(
  client: Client,
  ghlContactId: string,
  now: Date,
): Promise<AlertOutcome> {
  if (!client.alertsEnabled) return { sent: false, reason: "disabled" };

  const url = decryptNullable(client.alertWebhookEncrypted);
  if (!url) return { sent: false, reason: "no_destination" };

  const check = classifyWebhookUrl(url);
  if (!check.ok || check.target === null) {
    /*
     * 🔴 Re-checked at send time, not only when it was saved. The allowlist can
     * tighten, and a row written before it did must not keep firing requests at
     * a host that is no longer permitted.
     */
    return { sent: false, reason: "bad_destination", detail: check.error ?? undefined };
  }

  /*
   * Everything the decision and the message need, in one round trip. `c` is the
   * alias `paidLeadPredicate` builds against, so the shared definition of a paid
   * lead is byte-identical to the one every figure on the dashboard uses.
   */
  const paid = paidLeadPredicate({
    mode: client.paidLeadFilter,
    tag: client.paidLeadTag,
  });

  type Row = {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    lead_at: string | Date | null;
    campaign_name: string | null;
    attributed: boolean;
    is_paid: boolean;
    /** Read for the probe script; the claim below is what actually decides. */
    already: boolean;
    nth_today: number;
    days_since_previous: number | null;
    sent_last_hour: number;
  };

  const res = await db.execute<Row>(sql`
    WITH me AS (
      SELECT * FROM contacts
      WHERE client_id = ${client.id} AND ghl_contact_id = ${ghlContactId}
      LIMIT 1
    )
    SELECT c.id::text AS id,
           c.first_name, c.last_name, c.email, c.phone,
           c.ghl_created_at AS lead_at,
           /*
            * The name a person recognises, preferring the UTM the lead itself
            * carried and falling back to whatever the ad sync recorded for that
            * campaign id. A bare numeric id in an alert is no more use than a
            * blank.
            */
           COALESCE(
             NULLIF(TRIM(c.utm_campaign), ''),
             (SELECT MAX(m.campaign_name) FROM fb_daily_metrics m
               WHERE m.client_id = ${client.id}
                 AND m.meta_campaign_id = c.meta_campaign_id
                 AND m.campaign_name IS NOT NULL),
             (SELECT MAX(g.campaign_name) FROM google_daily_metrics g
               WHERE g.client_id = ${client.id}
                 AND g.google_campaign_id = c.google_campaign_id
                 AND g.campaign_name IS NOT NULL)
           ) AS campaign_name,
           (c.meta_campaign_id IS NOT NULL OR c.google_campaign_id IS NOT NULL) AS attributed,
           ${paid ?? sql`TRUE`} AS is_paid,
           (c.alerted_at IS NOT NULL) AS already,
           (
             SELECT COUNT(*)::int FROM contacts o
             WHERE o.client_id = ${client.id}
               AND o.ghl_created_at IS NOT NULL
               AND c.ghl_created_at IS NOT NULL
               /*
                * The client's calendar day, not the server's — the same rule
                * every window on the dashboard follows, and "3rd today" is
                * exactly the kind of small claim a timezone slip makes wrong.
                */
               AND (o.ghl_created_at AT TIME ZONE ${client.timezone})::date
                 = (c.ghl_created_at AT TIME ZONE ${client.timezone})::date
               AND o.ghl_created_at <= c.ghl_created_at
           ) AS nth_today,
           (
             SELECT EXTRACT(EPOCH FROM (c.ghl_created_at - MAX(p.ghl_created_at))) / 86400.0
             FROM contacts p
             WHERE p.client_id = ${client.id}
               AND p.id <> c.id
               AND p.ghl_created_at IS NOT NULL
               AND p.ghl_created_at < c.ghl_created_at
           ) AS days_since_previous,
           (
             SELECT COUNT(*)::int FROM contacts h
             WHERE h.client_id = ${client.id}
               AND h.alerted_at > ${now.toISOString()}::timestamptz - interval '1 hour'
           ) AS sent_last_hour
    FROM me c
  `);

  const row = ((res as { rows?: Row[] }).rows ?? [])[0];
  if (!row || row.lead_at === null) return { sent: false, reason: "stale" };
  /*
   * No early return on `already` here. One was written and a mutation showed it
   * could not change any outcome: the claim below is guarded on the same null
   * and is the only check that can be trusted anyway, since a read taken here
   * is stale by the time the update runs. Reading it remains useful for the
   * probe script, so the column stays selected.
   */

  const leadAt = new Date(row.lead_at).toISOString();
  const decision = decideAlert({
    enabled: true,
    hasDestination: true,
    isPaidLead: Boolean(row.is_paid),
    leadAt,
    sentInLastHour: Number(row.sent_last_hour) || 0,
    now,
  });
  if (!decision.send) {
    if (decision.reason === "rate_limited") {
      console.warn(
        `[alerts] ${client.slug}: over ${MAX_PER_HOUR}/hour, suppressing — the next message that gets through will show the jump in "Nth today"`,
      );
    }
    return { sent: false, reason: decision.reason ?? "stale" };
  }

  /*
   * 🔴 The claim. Only a returned row may send, so twelve retried deliveries
   * produce exactly one message. Written BEFORE the request rather than after:
   * a duplicate ping is worse than a missed one, and a request that times out
   * may still have been delivered.
   */
  const claimed = await db
    .update(contacts)
    .set({ alertedAt: now })
    .where(and(eq(contacts.id, row.id), isNull(contacts.alertedAt)))
    .returning({ id: contacts.id });
  if (claimed.length === 0) return { sent: false, reason: "already_alerted" };

  const lead: AlertLead = {
    contactId: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    leadAt,
    campaignName: row.campaign_name,
    attributed: Boolean(row.attributed),
    nthToday: Number(row.nth_today) || 1,
    daysSincePrevious:
      row.days_since_previous === null ? null : Number(row.days_since_previous),
  };

  const base = appBaseUrl();
  const ctx: AlertContext = {
    clientName: client.name,
    clientSlug: client.slug,
    dashboardUrl: base ? `${base}/c/${client.slug}` : null,
  };

  const result = await post(url, composeBody(check.target, lead, ctx));
  if (!result.ok) {
    /*
     * The claim is NOT rolled back. A failed request may still have been
     * delivered — a timeout says nothing about what the far end did — and this
     * lead is on the dashboard either way. Silence beats a duplicate.
     */
    console.error(`[alerts] ${client.slug}: destination rejected`, result.detail);
    return { sent: false, reason: "failed", detail: result.detail };
  }
  return { sent: true };
}

/** One request, no retries, no redirects, hard timeout. */
export async function post(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      /*
       * 🔴 Redirects are not followed. The allowlist checks the URL we were
       * given; a 302 from an allowed host to an internal address would walk
       * straight around it, which is the standard way an allowlist is defeated.
       */
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300) {
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Save a destination, refusing anything the allowlist does not cover. */
export function validateDestination(raw: string) {
  return classifyWebhookUrl(raw);
}

/** Read the stored destination back, for the settings screen. Never the URL. */
export async function describeDestination(
  clientId: string,
): Promise<{ configured: boolean; target: string | null; enabled: boolean }> {
  const [row] = await db
    .select({
      enc: clients.alertWebhookEncrypted,
      enabled: clients.alertsEnabled,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  const url = decryptNullable(row?.enc ?? null);
  if (!url) return { configured: false, target: null, enabled: false };
  const check = classifyWebhookUrl(url);
  /*
   * The URL itself is never returned. A Slack incoming-webhook URL IS the
   * credential — anyone holding it can post into the channel — so the settings
   * screen shows which service it points at and nothing more.
   */
  return { configured: true, target: check.target, enabled: Boolean(row?.enabled) };
}
