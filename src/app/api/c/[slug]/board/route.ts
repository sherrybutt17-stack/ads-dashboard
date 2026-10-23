import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, clientAccessGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { loadBoardContext } from "@/lib/board/context";
import { ClientBoardWriteSchema, StaffBoardWriteSchema } from "@/lib/board/schema";
import { getBoard, resetBoard, saveBoard, type StoredBoard } from "@/lib/board/store";
import { authorizeBoardWrite } from "@/lib/board/write";
import type { BoardWidget } from "@/lib/board/types";

/**
 * A client's widget board: read it, save it, reset it.
 *
 * The order in PUT and DELETE is the point, and is the section layout route's:
 *   1. tenant — `clientAccessGuard` + `getClientForSession` (404, not 403, for
 *      a board that is not yours: its existence is not confirmed);
 *   2. the STORED board, read before the request body is trusted;
 *   3. role and lock — `authorizeBoardWrite` on that stored row;
 *   4. rate limit, then the body, validated by the schema for the CALLER's
 *      role: only staff may send `locked`, and a client body naming it fails.
 *
 * Client-tier on purpose (see `CLIENT_RESOURCES.board`): the agency and the
 * client build the board together.
 */

const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 10 * 60_000;

/** One bucket for saves and resets: both rewrite the same row. */
function writeGate(clientId: string): NextResponse | null {
  const gate = rateLimit(`board:${clientId}`, WRITE_LIMIT, WRITE_WINDOW_MS);
  if (gate.ok) return null;
  return NextResponse.json(
    { error: "Too many changes just now. Try again in a few minutes." },
    { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
  );
}

function serialise(board: StoredBoard) {
  return {
    widgets: board.widgets,
    locked: board.locked,
    customised: board.customised,
    updatedAt: board.updatedAt?.toISOString() ?? null,
    updatedBy: board.updatedBy,
    dropped: board.dropped,
    problem: board.problem,
  };
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const denied = await clientAccessGuard(slug);
  if (denied) return denied;
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const context = await loadBoardContext(client);
  const board = await getBoard(client.id, context.starter);
  return NextResponse.json({ board: serialise(board) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const denied = await clientAccessGuard(slug);
  if (denied) return denied;
  const session = await getSessionUser();
  const client = await getClientForSession(session, slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const context = await loadBoardContext(client);
  // The STORED board, read before anything from the request is trusted.
  const current = await getBoard(client.id, context.starter);
  const verdict = authorizeBoardWrite(session, slug, current);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  const limited = writeGate(client.id);
  if (limited) return limited;

  const body: unknown = await req.json().catch(() => null);
  const parsed = verdict.staff
    ? StaffBoardWriteSchema.safeParse(body)
    : ClientBoardWriteSchema.safeParse(body);
  if (!parsed.success) {
    // The client schema is strict, so a client body naming the lock fails here.
    const triedLock =
      !verdict.staff && typeof body === "object" && body !== null && "locked" in body;
    return NextResponse.json(
      {
        error: triedLock
          ? "Only your agency can lock or unlock this board."
          : "This board could not be saved — one of its widgets is not valid.",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }
  const data = parsed.data;
  // Read off the staff shape only: a client payload cannot carry it at all.
  const locked = verdict.staff ? (data as { locked?: boolean }).locked : undefined;
  const widgets = data.widgets as BoardWidget[] | undefined;

  let outcome;
  try {
    outcome = await saveBoard(client.id, {
      widgets,
      ...(locked !== undefined ? { locked } : {}),
      updatedBy: session?.userId ?? null,
      ifUnmodifiedSince: data.ifUnmodifiedSince,
      expectNew: data.expectNew,
      starter: context.starter,
    });
  } catch (err) {
    console.error("[board] save failed:", err);
    return NextResponse.json(
      {
        error:
          "Could not save. If saving boards has never worked on this deployment, the database migration for it has not been applied yet.",
      },
      { status: 500 },
    );
  }

  if (!outcome.ok) {
    return NextResponse.json(
      {
        error: "Someone else saved this board while you were editing it.",
        board: serialise(outcome.current),
      },
      { status: 409 },
    );
  }

  await record({
    action: "board.update",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: {
      by: verdict.staff ? "staff" : "client",
      widgets: widgets?.length ?? null,
      ...(locked !== undefined && locked !== current.locked ? { locked } : {}),
    },
  });
  return NextResponse.json({ board: serialise(outcome.board) });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const denied = await clientAccessGuard(slug);
  if (denied) return denied;
  const session = await getSessionUser();
  const client = await getClientForSession(session, slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const context = await loadBoardContext(client);
  const current = await getBoard(client.id, context.starter);
  const verdict = authorizeBoardWrite(session, slug, current);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  const limited = writeGate(client.id);
  if (limited) return limited;

  try {
    await resetBoard(client.id);
  } catch (err) {
    console.error("[board] reset failed:", err);
    return NextResponse.json({ error: "Could not reset." }, { status: 500 });
  }
  await record({
    action: "board.reset",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: { by: verdict.staff ? "staff" : "client" },
  });
  return NextResponse.json({ board: serialise(await getBoard(client.id, context.starter)) });
}
