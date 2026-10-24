import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, clientAccessGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { rateLimit } from "@/lib/rate-limit";
import { MAX_RANGE_DAYS, eachDateKey, isValidDateKey, windowFromKeys } from "@/lib/dates";
import { loadWidgetData, type BoardMode } from "@/lib/board/aggregate";
import { loadBoardContext } from "@/lib/board/context";
import { decodeWidgetQuery } from "@/lib/board/query";
import { WidgetQuerySchema } from "@/lib/board/schema";
import type { WidgetQuery } from "@/lib/board/types";

/**
 * One widget's numbers, for the editor's live preview and for a tile the page
 * left pending (reach).
 *
 * GET with the question in the URL — `?w=<base64url>&start=&end=` — because the
 * client-tier allowlist lets reads reach below `board` and keeps writes at
 * `board` itself. Nothing here writes, except the reach cache, which is the
 * only reason this route can be slow and the reason it has its own limit.
 *
 * Validation before any query: the encoded question is decoded, checked
 * against the same schema a save uses, and the range must be real and no
 * longer than the dashboard allows.
 */

const READ_LIMIT = 300;
const REACH_LIMIT = 10;
const WINDOW_MS = 10 * 60_000;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const denied = await clientAccessGuard(slug);
  if (denied) return denied;
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const parsed = WidgetQuerySchema.safeParse(decodeWidgetQuery(sp.get("w")));
  if (!parsed.success) {
    return NextResponse.json({ error: "That widget is not valid." }, { status: 400 });
  }
  const query = parsed.data as WidgetQuery;

  const start = sp.get("start");
  const end = sp.get("end");
  if (!isValidDateKey(start) || !isValidDateKey(end) || start > end) {
    return NextResponse.json({ error: "Choose a valid date range." }, { status: 400 });
  }
  const window = windowFromKeys(start, end, client.timezone);
  if (eachDateKey(window, client.timezone).length > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `Choose a range of at most ${MAX_RANGE_DAYS} days.` },
      { status: 400 },
    );
  }

  const gate = rateLimit(`board-data:${client.id}`, READ_LIMIT, WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many requests just now. Try again in a minute." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  // The client's agency metrics resolve here, server-side, from the client row —
  // never from anything in the request.
  const context = await loadBoardContext(client);

  // A reach question (or the agency's own name for one) may call Meta; past its
  // own limit it reads the cache only.
  let mode: BoardMode = "api";
  const base = query.kind === "kpi" ? context.registry.base(query.metric) : null;
  if (base === "reach" || base === "frequency") {
    const reachGate = rateLimit(`board-reach:${client.id}`, REACH_LIMIT, WINDOW_MS);
    if (!reachGate.ok) mode = "document";
  }

  const data = await loadWidgetData(
    {
      client,
      window,
      mode,
      connections: context.connections,
      assets: {
        logoSrc: context.branding.hasLogo
          ? `/api/c/${encodeURIComponent(slug)}/branding/logo?v=${context.branding.logoVersion}`
          : null,
        brandName: context.brandName,
      },
      registry: context.registry,
    },
    query,
  );
  return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
}
