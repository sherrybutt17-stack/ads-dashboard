import { NextRequest, NextResponse } from "next/server";
import { requireClient } from "@/lib/auth";
import { record as recordAudit, requestContext } from "@/lib/audit";
import { revokeShareLink } from "@/lib/share";

/**
 * Revoke a share link.
 *
 * The only control that works after a URL has been forwarded, so it is a first
 * class operation rather than a cleanup task: no confirmation dance, no delay,
 * effective on the next request.
 *
 * The row is kept and stamped rather than deleted. "This link was revoked on
 * the 14th, after 3 views" is the question that actually gets asked when a link
 * goes somewhere it should not have, and a deleted row cannot answer it.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; linkId: string }> },
) {
  const { id, linkId } = await params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  /*
   * Scoped by BOTH ids. The pairing alone was never enough across tenants —
   * `id` came from the URL unverified, so supplying another agency's client id
   * alongside their link id revoked their link. `requireClient` establishes the
   * client is the caller's; the pairing then stops a link from one of their own
   * clients being revoked through another.
   */
  const revoked = await revokeShareLink(linkId, client.id);
  if (!revoked) {
    return NextResponse.json(
      { error: "Link not found, or already revoked" },
      { status: 404 },
    );
  }

  await recordAudit({
    action: "share_link.revoke",
    targetType: "share_link",
    targetId: linkId,
    clientId: client.id,
    ...requestContext(req),
  });

  return NextResponse.json({ ok: true });
}
