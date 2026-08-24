import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, requireClient, agencyGuard } from "@/lib/auth";
import { isValidDateKey } from "@/lib/dates";
import { record as recordAudit, requestContext } from "@/lib/audit";
import {
  mintShareLink,
  listShareLinks,
  shareUrlFor,
  SHARE_TTL_DAYS,
  DEFAULT_SHARE_TTL_DAYS,
  MIN_SHARE_PASSWORD,
} from "@/lib/share";

/**
 * Share links for one client — list and create.
 *
 * Staff only. A share link publishes a client's spend and outcomes to whoever
 * holds the URL, so minting one is an agency decision; the client-editable half
 * of white-label (W3) does not extend to it.
 */

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await agencyGuard();
  if (denied) return denied;

  const { id } = await params;
  /*
   * 🔴 This handler never loaded the client at all — it went straight from a
   * uuid in the URL to that client's share links. The staff guard proved the
   * caller was somebody; nothing proved the client was theirs, and share links
   * carry a label, a date range and a live/expired state for a business whose
   * name the caller may never have seen.
   */
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const links = await listShareLinks(got.client.id);
  /*
   * Liveness decided HERE, on the server clock, not in the browser.
   *
   * The client's clock is whatever the client's clock says. A machine an hour
   * fast would list a live link as expired; one an hour slow would offer to
   * revoke a link that already died. The server is the only party whose opinion
   * about expiry actually governs access, so it is the party that answers.
   */
  const now = Date.now();

  /*
   * The token is NOT in this response, and cannot be — only its hash was ever
   * stored. That is the point: a link is visible once, at creation. Re-showing
   * it later would mean keeping the credential, which is what the hash exists
   * to avoid.
   */
  return NextResponse.json({
    links: links.map((l) => ({
      id: l.id,
      label: l.label,
      rangeStart: l.rangeStart,
      rangeEnd: l.rangeEnd,
      platform: l.platform,
      hasPassword: Boolean(l.passwordHash),
      expiresAt: l.expiresAt.toISOString(),
      revokedAt: l.revokedAt?.toISOString() ?? null,
      active: !l.revokedAt && l.expiresAt.getTime() > now,
      createdAt: l.createdAt.toISOString(),
      createdBy: l.createdBy,
      viewCount: l.viewCount,
      lastViewedAt: l.lastViewedAt?.toISOString() ?? null,
    })),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await agencyGuard();
  if (denied) return denied;

  const { id } = await params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { rangeStart, rangeEnd, platform, label, ttlDays, password } = body as
    Record<string, unknown>;

  /*
   * Validate the range here rather than trusting the caller: it is frozen into
   * the row permanently, so a bad value is not a bad render — it is a link that
   * shows the wrong period to a board for the next ninety days.
   */
  if (
    !isValidDateKey(rangeStart as string) ||
    !isValidDateKey(rangeEnd as string) ||
    (rangeStart as string) > (rangeEnd as string)
  ) {
    return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
  }

  const ttl = Number(ttlDays);
  if (ttlDays !== undefined && !(SHARE_TTL_DAYS as readonly number[]).includes(ttl)) {
    return NextResponse.json(
      { error: `Expiry must be one of ${SHARE_TTL_DAYS.join(", ")} days` },
      { status: 400 },
    );
  }

  const pass = typeof password === "string" ? password.trim() : "";
  if (pass && pass.length < MIN_SHARE_PASSWORD) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_SHARE_PASSWORD} characters` },
      { status: 400 },
    );
  }

  const session = await getSessionUser();
  let token: string;
  let row: Awaited<ReturnType<typeof mintShareLink>>["row"];
  try {
    ({ token, row } = await mintShareLink({
      clientId: client.id,
      rangeStart: rangeStart as string,
      rangeEnd: rangeEnd as string,
      platform: typeof platform === "string" ? platform : "meta",
      label: typeof label === "string" ? label : null,
      ttlDays: ttlDays === undefined ? DEFAULT_SHARE_TTL_DAYS : ttl,
      password: pass || null,
      createdBy: session?.userId ?? null,
    }));
  } catch (err) {
    /*
     * Named rather than leaked. A raw Postgres error in a dialog tells the
     * operator nothing actionable, and the overwhelmingly likely cause here is
     * a pending migration — which is a fixable, specific thing to say.
     */
    console.error("[share] mint failed:", err);
    return NextResponse.json(
      {
        error:
          "Could not create the link. If share links have never worked on this deployment, the database migration for them has not been applied yet.",
      },
      { status: 500 },
    );
  }

  /*
   * Audited without the token. The audit log is read by more people than the
   * share list is, and writing a live credential into it would hand every
   * reader of the log access to every client's figures.
   */
  await recordAudit({
    action: "share_link.create",
    targetType: "share_link",
    targetId: row.id,
    clientId: id,
    ...requestContext(req),
    metadata: {
      rangeStart: row.rangeStart,
      rangeEnd: row.rangeEnd,
      expiresAt: row.expiresAt.toISOString(),
      hasPassword: Boolean(row.passwordHash),
    },
  });

  return NextResponse.json({
    id: row.id,
    // Returned exactly once. There is no endpoint that can show it again.
    url: shareUrlFor(token),
    expiresAt: row.expiresAt.toISOString(),
  });
}
