import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";
import { agencyEmailConfigured, emailConfig } from "@/lib/reports/email";
import { DEFAULT_FROM_LOCAL, normalizeDomain, normalizeLocalPart } from "@/lib/email-domains/identity";
import { DomainApiError, createDomain, deleteDomain } from "@/lib/email-domains/resend-domains";
import {
  deleteAgencyDomain,
  getAgencyDomain,
  insertAgencyDomain,
  toDomainView,
  updateSenderDetails,
} from "@/lib/email-domains/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An agency's sending domain: add it, change who it sends as, remove it.
 *
 * ── 🔴 The tenant is the session's, never the request's ──────────────────
 *
 * The same contract as `/api/agency/settings`, for a sharper reason: a domain
 * row decides whose address an agency's invites and reports go out from. There
 * is no agency id in this path or in anything the form sends, so there is no
 * ownership check to forget.
 *
 * ── Resend first, then the row ───────────────────────────────────────
 *
 * Adding creates the domain in Resend, then stores it. If storing fails, the
 * Resend domain is deleted again — otherwise it would sit in our Resend team
 * with nothing here pointing at it, and the agency could never add it again
 * ("already registered"). Removing goes the same way round: Resend first, so a
 * failure leaves the row (and the Remove button) in place to try again.
 */

const WRITE_LIMIT = 20;
const WRITE_WINDOW_MS = 10 * 60_000;

const optionalEmail = z.union([z.string().trim().toLowerCase().email().max(254), z.literal("")]).optional();

const AddSchema = z
  .object({
    domain: z.string().max(300),
    fromLocal: z.string().max(64).optional(),
    fromName: z.string().trim().max(100).optional(),
    replyTo: optionalEmail,
  })
  .strict();

const EditSchema = z
  .object({
    fromLocal: z.string().max(64).optional(),
    fromName: z.string().trim().max(100).optional(),
    replyTo: optionalEmail,
  })
  .strict();

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agencyId = session!.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }
  const gate = rateLimit(`agency-email-domain:${agencyId}`, WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes just now. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }
  if (!agencyEmailConfigured()) {
    return NextResponse.json(
      { error: "Custom sending domains aren't available on this dashboard yet." },
      { status: 501 },
    );
  }

  const parsed = AddSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the form and try again." }, { status: 400 });
  }
  const domain = normalizeDomain(parsed.data.domain, { platformFrom: emailConfig()?.from });
  if (!domain.ok) return NextResponse.json({ error: domain.error }, { status: 400 });
  const local = normalizeLocalPart(parsed.data.fromLocal ?? DEFAULT_FROM_LOCAL);
  if (!local.ok) return NextResponse.json({ error: local.error }, { status: 400 });

  if (await getAgencyDomain(agencyId)) {
    return NextResponse.json(
      { error: "You already have a domain set up. Remove it first to use a different one." },
      { status: 409 },
    );
  }

  let created;
  try {
    created = await createDomain(domain.domain);
  } catch (err) {
    return domainApiFailure(err);
  }

  let row;
  try {
    row = await insertAgencyDomain({
      agencyId,
      domain: domain.domain,
      resendDomainId: created.id,
      status: created.status,
      records: created.records,
      fromLocal: local.local,
      fromName: parsed.data.fromName || null,
      replyTo: parsed.data.replyTo || null,
      createdBy: session!.userId,
    });
  } catch (err) {
    console.error("[email-domain] could not store a new domain; removing it from Resend", err);
    await deleteDomain(created.id).catch((e) =>
      console.error(`[email-domain] and could not remove ${domain.domain} from Resend either`, e),
    );
    return NextResponse.json(
      { error: "Couldn't save the domain, so nothing was added. Try again in a minute." },
      { status: 500 },
    );
  }

  void audit.record({
    action: "agency.email_domain_added",
    targetType: "agency",
    targetId: agencyId,
    agencyId,
    metadata: { domain: row.domain, fromLocal: row.fromLocal },
    ...audit.requestContext(req),
  });

  return NextResponse.json({ ok: true, domain: toDomainView(row) });
}

export async function PATCH(req: NextRequest) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agencyId = session!.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }
  const gate = rateLimit(`agency-email-domain:${agencyId}`, WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes just now. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const parsed = EditSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the form and try again." }, { status: 400 });
  }
  const patch: { fromLocal?: string; fromName?: string | null; replyTo?: string | null } = {};
  if (parsed.data.fromLocal !== undefined) {
    const local = normalizeLocalPart(parsed.data.fromLocal);
    if (!local.ok) return NextResponse.json({ error: local.error }, { status: 400 });
    patch.fromLocal = local.local;
  }
  // Empty means "go back to the default", not "send with no name".
  if (parsed.data.fromName !== undefined) patch.fromName = parsed.data.fromName || null;
  if (parsed.data.replyTo !== undefined) patch.replyTo = parsed.data.replyTo || null;

  const row = await updateSenderDetails(agencyId, patch);
  if (!row) return NextResponse.json({ error: "There's no domain set up to change." }, { status: 404 });

  void audit.record({
    action: "agency.email_domain_updated",
    targetType: "agency",
    targetId: agencyId,
    agencyId,
    // The keys, not the values — the same rule as the settings route.
    metadata: { domain: row.domain, fields: Object.keys(patch) },
    ...audit.requestContext(req),
  });

  return NextResponse.json({ ok: true, domain: toDomainView(row) });
}

export async function DELETE(req: NextRequest) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agencyId = session!.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }
  const gate = rateLimit(`agency-email-domain:${agencyId}`, WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes just now. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const row = await getAgencyDomain(agencyId);
  if (!row) return NextResponse.json({ ok: true });

  try {
    await deleteDomain(row.resendDomainId);
  } catch (err) {
    return domainApiFailure(err);
  }
  await deleteAgencyDomain(agencyId);

  void audit.record({
    action: "agency.email_domain_removed",
    targetType: "agency",
    targetId: agencyId,
    agencyId,
    metadata: { domain: row.domain },
    ...audit.requestContext(req),
  });

  return NextResponse.json({ ok: true });
}

/**
 * A Resend refusal, as this app's status codes. Never Resend's own 401/403 —
 * in this app those mean "you are not allowed", and passing them through would
 * tell an operator their session is the problem when our key is.
 */
function domainApiFailure(err: unknown) {
  if (!(err instanceof DomainApiError)) {
    console.error("[email-domain] unexpected failure", err);
    return NextResponse.json({ error: "Something went wrong. Try again in a minute." }, { status: 502 });
  }
  if (err.code === "not_configured") return NextResponse.json({ error: err.message }, { status: 501 });
  if (err.ours) {
    // Our key or our plan — nothing the agency can change. Logged for us.
    console.error(`[email-domain] Resend refused our request (${err.status} ${err.code ?? ""})`);
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  if (err.status === 429) return NextResponse.json({ error: err.message }, { status: 429 });
  if (err.status >= 400 && err.status < 500) {
    // About what was typed — a domain registered elsewhere, an invalid name.
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error(`[email-domain] Resend failed (${err.status})`, err.message);
  return NextResponse.json({ error: err.message }, { status: 502 });
}
