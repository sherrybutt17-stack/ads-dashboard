import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, webhookEvents } from "@/db/schema";
import {
  processWebhookEvent,
  finalizeEvent,
  touchClientWebhookMarkers,
  recordMessageTouch,
} from "@/lib/ghl/process";
import { getInstallationByLocation, markUninstalled } from "@/lib/ghl/oauth";
import {
  verifyWebhookSignature,
  webhookEnforcementEnabled,
} from "@/lib/ghl/signature";
import { normalizeWebhookPayload } from "@/lib/ghl/normalize";

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

  // A signature that is present and WRONG always means forgery.
  const forgedSignature = signature.status === "invalid";

  // This receiver routes by `locationId`, a NON-secret identifier — so once a
  // verification key is configured, an unsigned delivery in production is a
  // forgery attempt against the append-only ledger. When no key is set we cannot
  // verify at all (status "not_configured"), so this never trips and the
  // delivery is preserved — data loss here is permanent (GHL has no history API).
  const unsignedInProd =
    signature.status === "skipped" &&
    signature.code === "no_signature" &&
    process.env.NODE_ENV === "production";

  if (enforce && (forgedSignature || unsignedInProd)) {
    return NextResponse.json(
      {
        ok: false,
        error: forgedSignature ? "invalid signature" : "unsigned delivery rejected",
      },
      { status: 401 },
    );
  }

  // Observe mode: a would-be rejection is logged (and captured in
  // `__signature` below) but the delivery is still processed, so the rollout can
  // be watched without dropping funnel history.
  if (!enforce && (forgedSignature || unsignedInProd)) {
    console.warn(
      `[webhook] signature ${signature.status} — observe mode, not enforced (set GHL_WEBHOOK_ENFORCE=true once live deliveries read "valid")`,
    );
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (k.startsWith("x-") || k === "content-type" || k === "user-agent") {
      headers[k] = v;
    }
  });

  const evt = normalizeWebhookPayload(payload);
  const eventType = evt.eventType;

  /*
   * Route by locationId → installation → client. An installation that nobody
   * has claimed yet still records the event, so nothing is lost between the app
   * being installed and the client record being wired up.
   */
  let client = null;
  if (evt.locationId) {
    const installation = await getInstallationByLocation(evt.locationId);
    if (installation?.clientId) {
      const [row] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, installation.clientId))
        .limit(1);
      client = row ?? null;
    }
    if (!client) {
      // Fall back to a direct locationId match, covering clients connected by
      // PIT before the app existed.
      const [row] = await db
        .select()
        .from(clients)
        .where(eq(clients.ghlLocationId, evt.locationId))
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
    return NextResponse.json({ ok: true });
  }
  if (eventType === "UNINSTALL" || eventType === "AppUninstall") {
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
    return NextResponse.json({ ok: true, isCall: touch.isCall });
  }

  try {
    const result = await processWebhookEvent(event.id, client, payload);
    await finalizeEvent(event.id, result);
    await touchClientWebhookMarkers(client.id);
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
    return NextResponse.json({ ok: true, eventId: event.id, deferred: true });
  }
}

/** GHL pings this when you save the URL in app settings. */
export async function GET() {
  return NextResponse.json({ ok: true, ready: true, receiver: "app-level" });
}
