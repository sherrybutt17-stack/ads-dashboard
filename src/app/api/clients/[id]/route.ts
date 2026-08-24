import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { webhookUrlFor } from "@/lib/clients";
import { removeClient } from "@/lib/client-removal";
import { isValidTimeZone } from "@/lib/dates";
import { requireClient } from "@/lib/auth";
import { assertLocationIdAvailable } from "@/lib/ghl/oauth";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  // Reject "" / garbage — an invalid zone crashes the dashboard on next render.
  timezone: z
    .string()
    .refine(isValidTimeZone, "Invalid IANA timezone")
    .optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  ghlLocationId: z.string().trim().nullish(),
  ghlToken: z.string().trim().optional(),
  paidLeadFilter: z.enum(["all", "attributed", "tagged", "either"]).optional(),
  paidLeadTag: z.string().trim().min(1).max(80).optional(),
});

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;
  // Never return the encrypted credentials, even to an authenticated caller.
  const { ghlTokenEncrypted, ...safe } = client;
  return NextResponse.json({
    client: {
      ...safe,
      webhookUrl: webhookUrlFor(client),
      hasGhlToken: Boolean(ghlTokenEncrypted),
    },
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  /*
   * 🔴 This handler never loaded the client — it went from a uuid straight to
   * `UPDATE clients WHERE id = $1`. The staff check was real and the write was
   * unscoped, so it rotated GHL tokens and flipped status on ANY client, in any
   * agency, on a guessed uuid. It survived the sweep that fixed its 29 siblings
   * because that pass keyed on `getClientById`, and this route never called it:
   * a route with no read to scope looked, to a search, like a route with
   * nothing wrong.
   */
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const d = parsed.data;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (d.name !== undefined) updates.name = d.name;
  if (d.timezone !== undefined) updates.timezone = d.timezone;
  if (d.status !== undefined) updates.status = d.status;
  if (d.ghlLocationId !== undefined) {
    // Same rule as creation: an edit is another way to type the field.
    if (d.ghlLocationId) {
      await assertLocationIdAvailable(
        client.agencyId,
        d.ghlLocationId,
        client.id,
      );
    }
    updates.ghlLocationId = d.ghlLocationId;
  }
  if (d.paidLeadFilter !== undefined) updates.paidLeadFilter = d.paidLeadFilter;
  // Lowercased on write so tag matching needs no per-query LOWER().
  if (d.paidLeadTag !== undefined) {
    updates.paidLeadTag = d.paidLeadTag.toLowerCase();
  }
  // Token is only ever written, never read back to the client.
  if (d.ghlToken) updates.ghlTokenEncrypted = encrypt(d.ghlToken);

  const [updated] = await db
    .update(clients)
    .set(updates)
    .where(eq(clients.id, client.id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Record which fields changed. A token rotation is called out explicitly as
  // its own security-relevant event.
  void audit.record({
    action: d.ghlToken ? "client.token_change" : "client.update",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    metadata: {
      fields: Object.keys(updates).filter((k) => k !== "updatedAt"),
      tokenChanged: Boolean(d.ghlToken),
    },
    ...audit.requestContext(req),
  });
  return NextResponse.json({ ok: true, slug: updated.slug });
}

/**
 * Archive rather than delete.
 *
 * A hard delete would cascade into `stage_transitions` and destroy funnel
 * history that cannot be re-fetched from GoHighLevel under any circumstances.
 * Archiving stops ingestion and hides the client while keeping the ledger.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  // `client.id` rather than the raw `id` param: the same value, but taken
  // from the row `requireClient` actually authorized, so the check and the
  // use cannot drift apart in a later edit.
  const result = await removeClient(client.id);

  void audit.record({
    action: "client.remove",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    metadata: { ...result },
    ...audit.requestContext(req),
  });
  return NextResponse.json({
    ok: true,
    archived: true,
    ...result,
    note: "Client archived and disconnected. Funnel history is retained — GHL cannot supply it again if deleted.",
  });
}
