import { after, NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { clients, webhookEvents, type Client } from "@/db/schema";
import {
  processWebhookEvent,
  finalizeEvent,
  touchClientWebhookMarkers,
  recordMessageTouch,
} from "@/lib/ghl/process";
import { getInstallationByLocation, markUninstalled } from "@/lib/ghl/oauth";
import {
  verifyWebhookSignature,
  shouldRejectDelivery,
  mayRevokeOnDelivery,
  webhookEnforcementEnabled,
} from "@/lib/ghl/signature";
import { normalizeWebhookPayload } from "@/lib/ghl/normalize";
import { alertNewLead } from "@/lib/alerts/send";
import { headersToStore } from "@/lib/webhook-headers";
import { copyShareEvent, syncShare } from "@/lib/ghl/share";

/**
 * App-level GHL webhook receiver.
 *
 * ONE url for every client — this is the whole point of the marketplace app.
 * The URL is pasted once into the app's settings and every sub-account that
 * installs the app streams events here; tenants are told apart by `locationId`
 * in the payload rather than by a per-client URL.
 *
 * The same three rules as the per-token receiver apply, for the same reason —
 * a transition lost here is gone permanently, since GHL exposes no stage
 * history:
 *   1. Persist the raw payload BEFORE parsing.
 *   2. Always return 200 once persisted; a non-2xx just triggers retry storms.
 *   3. Processing is idempotent (unique dedupeKey), because delivery is
 *      at-least-once and unordered.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = { __unparsed: rawBody };
  }

  const signature = verifyWebhookSignature(rawBody, {
    ghlSignature: req.headers.get("x-ghl-signature"),
    whSignature: req.headers.get("x-wh-signature"),
  });

  // Fail-closed is STAGED behind GHL_WEBHOOK_ENFORCE. Off (the default), we
  // still compute and record `signature.status` on every event — so a newly
  // configured key can be proven against live traffic — but we never reject.
  // On, the two forgery signals below return 401. See webhookEnforcementEnabled.
  const enforce = webhookEnforcementEnabled();

  // The full truth table — and its reasoning — lives in `shouldRejectDelivery`,
  // where it can be asserted without standing up this receiver.
  const verdict = shouldRejectDelivery(signature, {
    enforce,
    isProduction: process.env.NODE_ENV === "production",
  });

  if (verdict.reject) {
    return NextResponse.json(
      { ok: false, error: verdict.reason },
      { status: 401 },
    );
  }

  // Observe mode: a would-be rejection is logged (and captured in
  // `__signature` below) but the delivery is still processed, so the rollout can
  // be watched without dropping funnel history.
  if (verdict.reason) {
    console.warn(
      `[webhook] signature ${signature.status} — observe mode, not enforced (set GHL_WEBHOOK_ENFORCE=true once live deliveries read "valid")`,
    );
  }

  const headers = headersToStore(req.headers);

  const evt = normalizeWebhookPayload(payload);
  const eventType = evt.eventType;

  /*
   * Route by locationId → installation → client. An installation that nobody
   * has claimed yet still records the event, so nothing is lost between the app
   * being installed and the client record being wired up.
   */
  let client = null;
  /*
   * A sub-account shared between clients ("Share this sub-account"): the
   * installation's client is the HOLDER and processes every delivery exactly as
   * before; the copy to the other clients and the split follow, before the 200.
   * Unshared locations take no extra query.
   */
  let shareInstallationId: string | null = null;
  if (evt.locationId) {
    const installation = await getInstallationByLocation(evt.locationId);
    if (installation?.clientId) {
      const [row] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, installation.clientId))
        .limit(1);
      client = row ?? null;
      if (client?.ghlShareInstallationId && client.ghlShareInstallationId === installation.id) {
        shareInstallationId = installation.id;
      }
    }
    if (!client) {
      // Fall back to a direct locationId match, covering clients connected by
      // PIT before the app existed.
      // Oldest live client first: never an arbitrary row when two share a typed location id.
      const [row] = await db
        .select()
        .from(clients)
        .where(and(eq(clients.ghlLocationId, evt.locationId), ne(clients.status, "archived")))
        .orderBy(clients.createdAt)
        .limit(1);
      client = row ?? null;
    }
  }

  const [event] = await db
    .insert(webhookEvents)
    .values({
      clientId: client?.id ?? null,
      webhookToken: null,
      eventType,
      headers: {
        ...headers,
        __signature: signature.status,
        __signatureEnforced: enforce ? "on" : "off",
      },
      payload: payload as object,
      status: client ? "pending" : "ignored",
      error: client
        ? null
        : `no client bound to locationId ${evt.locationId ?? "(missing)"}`,
    })
    .returning({ id: webhookEvents.id });

  // App lifecycle events carry no opportunity data.
  if (eventType === "INSTALL" || eventType === "AppInstall") {
    // An install carries no opportunity data, but it proves the pipe is live —
    // mark the client so the "no webhook received yet" banner clears.
    if (client) await touchClientWebhookMarkers(client.id);
    await finalizeEvent(event.id, {
      status: "processed",
      transitionCreated: false,
      reason: "app install event",
    });
    if (shareInstallationId) await copyToShare(() => copyShareEvent(shareInstallationId!, event.id));
    return NextResponse.json({ ok: true });
  }
  if (eventType === "UNINSTALL" || eventType === "AppUninstall") {
    /*
     * 🔴 The one event here that DESTROYS state, so it does not ride the
     * staged signature rollout.
     *
     * `GHL_WEBHOOK_ENFORCE` is off by default and observe mode processes a
     * delivery whose signature is invalid or absent. That is the right trade
     * for DATA — a rejected opportunity event is funnel history GHL cannot
     * supply twice, so recording an unverified one and sorting it out later is
     * strictly better. It is the wrong trade here. `markUninstalled` takes a
     * client's CRM pipe offline, and this endpoint is necessarily public, so in
     * observe mode anyone who learns a `locationId` could post four lines of
     * JSON and disconnect that client. Nothing about that is recoverable by
     * replay: the leads simply stop arriving until somebody notices.
     *
     * The asymmetry is the point. An unverified delivery may ADD information,
     * because a wrong row can be corrected from the raw payload we kept. It may
     * not REVOKE anything, because there is no equivalent way back.
     *
     * The event is still stored either way, so a genuine uninstall that arrives
     * unsigned is visible in `webhook_events` with its `__signature` status
     * rather than lost — it just does not act on its own authority.
     */
    if (!mayRevokeOnDelivery(signature)) {
      console.warn(
        `[webhook] ignoring UNINSTALL for location ${evt.locationId ?? "(missing)"}: ` +
          `signature is "${signature.status}", not "valid". Set GHL_WEBHOOK_KEY so ` +
          `genuine uninstalls can be trusted; until then this is indistinguishable ` +
          `from a forged request.`,
      );
      await finalizeEvent(event.id, {
        status: "ignored",
        transitionCreated: false,
        reason: `uninstall not honoured — signature ${signature.status}`,
      });
      return NextResponse.json({ ok: true, ignored: "unverified uninstall" });
    }

    if (evt.locationId) await markUninstalled(evt.locationId);
    await finalizeEvent(event.id, {
      status: "processed",
      transitionCreated: false,
      reason: "app uninstall event",
    });
    return NextResponse.json({ ok: true });
  }

  if (!client) {
    // 200 deliberately: retrying will not conjure a client, and the raw event
    // is stored so it can be replayed once the install is claimed.
    return NextResponse.json({
      ok: true,
      stored: true,
      note: "no client bound to this locationId yet",
    });
  }

  if (client.status === "archived") {
    await finalizeEvent(event.id, {
      status: "ignored",
      transitionCreated: false,
      reason: "client archived",
    });
    return NextResponse.json({ ok: true, ignored: true });
  }

  /*
   * 🔴 Real-time new-lead alert, AFTER the response.
   *
   * `after()` and not a bare promise: this handler exists to persist the
   * payload and return 200 fast, because a non-2xx makes GHL retry and a lost
   * transition is unrecoverable. An awaited outbound request to Slack would put
   * a third party's latency — and their outage — inside the ingest path.
   *
   * Fired for every event carrying a contact id, message events included. Those
   * are a second chance at a lead whose ContactCreate we never received, and
   * every guard that decides whether to actually send lives behind the atomic
   * claim, so an extra call is free.
   */
  if (evt.contactId) {
    /*
     * In a shared sub-account every client in it may be the one the split gives
     * this person to; the alert's own query lets only that client's counted
     * copy — placed by its tag — send.
     */
    const recipients: Client[] = [client];
    if (shareInstallationId) {
      recipients.push(
        ...(await db
          .select()
          .from(clients)
          .where(
            and(
              eq(clients.ghlShareInstallationId, shareInstallationId),
              ne(clients.id, client.id),
              ne(clients.status, "archived"),
            ),
          )),
      );
    }
    const contactId = evt.contactId;
    after(async () => {
      for (const c of recipients) await alertNewLead(c, contactId);
    });
  }

  // Message events feed speed-to-lead / first-touch, not the stage ledger.
  if (eventType === "OutboundMessage" || eventType === "InboundMessage") {
    const touch = await recordMessageTouch(client.id, payload);
    await touchClientWebhookMarkers(client.id);
    await finalizeEvent(event.id, {
      status: "processed",
      transitionCreated: false,
      reason: touch.isCall
        ? touch.contactMatched
          ? "first-call recorded"
          : "call for unknown contact"
        : "message touch",
    });
    if (shareInstallationId) {
      await copyToShare(() => copyShareEvent(shareInstallationId!, event.id, evt.contactId));
    }
    return NextResponse.json({ ok: true, isCall: touch.isCall });
  }

  /** Copy and split what this delivery wrote, for a shared sub-account. */
  const share = async () => {
    if (!shareInstallationId) return;
    await copyToShare(() =>
      syncShare(shareInstallationId!, {
        ghlContactIds: [evt.contactId],
        ghlOpportunityIds: [evt.opportunityId],
        eventId: event.id,
      }),
    );
  };

  try {
    const result = await processWebhookEvent(event.id, client, payload);
    await finalizeEvent(event.id, result);
    await touchClientWebhookMarkers(client.id);
    await share();
    return NextResponse.json({
      ok: true,
      eventId: event.id,
      transitionCreated: result.transitionCreated,
    });
  } catch (err) {
    await finalizeEvent(event.id, {
      status: "failed",
      transitionCreated: false,
      error: err instanceof Error ? err.message : String(err),
    });
    await touchClientWebhookMarkers(client.id);
    await share();
    return NextResponse.json({ ok: true, eventId: event.id, deferred: true });
  }
}

/**
 * The copy to a shared sub-account's other clients never fails the delivery:
 * the holder's rows are already safe, and what didn't copy or split is
 * repaired by the hourly sweep (new rows wait there uncounted, never counted
 * twice).
 */
async function copyToShare(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error("[webhook] shared sub-account copy deferred to the sweep:", err instanceof Error ? err.message : err);
  }
}

/** GHL pings this when you save the URL in app settings. */
export async function GET() {
  return NextResponse.json({ ok: true, ready: true, receiver: "app-level" });
}
