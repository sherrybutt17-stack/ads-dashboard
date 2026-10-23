import { NextResponse } from "next/server";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { DomainApiError } from "@/lib/email-domains/resend-domains";
import { getAgencyDomain, toDomainView } from "@/lib/email-domains/store";
import { refreshDomain } from "@/lib/email-domains/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Check now": ask Resend to look at the agency's DNS again, and report what
 * it says.
 *
 * Resend checks asynchronously, so the answer straight after asking is often
 * still "Checking" — the tab says so, and the hourly report job keeps reading
 * it until it settles. Tenant from the session only, as on every
 * `/api/agency/*` route. Rate-limited per agency: every press is two requests
 * against a Resend team that every agency shares.
 */

const CHECK_LIMIT = 30;
const CHECK_WINDOW_MS = 10 * 60_000;

export async function POST() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agencyId = session!.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }
  const gate = rateLimit(`agency-email-domain-check:${agencyId}`, CHECK_LIMIT, CHECK_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "That's a lot of checks. DNS changes can take a while — try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const row = await getAgencyDomain(agencyId);
  if (!row) return NextResponse.json({ error: "There's no domain set up to check." }, { status: 404 });

  try {
    const updated = await refreshDomain(row, { verify: true, timeoutMs: 8_000 });
    return NextResponse.json({ ok: true, domain: toDomainView(updated) });
  } catch (err) {
    if (err instanceof DomainApiError) {
      if (err.status === 404) {
        return NextResponse.json(
          { error: "This domain is no longer set up at our email service. Remove it here and add it again." },
          { status: 409 },
        );
      }
      // Never Resend's own 401/403: in this app those mean "not allowed".
      if (err.ours) console.error(`[email-domain] Resend refused our request (${err.status} ${err.code ?? ""})`);
      const status = err.ours ? 503 : err.status === 429 ? 429 : err.status >= 500 ? 502 : 503;
      return NextResponse.json({ error: err.message }, { status });
    }
    console.error("[email-domain] check failed", err);
    return NextResponse.json({ error: "Couldn't check just now. Try again in a minute." }, { status: 502 });
  }
}
