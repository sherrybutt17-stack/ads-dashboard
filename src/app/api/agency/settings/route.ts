import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { getAgencySettings, saveAgencySettings } from "@/lib/branding-store";
import { readLogoUpload } from "@/lib/branding-write";
import { rateLimit } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An agency's own mark — the name, the wordmark and the contact line that get
 * printed on every report it sends.
 *
 * ── Why this route did not exist until now ───────────────────────────────
 *
 * `saveAgencySettings` has been in `branding-store.ts` with no caller: the
 * fields were designed, stored and rendered, and never made settable. With one
 * tenant that was merely unfinished — the operator could edit the row by hand.
 * Self-serve sign-up turns it into a product gap, because a new agency's
 * reports carry a mark it has no way to change.
 *
 * ── 🔴 The tenant is the session's, never the request's ──────────────────
 *
 * There is no `:agencyId` in this path and no agency id in the body, on
 * purpose. Every other shape — a path parameter, a field — would need an
 * ownership check that could be forgotten, and forgetting it would let one
 * agency rewrite another's letterhead. Taking the tenant from the session
 * removes the question rather than answering it.
 */

const SettingsSchema = z
  .object({
    /**
     * A trading name to print INSTEAD of the tenant's own.
     *
     * Empty string means "clear the override", not "print nothing" —
     * `saveAgencySettings` maps it to null, and null resolves back to
     * `agencies.name`. That is why the form sends "" rather than omitting the
     * key: omitting it means "leave unchanged".
     */
    agencyName: z.string().trim().max(120).optional(),
    agencyMarkMode: z.enum(["full", "prepared_by", "none"]).optional(),
    supportEmail: z
      .union([z.string().trim().email(), z.literal("")])
      .optional(),
  })
  .strict();

const WRITE_LIMIT = 20;
const WRITE_WINDOW_MS = 10 * 60_000;

export async function GET() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!session!.agencyId) {
    // The pre-tenancy shared-password bootstrap. It has a role but no tenant,
    // so there is nothing here for it to edit.
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }
  return NextResponse.json({ settings: await getAgencySettings(session!.agencyId) });
}

export async function PUT(req: NextRequest) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agencyId = session!.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }

  // Keyed by agency: the resource is this tenant's row, so a limit an actor
  // could multiply by changing networks would not protect it.
  const gate = rateLimit(`agency-settings:${agencyId}`, WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes just now. Try again in a few minutes." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const ctx = audit.requestContext(req);
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    /*
     * Shared with the client-branding route rather than reimplemented. It
     * sniffs the magic bytes and rejects anything whose content disagrees with
     * its declared type — this endpoint stores bytes that are served back
     * later, and a Content-Type taken on trust is how an "image" ends up being
     * served as something else.
     */
    const form = await req.formData().catch(() => null);
    const result = await readLogoUpload(form);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    await saveAgencySettings(agencyId, { logo: result.logo });
    void audit.record({
      action: result.logo ? "agency.logo_uploaded" : "agency.logo_removed",
      targetType: "agency",
      targetId: agencyId,
      agencyId,
      ...ctx,
    });
    return NextResponse.json({ ok: true, logo: Boolean(result.logo) });
  }

  const parsed = SettingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  await saveAgencySettings(agencyId, parsed.data);
  void audit.record({
    action: "agency.settings_update",
    targetType: "agency",
    targetId: agencyId,
    agencyId,
    // The keys, not the values: what changed is the useful part of the trail,
    // and a support email is personal data that does not need a second home.
    metadata: { fields: Object.keys(parsed.data) },
    ...ctx,
  });

  return NextResponse.json({ ok: true, settings: await getAgencySettings(agencyId) });
}
