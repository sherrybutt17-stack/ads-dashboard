import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, webhookEvents } from "@/db/schema";
import {
  processWebhookEvent,
  finalizeEvent,
  touchClientWebhookMarkers,
} from "@/lib/ghl/process";
import { getInstallationByLocation, markUninstalled } from "@/lib/ghl/oauth";
import { verifyWebhookSignature } from "@/lib/ghl/signature";
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

  // A signature that is present and WRONG always means forgery — reject.
  if (signature.status === "invalid") {
    return NextResponse.json(
      { ok: false, error: "invalid signature" },
      { status: 401 },
    );
  }

  // This receiver routes by `locationId`, a NON-secret identifier — so once a
  // verification key is configured, an unsigned delivery in production is a
  // forgery attempt against the append-only ledger and is rejected. When no key
  // is set we cannot verify, so we preserve the delivery (data loss here is
  // permanent — GHL has no history API) and rely on the health checklist to
  // surface that verification is inactive.
  if (
    signature.status === "skipped" &&
    signature.code === "no_signature" &&
    process.env.NODE_ENV === "production"
  ) {
    return NextResponse.json(
      { ok: false, error: "unsigned delivery rejected" },
      { status: 401 },
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
      headers: { ...headers, __signature: signature.status },
      payload: payload as object,
      status: client ? "pending" : "ignored",
      error: client
        ? null
        : `no client bound to locationId ${evt.locationId ?? "(missing)"}`,
    })
    .returning({ id: webhookEvents.id });

  // App lifecycle events carry no opportunity data.
  if (eventType === "INSTALL" || eventType === "AppInstall") {
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
