import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { getClientById, webhookUrlFor } from "@/lib/clients";
import { removeClient } from "@/lib/client-removal";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().optional(),
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
  const client = await getClientById(id);
  if (!client) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
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
  const { id } = await ctx.params;
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
  if (d.ghlLocationId !== undefined) updates.ghlLocationId = d.ghlLocationId;
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
    .where(eq(clients.id, id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Record which fields changed. A token rotation is called out explicitly as
  // its own security-relevant event.
  void audit.record({
    action: d.ghlToken ? "client.token_change" : "client.update",
    targetType: "client",
    targetId: id,
    clientId: id,
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
  const client = await getClientById(id);
  if (!client) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await removeClient(id);

  void audit.record({
    action: "client.remove",
    targetType: "client",
    targetId: id,
    clientId: id,
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
