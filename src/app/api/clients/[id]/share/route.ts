import { NextRequest, NextResponse, after } from "next/server";
import { getSessionUser, requireClient, agencyGuard } from "@/lib/auth";
import { isValidDateKey, windowFromKeys } from "@/lib/dates";
import { record as recordAudit, requestContext } from "@/lib/audit";
import { emailConfig, senderProblem } from "@/lib/reports/email";
import { senderFor } from "@/lib/email-domains/deliver";
import {
  mintShareLink,
  listShareLinks,
  shareUrlFor,
  SHARE_TTL_DAYS,
  DEFAULT_SHARE_TTL_DAYS,
  MIN_SHARE_PASSWORD,
  viewForLink,
  boardForLink,
} from "@/lib/share";
import { describeView, isDefaultView, normalizeView, viewHasPersonal } from "@/lib/report/view";
import { loadBoardContext } from "@/lib/board/context";
import { getBoard } from "@/lib/board/store";
import { needsReach } from "@/lib/board/document";
import { ensurePeriodReach } from "@/lib/board/reach";
import type { BoardWidget } from "@/lib/board/types";
import type { ShareLink } from "@/db/schema";

/** What the list says a link contains; null for the standard report. */
function contentsOf(link: ShareLink): string | null {
  // A board first: `viewForLink` would read its snapshot as the standard report.
  const board = boardForLink(link);
  if (board) {
    return `Board · ${board.widgets.length} widget${board.widgets.length === 1 ? "" : "s"}`;
  }
  const view = viewForLink(link);
  return isDefaultView(view) ? null : describeView(view);
}

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
  /*
   * Whether this deployment can email a link, answered alongside the list
   * rather than from its own endpoint: `ShareReport` already calls this on
   * open, so it costs one field and no extra request, and it keeps the
   * server-only `emailConfigured()` out of the page component.
   *
   * The field NAMES match what `ReportSchedule` already consumes, deliberately
   * — two panels explaining the same misconfiguration should say the same
   * sentence, and `senderProblem` is already written to be read by an operator.
   */
  const cfg = emailConfig();
  return NextResponse.json({
    email: {
      configured: cfg !== null,
      senderProblem: cfg ? senderProblem(cfg.from) : null,
      // Whose address an emailed link would leave from. Never throws.
      sender: await senderFor(got.client.agencyId),
    },
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
      // Null for the standard report, so the list only calls out a choice.
      contents: contentsOf(l),
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

  const {
    rangeStart,
    rangeEnd,
    platform,
    label,
    ttlDays,
    password,
    view: rawView,
    document: rawDocument,
  } = body as Record<string, unknown>;
  const isBoard = rawDocument === "board";

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

  // Absent means the standard report. Present but empty or unreadable is a
  // mistake to report, not a reason to quietly send something else.
  const view = isBoard || rawView === undefined || rawView === null ? null : normalizeView(rawView);
  if (!isBoard && rawView !== undefined && rawView !== null && !view) {
    return NextResponse.json(
      { error: "Pick at least one section to include." },
      { status: 400 },
    );
  }

  /*
   * 🔴 A board link freezes the board AS STORED, read here — never widgets
   * from the request body. A body is whatever the caller sends; publishing
   * it would let a request mint a link to a board nobody built, under this
   * client's name and figures.
   */
  let board: BoardWidget[] | null = null;
  // The agency's metrics, frozen into the link with the widgets that name them.
  let context: Awaited<ReturnType<typeof loadBoardContext>> | null = null;
  if (isBoard) {
    context = await loadBoardContext(client);
    board = (await getBoard(client.id, context.starter)).widgets;
    if (board.length === 0) {
      return NextResponse.json({ error: "This board is empty. Add a widget before sharing it." }, { status: 400 });
    }
  }

  const session = await getSessionUser();
  let token: string;
  let row: Awaited<ReturnType<typeof mintShareLink>>["row"];
  try {
    ({ token, row } = await mintShareLink({
      clientId: client.id,
      rangeStart: rangeStart as string,
      rangeEnd: rangeEnd as string,
      platform: !isBoard && typeof platform === "string" ? platform : "meta",
      label: typeof label === "string" ? label : null,
      ttlDays: ttlDays === undefined ? DEFAULT_SHARE_TTL_DAYS : ttl,
      password: pass || null,
      createdBy: session?.userId ?? null,
      view,
      board,
      boardMetrics: context?.metrics,
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
      ...(board
        ? { document: "board", widgets: board.length }
        : { sections: view?.sections ?? null, includesLeadNames: view ? viewHasPersonal(view) : false }),
    },
  });

  /*
   * The shared page reads reach from the cache only, so ask Meta now, after
   * the response: the link is ready the moment it is shown, and by the time
   * someone opens it the figure is usually there.
   */
  if (board && needsReach(board, context?.registry)) {
    const window = windowFromKeys(row.rangeStart, row.rangeEnd, client.timezone);
    after(async () => {
      await ensurePeriodReach(client, window);
    });
  }

  return NextResponse.json({
    id: row.id,
    // Returned exactly once. There is no endpoint that can show it again.
    url: shareUrlFor(token),
    expiresAt: row.expiresAt.toISOString(),
  });
}
