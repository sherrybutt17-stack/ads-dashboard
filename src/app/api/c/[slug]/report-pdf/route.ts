import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, agencyGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { isValidDateKey, rangeLabel } from "@/lib/dates";
import { mintRenderToken } from "@/lib/report/render-token";
import { PdfRenderError, isPdfConfigured, renderPdf } from "@/lib/report/pdf";
import { exportFilename } from "@/lib/export/csv";
import { appBaseUrl } from "@/lib/app-url";

/**
 * Download this report as a PDF.
 *
 * The flow is three steps and each one is deliberate:
 *
 *   1. sign a 90-second token covering this client and this exact range,
 *   2. hand the hosted renderer a URL carrying it,
 *   3. stream back the bytes.
 *
 * ── 🔴 The renderer fetches US, so the app must be publicly reachable ──
 *
 * There is no way around it — a hosted browser cannot see `localhost`. That is
 * detected in `renderPdf` and reported as a configuration problem rather than
 * as a timeout, because a thirty-second hang followed by a generic failure is
 * the single most misleading way this could break.
 *
 * ── Why not render the HTML ourselves and POST it ─────────────────────
 *
 * It removes the auth problem entirely, and it breaks the output: the
 * stylesheet is a build asset the renderer would then have to fetch from us
 * anyway, and Recharts draws its SVG after hydration, so a static HTML string
 * carries no charts at all. Handing over a URL keeps one code path producing
 * the document, which is the property that makes the PDF trustworthy.
 */

const QuerySchema = z.object({
  platform: z.enum(["meta", "google"]).default("meta"),
  start: z.string().refine(isValidDateKey, "Invalid start"),
  end: z.string().refine(isValidDateKey, "Invalid end"),
});

/**
 * Tight, because each call spends money at the render provider and runs a full
 * dashboard load on our side to serve the page being rendered.
 */
const PDF_LIMIT = 10;
const PDF_WINDOW_MS = 10 * 60_000;

/** Longer than the renderer's own timeout, so theirs is the one that fires. */
const RENDER_TIMEOUT_MS = 45_000;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = await agencyGuard();
  if (denied) return denied;

  const { slug } = await ctx.params;
  /*
   * Tenant-scoped, ON TOP OF the guard above rather than instead of it. The
   * guard says who the caller is; this says the client is theirs. `slug` is
   * derived from a business name and therefore guessable, so an unscoped
   * read here was reachable by typing one.
   */
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!isPdfConfigured()) {
    /*
     * 501 rather than 500: this is a capability the deployment does not have,
     * not a failure of one it does. The UI never shows the button in this
     * state, so reaching here means a hand-typed URL or a stale tab.
     */
    return NextResponse.json(
      {
        error:
          "PDF rendering is not configured. Set PDF_RENDER_KEY, or use the print button.",
      },
      { status: 501 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    platform: sp.get("platform") ?? "meta",
    start: sp.get("start"),
    end: sp.get("end"),
  });
  if (!parsed.success || parsed.data.start > parsed.data.end) {
    return NextResponse.json({ error: "Invalid range" }, { status: 400 });
  }
  const { platform, start, end } = parsed.data;

  const gate = rateLimit(`pdf:${client.id}`, PDF_LIMIT, PDF_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many PDFs just now. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const base = appBaseUrl();
  if (!base) {
    return NextResponse.json(
      {
        error:
          "This deployment's public URL could not be determined, so the " +
          "renderer has no address to fetch. Set NEXT_PUBLIC_APP_URL.",
      },
      { status: 501 },
    );
  }

  const token = mintRenderToken({
    clientId: client.id,
    start,
    end,
    platform,
  });

  let bytes: Uint8Array;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    bytes = await renderPdf(`${base}/render/${token}`, {
      signal: controller.signal,
    });
  } catch (err) {
    console.error("[pdf] render failed:", err);
    const known = err instanceof PdfRenderError;
    return NextResponse.json(
      {
        /*
         * A configuration problem is quoted back verbatim — "your key was
         * rejected" and "the renderer cannot reach localhost" are both
         * actionable, and hiding them behind a generic message would send an
         * operator looking through their own data for a fault that is in an
         * environment variable. Anything else stays generic; a third party's
         * error text is not ours to forward.
         */
        error:
          known && (err as PdfRenderError).configurable
            ? (err as PdfRenderError).message
            : "Could not render the PDF. The print button still works.",
      },
      { status: known ? (err as PdfRenderError).status : 502 },
    );
  } finally {
    clearTimeout(timer);
  }

  await record({
    action: "client.report_pdf",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: { platform, start, end, bytes: bytes.length },
  });

  const filename = exportFilename(client.slug, "report", start, end).replace(
    /\.csv$/,
    ".pdf",
  );

  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Contains a client's spend. Never a shared cache.
      "Cache-Control": "no-store, must-revalidate",
      // Named for the log line, not for the browser.
      "X-Report-Range": rangeLabel(start, end),
    },
  });
}
