import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { requireClient } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { record, requestContext } from "@/lib/audit";
import {
  classifyWebhookUrl,
  composeBody,
  type AlertLead,
} from "@/lib/alerts/compose";
import { describeDestination, post } from "@/lib/alerts/send";
import { appBaseUrl } from "@/lib/app-url";

/**
 * The new-lead alert destination.
 *
 * **Staff only.** A client-role user must not be able to set the address their
 * own lead names and phone numbers get posted to — and the write is an SSRF
 * primitive, so the guard here is doing two jobs at once.
 *
 * The URL is never read back out. A Slack incoming-webhook URL IS the
 * credential: anyone holding it can post into the channel, and rendering it
 * into a settings form would put it in the page source of every staff session.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    /** Empty string clears the destination entirely. */
    url: z.string().max(2048).optional(),
    enabled: z.boolean().optional(),
    /** Send one message to prove the destination works, without saving. */
    test: z.boolean().optional(),
  })
  // 🔴 Strict, so an unknown key is a 400 rather than a silently ignored field.
  // The two schemas the customization work needed learned this the hard way.
  .strict();

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  return NextResponse.json(await describeDestination(client.id));
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { url, enabled, test } = parsed.data;

  /*
   * A test send uses the URL in the request when one was given, so a
   * destination can be proved BEFORE it is stored. Pasting a webhook, saving
   * it, and only then discovering the channel was deleted is how this setting
   * ends up switched on and silently dead.
   */
  if (test) {
    const target = url ?? null;
    if (target === null) {
      return NextResponse.json(
        { ok: false, error: "Paste a webhook URL to test." },
        { status: 400 },
      );
    }
    const check = classifyWebhookUrl(target);
    if (!check.ok || check.target === null) {
      return NextResponse.json({ ok: false, error: check.error }, { status: 400 });
    }
    const sample: AlertLead = {
      contactId: "test",
      firstName: "Test",
      lastName: "Lead",
      email: "test@example.com",
      phone: "+1 555 0100",
      leadAt: new Date().toISOString(),
      campaignName: "Test message from the dashboard",
      attributed: true,
      nthToday: 1,
      daysSincePrevious: 0,
    };
    const base = appBaseUrl();
    const result = await post(
      target,
      composeBody(check.target, sample, {
        clientName: client.name,
        clientSlug: client.slug,
        dashboardUrl: base ? `${base}/c/${client.slug}` : null,
      }),
    );
    return NextResponse.json(
      result.ok ? { ok: true } : { ok: false, error: result.detail },
      { status: result.ok ? 200 : 502 },
    );
  }

  const patch: Record<string, unknown> = {};

  if (url !== undefined) {
    const trimmed = url.trim();
    if (trimmed === "") {
      // Clearing the URL also switches alerts off: an enabled client with no
      // destination is a setting that looks live and does nothing.
      patch.alertWebhookEncrypted = null;
      patch.alertsEnabled = false;
    } else {
      const check = classifyWebhookUrl(trimmed);
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
      patch.alertWebhookEncrypted = encrypt(trimmed);
    }
  }

  if (enabled !== undefined) {
    /*
     * 🔴 Switching alerts ON with nothing stored, and nothing being set in the
     * same request, is refused rather than accepted-and-ignored. The client list
     * would show alerts enabled and no message would ever arrive.
     */
    if (enabled && !client.alertWebhookEncrypted && patch.alertWebhookEncrypted == null) {
      return NextResponse.json(
        { error: "Add a webhook URL before switching alerts on." },
        { status: 400 },
      );
    }
    patch.alertsEnabled = enabled;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(await describeDestination(id));
  }

  await db.update(clients).set(patch).where(eq(clients.id, id));
  await record({
    action: "client.alerts_update",
    targetType: "client",
    targetId: id,
    clientId: id,
    ...requestContext(req),
    // The URL itself never reaches the audit log either — only whether one is
    // now present, which is the part anybody reviewing this would need.
    metadata: {
      destinationSet: patch.alertWebhookEncrypted !== undefined,
      destinationCleared: patch.alertWebhookEncrypted === null,
      enabled: patch.alertsEnabled,
    },
  });

  return NextResponse.json(await describeDestination(id));
}
