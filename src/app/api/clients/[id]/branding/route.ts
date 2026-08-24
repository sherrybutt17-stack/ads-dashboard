import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, requireClient } from "@/lib/auth";
import { record, requestContext } from "@/lib/audit";
import { isValidHexColor, normalizeBrandColor } from "@/lib/branding";
import { getClientBranding, saveClientBranding } from "@/lib/branding-store";
import {
  StaffBrandingSchema,
  readLogoUpload,
  BRANDING_WRITE_FAILED,
} from "@/lib/branding-write";

/**
 * Staff-set per-client branding, addressed by client ID.
 *
 * The agency's endpoint. It differs from the client-facing
 * `/api/c/[slug]/branding` in exactly one respect — the schema it parses with,
 * `StaffBrandingSchema`, which additionally carries the two agency-owned
 * switches (`brandColorAppliesToDashboard` and `clientEditable`). Everything
 * else, including logo validation and magic-byte sniffing, is shared.
 *
 * Staff bypass the `clientEditable` gate here by construction: this route never
 * consults it. The switch exists to restrain the client, not the agency.
 */

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  return NextResponse.json({ branding: await getClientBranding(client.id) });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  // Resolved once, up front: it is a session read, and threading a promise
  // through the write helper below is how one branch ends up storing
  // "[object Promise]" as the editor.
  const by = await actor();
  const contentType = req.headers.get("content-type") ?? "";

  // Logo upload arrives as multipart; everything else as JSON. Both the
  // validation and the magic-byte sniffing are shared with the client-facing
  // endpoint — two copies is how one of them starts accepting SVG.
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const result = await readLogoUpload(form);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const wrote = await write(() =>
      saveClientBranding(client.id, { logo: result.logo, updatedBy: by }),
    );
    if (wrote) return wrote;
    await audit(
      req,
      id,
      result.logo ? "branding.logo_uploaded" : "branding.logo_removed",
      { by: "staff" },
    );
    return NextResponse.json({ ok: true, logo: Boolean(result.logo) });
  }

  const body = await req.json().catch(() => null);
  const parsed = StaffBrandingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Rejected loudly rather than normalised to null — a staff member who pastes a
  // bad hex should be told, not silently ignored.
  if (parsed.data.brandColor && !isValidHexColor(parsed.data.brandColor)) {
    return NextResponse.json(
      { error: "Brand colour must be a hex value like #2aa9b8." },
      { status: 400 },
    );
  }

  const wrote = await write(() =>
    saveClientBranding(client.id, { ...parsed.data, updatedBy: by }),
  );
  if (wrote) return wrote;
  await audit(req, id, "branding.update", {
    fields: Object.keys(parsed.data),
  });

  return NextResponse.json({
    ok: true,
    branding: await getClientBranding(client.id),
    // Echo what the colour actually became. It is clamped into a band that is
    // legible on both themes, so the stored value can differ from the input —
    // showing it back is how that stops being a surprise.
    normalizedColor: parsed.data.brandColor
      ? normalizeBrandColor(parsed.data.brandColor)
      : undefined,
  });
}

/** Who made the change, for the "last edited by" line W3's conflict check needs. */
async function actor(): Promise<string | null> {
  const session = await getSessionUser();
  return session?.userId ?? null;
}

/** See the identical helper in the client-facing route. */
async function write(fn: () => Promise<void>): Promise<NextResponse | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    console.error("[branding] write failed:", err);
    return NextResponse.json({ error: BRANDING_WRITE_FAILED }, { status: 500 });
  }
}

async function audit(
  req: NextRequest,
  clientId: string,
  action: string,
  metadata?: Record<string, unknown>,
) {
  await record({
    action,
    targetType: "client",
    targetId: clientId,
    clientId,
    ...requestContext(req),
    metadata: metadata ?? null,
  });
}
