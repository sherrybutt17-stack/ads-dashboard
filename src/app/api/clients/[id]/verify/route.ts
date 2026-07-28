import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { encrypt, decryptNullable } from "@/lib/crypto";
import { getClientById, verifyGhl } from "@/lib/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Verify the GHL credential against the live API and, on success, persist it.
 *
 * Verify-then-store, never store-then-hope: a wrong token or a token generated
 * against the wrong sub-account is caught the moment it is entered, rather than
 * surfacing weeks later as an inexplicably empty dashboard.
 *
 * (Meta ad accounts are verified and attached via /meta-accounts — a client can
 * hold several, so that lives in its own endpoint.)
 */
const BodySchema = z.object({
  provider: z.literal("ghl"),
  locationId: z.string().trim().min(1),
  /** Omitted when re-testing an already-stored token. */
  token: z.string().trim().optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const client = await getClientById(id);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const token = parsed.data.token || decryptNullable(client.ghlTokenEncrypted);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "No token provided or stored" },
        { status: 400 },
      );
    }

    const result = await verifyGhl(token, parsed.data.locationId);
    await db
      .update(clients)
      .set({
        ghlLocationId: parsed.data.locationId,
        ghlLocationName: result.locationName,
        ...(parsed.data.token
          ? { ghlTokenEncrypted: encrypt(parsed.data.token) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(clients.id, id));

    return NextResponse.json({
      ok: true,
      provider: "ghl",
      locationName: result.locationName,
      timezone: result.timezone,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Verification failed",
      },
      { status: 502 },
    );
  }
}
