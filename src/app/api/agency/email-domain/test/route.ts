import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";
import { EmailError, emailConfigured } from "@/lib/reports/email";
import { getAgencySettings } from "@/lib/branding-store";
import { getUserById } from "@/lib/users";
import { sendForAgency } from "@/lib/email-domains/deliver";
import { renderTestEmail } from "@/lib/email-domains/test-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Send a test email" — to the operator's OWN login address, never one typed
 * into the form, so this cannot be pointed at a stranger's inbox.
 *
 * It goes through `sendForAgency`, the same path every client email takes, and
 * says which way it actually went: a domain that looks verified here but is
 * refused by Resend shows up as "sent from our address" rather than as a false
 * all-clear. Five an hour per agency.
 */

const TEST_LIMIT = 5;
const TEST_WINDOW_MS = 60 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agencyId = session!.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }
  const gate = rateLimit(`agency-email-domain-test:${agencyId}`, TEST_LIMIT, TEST_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "That's five test emails this hour. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }
  if (!emailConfigured()) {
    return NextResponse.json({ error: "Email isn't set up on this dashboard." }, { status: 501 });
  }

  const me = await getUserById(session!.userId).catch(() => null);
  if (!me) {
    return NextResponse.json(
      { error: "Sign in with your own login to send yourself a test email." },
      { status: 409 },
    );
  }

  const { agencyName } = await getAgencySettings(agencyId);
  try {
    const sent = await sendForAgency(
      agencyId,
      { to: [me.email], ...renderTestEmail(agencyName ?? "") },
      { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    );
    void audit.record({
      action: "agency.email_domain_test_sent",
      targetType: "agency",
      targetId: agencyId,
      agencyId,
      metadata: { via: sent.via, fellBack: Boolean(sent.fellBack) },
      ...audit.requestContext(req),
    });
    return NextResponse.json({ ok: true, to: me.email, via: sent.via, from: sent.from, fellBack: sent.fellBack });
  } catch (err) {
    console.error("[email-domain] test send failed", err);
    const configurable = err instanceof EmailError && err.configurable;
    return NextResponse.json(
      {
        error: configurable
          ? `The test email didn't send: ${(err as EmailError).message}`
          : "The test email didn't send. Try again in a minute.",
      },
      { status: configurable ? 503 : 502 },
    );
  }
}
