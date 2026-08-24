import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { encrypt, decryptNullable } from "@/lib/crypto";
import { verifyGhl } from "@/lib/clients";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { safeFailure } from "@/lib/api-failure";

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
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const token =
      parsed.data.token || decryptNullable(client.ghlTokenEncrypted);
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
    /*
     * A bad token is the EXPECTED outcome here, not an exception — this is the
     * screen where someone pastes one. So the response has to say which of
     * "wrong token", "token fine but wrong location", and "GHL is down" it was,
     * without handing over the path GHL echoes back, which contains a location
     * id. See `api-failure.ts`.
     */
    return NextResponse.json(
      {
        ok: false,
        ...safeFailure(
          err,
          "ghl",
          { superadmin: isSuperadmin(session) },
          "Verification failed",
        ),
      },
      { status: 502 },
    );
  }
}
