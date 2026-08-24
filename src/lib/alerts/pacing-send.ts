import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, type Client } from "@/db/schema";
import { decryptNullable } from "@/lib/crypto";
import { loadPacing } from "@/lib/budgets";
import { monthLabel } from "@/lib/commentary/model";
import type { AdPlatform } from "@/lib/platforms";
import { classifyWebhookUrl } from "./compose";
import { post } from "./send";
import {
  composePacingBody,
  decidePacingAlert,
  type PacingAlertKind,
  type PacingSkipReason,
} from "./pacing";
import { appBaseUrl } from "@/lib/app-url";

/**
 * Sending the budget-pacing alert.
 *
 * The decision is in `./pacing` and is pure; this is the I/O around it — read
 * the destination, compute pacing, claim, post.
 *
 * Two rules carried over from the lead alert, for the same reasons:
 *
 * **Nothing here throws.** Every path returns a reason. This runs inside a cron
 * loop over every client, and one client's revoked webhook must not abort the
 * run for the rest of the book.
 *
 * **The claim is written BEFORE the request.** A timeout says nothing about
 * what the far end did, so a request that may have been delivered is recorded
 * as delivered. A duplicate ping costs more than a missed one — this is a
 * once-a-week message about a slow-moving fact, not a lead with a five-minute
 * half-life.
 */

export type PacingAlertOutcome =
  | { sent: true; kind: PacingAlertKind }
  | { sent: false; reason: PacingSkipReason | "bad_destination" | "failed"; detail?: string };

export async function alertPacing(
  client: Client,
  platform: AdPlatform,
  now: Date = new Date(),
): Promise<PacingAlertOutcome> {
  try {
    return await run(client, platform, now);
  } catch (err) {
    console.error("[alerts] pacing send failed", err);
    return { sent: false, reason: "failed", detail: String(err) };
  }
}

async function run(
  client: Client,
  platform: AdPlatform,
  now: Date,
): Promise<PacingAlertOutcome> {
  const raw = decryptNullable(client.alertWebhookEncrypted);
  const hasDestination = Boolean(raw);

  /*
   * Pacing is computed before the destination is validated but after the two
   * cheap boolean gates, which `decidePacingAlert` applies first — so a client
   * with alerts switched off costs one decrypt and no queries at all.
   */
  if (!client.alertsEnabled) return { sent: false, reason: "disabled" };
  if (!hasDestination) return { sent: false, reason: "no_destination" };

  const pacing = await loadPacing(client, platform);

  const decision = decidePacingAlert({
    pacing,
    alertsEnabled: client.alertsEnabled,
    hasDestination,
    last: { at: client.lastPacingAlertAt, status: client.lastPacingAlertStatus },
    now,
  });
  if (!decision.send || !decision.kind) {
    return { sent: false, reason: decision.reason ?? "on_pace" };
  }

  const check = classifyWebhookUrl(raw!);
  if (!check.ok || !check.target) {
    return { sent: false, reason: "bad_destination", detail: check.error ?? undefined };
  }

  // The claim. See the header — written first, deliberately.
  await db
    .update(clients)
    .set({ lastPacingAlertAt: now, lastPacingAlertStatus: decision.kind })
    .where(eq(clients.id, client.id));

  const base = appBaseUrl();
  const body = composePacingBody(check.target, decision.kind, pacing, {
    clientName: client.name,
    monthLabel: monthLabel(pacing.monthKey),
    currency: pacing.currency,
    dashboardUrl: base ? `${base}/c/${client.slug}` : null,
  });

  const result = await post(raw!, body);
  if (!result.ok) {
    console.error(`[alerts] ${client.slug}: pacing destination rejected`, result.detail);
    return { sent: false, reason: "failed", detail: result.detail };
  }
  return { sent: true, kind: decision.kind };
}
