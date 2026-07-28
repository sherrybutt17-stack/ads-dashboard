import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, webhookEvents } from "@/db/schema";
import {
  processWebhookEvent,
  finalizeEvent,
  touchClientWebhookMarkers,
} from "@/lib/ghl/process";

/**
 * GHL webhook receiver.
 *
 * This endpoint is the single most important thing in the application. GHL has
 * no stage-transition history API, so a transition not captured here is gone
 * permanently — it cannot be re-fetched from anywhere, ever.
 *
 * That drives three rules:
 *
 *  1. PERSIST BEFORE PARSING. The raw payload is written first, so a parser bug
 *     is recoverable by replaying `webhook_events` after a fix.
 *  2. ALWAYS RETURN 200 once persisted. A non-2xx triggers GHL's ~12 retries
 *     with jitter; if our processing is broken, retrying cannot help and only
 *     produces a retry storm. We keep the data and report success.
 *  3. IDEMPOTENT PROCESSING. Delivery is at-least-once and unordered, so
 *     reprocessing must be a no-op (enforced by the unique dedupeKey).
 *
 * Auth is the unguessable `token` path segment — workflow webhooks may carry no
 * signature header at all, so the URL itself is the shared secret.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  // Read the body defensively — a malformed body must still be retained.
  let payload: unknown;
  let rawText: string | null = null;
  try {
    rawText = await req.text();
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { __unparsed: rawText };
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    // Skip hop-by-hop noise; keep anything that helps diagnose a sender.
    if (k.startsWith("x-") || k === "content-type" || k === "user-agent") {
      headers[k] = v;
    }
  });

  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.webhookToken, token))
    .limit(1);

  // Log even an unroutable event, so a misconfigured GHL workflow is
  // diagnosable rather than silently vanishing.
  const [event] = await db
    .insert(webhookEvents)
    .values({
      clientId: client?.id ?? null,
      webhookToken: token,
      eventType:
        typeof (payload as Record<string, unknown>)?.type === "string"
          ? ((payload as Record<string, unknown>).type as string)
          : null,
      headers,
      payload: payload as object,
      status: client ? "pending" : "ignored",
      error: client ? null : "no client matches this webhook token",
    })
    .returning({ id: webhookEvents.id });

  if (!client) {
    return NextResponse.json(
      { ok: false, error: "unknown webhook token" },
      { status: 404 },
    );
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
    const message = err instanceof Error ? err.message : String(err);
    await finalizeEvent(event.id, {
      status: "failed",
      transitionCreated: false,
      error: message,
    });
    // Still 200 — see rule 2. The payload is safely stored for replay.
    await touchClientWebhookMarkers(client.id);
    return NextResponse.json({ ok: true, eventId: event.id, deferred: true });
  }
}

/**
 * GHL's webhook UI sends a GET when you click "Test". Answer it so the setup
 * step can be verified before any real event exists.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.webhookToken, token))
    .limit(1);

  if (!client) {
    return NextResponse.json(
      { ok: false, error: "unknown webhook token" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, client: client.name, ready: true });
}
