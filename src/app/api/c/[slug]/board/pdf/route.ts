import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, clientAccessGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { MAX_RANGE_DAYS, eachDateKey, isValidDateKey, rangeLabel, windowFromKeys } from "@/lib/dates";
import { mintRenderToken } from "@/lib/report/render-token";
import { PdfRenderError, isPdfConfigured, renderPdf } from "@/lib/report/pdf";
import { exportFilename } from "@/lib/export/csv";
import { appBaseUrl } from "@/lib/app-url";
import { loadBoardContext } from "@/lib/board/context";
import { getBoard } from "@/lib/board/store";
import { needsReach } from "@/lib/board/document";
import { ensurePeriodReach } from "@/lib/board/reach";

/**
 * Download the board as a PDF — landscape sheets, as the print view shows them.
 *
 * The report's flow (`report-pdf`), with two differences:
 *
 *   · Client tier, not staff only. It is the client's own board, of figures
 *     they can already see; a PDF of it publishes nothing new.
 *   · Reach is asked for BEFORE the renderer arrives. The render page reads
 *     only cached reach — a public, token-authorised page must never make a
 *     Meta call — so without this a board with a reach tile would print "not
 *     available" for any range nobody had opened yet.
 *
 * The render token says `dataset: "board"` inside its signature, so it cannot
 * be replayed against the report or any dataset table, and they cannot be
 * replayed against it. What renders is the board as stored when the renderer
 * fetches the page, ninety seconds at most after this request.
 */

/** Shared with the report and the dataset PDFs: one budget per client at the render provider. */
const PDF_LIMIT = 10;
const PDF_WINDOW_MS = 10 * 60_000;
/** Longer than the renderer's own timeout, so theirs is the one that fires. */
const RENDER_TIMEOUT_MS = 45_000;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const denied = await clientAccessGuard(slug);
  if (denied) return denied;
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!isPdfConfigured()) {
    // A capability this deployment does not have; the button is hidden then.
    return NextResponse.json(
      { error: "PDF rendering is not configured. Use Print on the print view." },
      { status: 501 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const start = sp.get("start");
  const end = sp.get("end");
  if (!isValidDateKey(start) || !isValidDateKey(end) || start > end) {
    return NextResponse.json({ error: "Invalid range" }, { status: 400 });
  }
  const window = windowFromKeys(start, end, client.timezone);
  if (eachDateKey(window, client.timezone).length > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: `Choose a range of at most ${MAX_RANGE_DAYS} days.` }, { status: 400 });
  }

  const gate = rateLimit(`pdf:${client.id}`, PDF_LIMIT, PDF_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many PDFs just now. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const base = appBaseUrl();
  if (!base) {
    return NextResponse.json(
      {
        error:
          "This deployment's public URL could not be determined, so the renderer has no address to fetch. Set NEXT_PUBLIC_APP_URL.",
      },
      { status: 501 },
    );
  }

  const context = await loadBoardContext(client);
  const board = await getBoard(client.id, context.starter);
  if (needsReach(board.widgets)) {
    // Bounded by its own timeout; a slow Meta leaves the tile "not available"
    // in the PDF rather than holding the download.
    await ensurePeriodReach(client, window);
  }

  const token = mintRenderToken({
    clientId: client.id,
    start,
    end,
    // The board covers every platform at once; the claim is unused for it.
    platform: "meta",
    dataset: "board",
    view: "",
  });

  let bytes: Uint8Array;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    bytes = await renderPdf(`${base}/render/${token}`, { signal: controller.signal, landscape: true });
  } catch (err) {
    console.error("[pdf] board render failed:", err);
    const known = err instanceof PdfRenderError;
    return NextResponse.json(
      {
        error:
          known && (err as PdfRenderError).configurable
            ? (err as PdfRenderError).message
            : "Could not render the PDF. Print from the print view still works.",
      },
      { status: known ? (err as PdfRenderError).status : 502 },
    );
  } finally {
    clearTimeout(timer);
  }

  await record({
    action: "client.board_pdf",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: { start, end, widgets: board.widgets.length, bytes: bytes.length },
  });

  const filename = exportFilename(client.slug, "board", start, end, "pdf");
  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // A client's spend. Never a shared cache.
      "Cache-Control": "no-store, must-revalidate",
      "X-Report-Range": rangeLabel(start, end),
    },
  });
}
