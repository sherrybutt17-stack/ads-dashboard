import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, clientAccessGuard, isAgencyOperator } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { loadDashboard, loadDeferredTables } from "@/lib/metrics/dashboard";
import { buildCsv, exportFilename, type CsvTable } from "@/lib/export/csv";
import { buildXlsx } from "@/lib/export/xlsx";
import { formatMeta, isExportFormat } from "@/lib/export/formats";
import { isPdfConfigured, renderPdf, PdfRenderError } from "@/lib/report/pdf";
import { mintRenderToken } from "@/lib/report/render-token";
import { appBaseUrl } from "@/lib/app-url";
import { AD_PLATFORMS } from "@/lib/platforms";
import { isValidDateKey } from "@/lib/dates";
import {
  DATASETS,
  DATASET_BUILDERS,
  DATASET_ROW_CAP,
  isDatasetId,
} from "@/lib/export/datasets";

/*
 * Explicit rather than inherited. The XLSX serialiser is a Node library that
 * zips a workbook in memory, so this route cannot run on the edge — and a
 * default that silently changes underneath a file which now depends on it is
 * the kind of thing that breaks on a framework upgrade rather than in review.
 */
export const runtime = "nodejs";

/**
 * CSV export — §6.20.
 *
 * ── Clients may export their own numbers; the lead list is still staff only ──
 *
 * `export` is carved out in `CLIENT_RESOURCES` (`proxy-rules.ts`), so a
 * client-role session reaches this file. Two checks then run in sequence and
 * neither is sufficient alone: `clientAccessGuard` asks whether this slug is
 * one of theirs, and `getClientForSession` asks whether that client belongs to
 * the caller's agency.
 *
 * 🔴 Datasets flagged `personal` are refused for client-role callers. The rows
 * are people — named leads, their stage, their campaign — and "the client may
 * see their own dashboard" is not the same permission as "the client may take a
 * file of names away from it". Staff can still export it on their behalf, which
 * is what the audit entry at the bottom of this file exists to record.
 *
 * ── Why the numbers are re-derived rather than accepted from the caller ──
 *
 * The request carries a range and a dataset name, and nothing else. Every figure
 * in the file is computed here, through the same `loadDashboard` the page
 * renders from. A shape where the browser posts up the rows it is showing would
 * be one round trip cheaper and would make the export unfalsifiable — a
 * tampered or merely stale page would produce a file that looks authoritative
 * and reconciles against nothing.
 */

const QuerySchema = z.object({
  dataset: z.string().refine(isDatasetId, "Unknown dataset"),
  /*
   * Defaulted, so every link that predates formats keeps working untouched.
   * The menu has always linked without a `format`, and those URLs live on in
   * browser histories and in whatever an operator pasted into a message.
   */
  format: z.string().refine(isExportFormat, "Unknown format").default("csv"),
  /*
   * Every platform the dashboard has a tab for. This was `meta | google`, so
   * on the TikTok tab every export answered 400 — invisible while the menu was
   * staff-only, and a dead menu in front of clients once they could see it.
   */
  platform: z.enum(AD_PLATFORMS).default("meta"),
  /*
   * Real calendar dates, not just the right shape. The render page applies
   * exactly these checks to a PDF's range and answers 404 when they fail —
   * which a hosted renderer happily prints, so a malformed range used to come
   * back as a 200 PDF of a "not found" page. Refused here, as a 400, instead.
   */
  start: z.string().refine(isValidDateKey).optional(),
  end: z.string().refine(isValidDateKey).optional(),
}).refine((q) => !q.start || !q.end || q.start <= q.end, {
  message: "Range starts after it ends",
});

/**
 * Deliberately tight. An export is a person clicking a button, so a handful per
 * minute is generous — and each one costs a full dashboard load, which makes
 * this the most expensive GET in the application.
 */
const EXPORT_LIMIT = 20;
const EXPORT_WINDOW_MS = 5 * 60_000;

/*
 * Tighter again for PDF, and deliberately the same bucket key
 * `report-pdf/route.ts` uses so the two share one budget: both spend the same
 * third-party quota, and a limit either one could exhaust independently is not
 * a limit on the spend.
 */
const PDF_LIMIT = 10;
const PDF_WINDOW_MS = 10 * 60_000;
/** Under the render token's 90s TTL, with room to spare. */
const PDF_TIMEOUT_MS = 45_000;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;

  const denied = await clientAccessGuard(slug);
  if (denied) return denied;

  /*
   * Tenant-scoped, ON TOP OF the guard above rather than instead of it. The
   * guard says who the caller is; this says the client is theirs. `slug` is
   * derived from a business name and therefore guessable, so an unscoped
   * read here was reachable by typing one.
   */
  const session = await getSessionUser();
  const client = await getClientForSession(session, slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    dataset: sp.get("dataset") ?? "",
    format: sp.get("format") ?? "csv",
    platform: sp.get("platform") ?? "meta",
    start: sp.get("start") ?? undefined,
    end: sp.get("end") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid export request" }, { status: 400 });
  }
  const { dataset, format, platform, start, end } = parsed.data;

  /*
   * 🔴 The lead list does not leave with a client-role user.
   *
   * 403 with a reason, not 404. The dataset exists and is named in a static
   * constant every caller can already read, so there is nothing to conceal and
   * a 404 would simply be false — the same argument `resolveShareToken` makes
   * for saying "this link expired" rather than "not found". A refusal a person
   * can act on is worth more than one that sends them back to the sender.
   *
   * The menu filters these out, so reaching this line means a hand-typed URL.
   */
  if (
    DATASETS.find((d) => d.id === dataset)?.personal &&
    !isAgencyOperator(session)
  ) {
    return NextResponse.json(
      {
        error:
          "That export contains lead names and is available to agency staff only.",
      },
      { status: 403 },
    );
  }

  /*
   * Client-role callers get their own buckets. The limits are per client, and
   * the client could otherwise spend the whole allowance — including the
   * shared PDF budget that the agency's full-report PDF draws on — and lock
   * the agency out of exporting its own client's report.
   */
  const operator = isAgencyOperator(session);
  const bucket = operator ? client.id : `${client.id}:client`;

  /*
   * A PDF's preconditions are checked BEFORE any budget is spent or any data
   * loaded. A deployment that cannot render PDFs used to take a full dashboard
   * load and an export token to say so.
   */
  let renderBase: string | null = null;
  if (formatMeta(format).metered) {
    if (!isPdfConfigured()) {
      return NextResponse.json(
        {
          error:
            "PDF rendering is not configured on this deployment. Set PDF_RENDER_KEY.",
        },
        { status: 501 },
      );
    }
    renderBase = appBaseUrl();
    if (!renderBase) {
      return NextResponse.json(
        {
          error:
            "This deployment's public URL could not be determined, so the " +
            "renderer has no address to fetch. Set NEXT_PUBLIC_APP_URL.",
        },
        { status: 501 },
      );
    }
    /*
     * A SECOND gate, sharing its key with `report-pdf/route.ts` for staff. A
     * CSV is a string concatenation; a PDF is a paid call to a third party
     * that takes seconds, so the two should not share a budget with each
     * other — and the two PDF routes should.
     */
    const pdfGate = rateLimit(`pdf:${bucket}`, PDF_LIMIT, PDF_WINDOW_MS);
    if (!pdfGate.ok) {
      return NextResponse.json(
        { error: "Too many PDFs. Try again shortly." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(pdfGate.retryAfterMs / 1000)),
          },
        },
      );
    }
  }

  const gate = rateLimit(`export:${bucket}`, EXPORT_LIMIT, EXPORT_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many exports. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  /*
   * `ArrayBuffer` rather than `Uint8Array` for the binary case: a typed array
   * is generic over `ArrayBufferLike`, which admits `SharedArrayBuffer`, and
   * `BodyInit` will not accept that. Detached below with a copy — a few hundred
   * kilobytes once per download, against a cast that would silently be wrong if
   * the view were ever backed by shared memory.
   */
  let body: string | ArrayBuffer;
  let rangeStart: string;
  let rangeEnd: string;
  let rows: number;
  let truncated = false;

  try {
    const builder = DATASET_BUILDERS[dataset];
    let table: CsvTable;

    if (builder.source === "deferred") {
      /*
       * The one shape that does not read the date range. `monthOnMonth` is a
       * fixed trailing 12 months by design — the same reason the table on the
       * page carries a "Fixed trailing windows" label — so the bounds come from
       * the rows themselves rather than from the range the operator happened to
       * have selected.
       */
      const tables = await loadDeferredTables(client, platform);
      table = builder.build(tables);
      [rangeStart, rangeEnd] = builder.range(tables);
    } else {
      const data = await loadDashboard(
        client,
        start && end ? { startKey: start, endKey: end } : {},
        platform,
      );
      rangeStart = data.range.startKey;
      rangeEnd = data.range.endKey;
      table = builder.build(data);
    }

    rows = table.rows.length;
    /*
     * 🔴 The source query has a ceiling and used to hit it in silence — the
     * file simply ended. A client reconciling a busy month against their CRM
     * then finds a shortfall with nothing on the page or in the file to explain
     * it. Equality rather than `>=` because the cap IS the limit: more rows
     * than the cap cannot come back.
     */
    const cap = DATASET_ROW_CAP[dataset];
    truncated = cap !== undefined && rows === cap;

    switch (format) {
      case "xlsx": {
        const label = DATASETS.find((d) => d.id === dataset)?.label ?? dataset;
        const bytes = await buildXlsx([{ name: label, table }]);
        body = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        break;
      }
      case "pdf": {
        // Preconditions and the PDF budget were settled before any data load.
        const base = renderBase!;
        /*
         * Minted immediately before the fetch, so the 90-second token TTL has
         * ~45 seconds of headroom over the abort below rather than being spent
         * on the queries above.
         */
        const renderToken = mintRenderToken({
          clientId: client.id,
          start: rangeStart,
          end: rangeEnd,
          platform,
          dataset,
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PDF_TIMEOUT_MS);
        try {
          const bytes = await renderPdf(`${base}/render/${renderToken}`, {
            signal: controller.signal,
            /* Dataset tables are wide — `daily` alone is nineteen columns. */
            landscape: true,
          });
          body = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
        } finally {
          clearTimeout(timer);
        }
        break;
      }
      default:
        body = buildCsv(table);
    }
  } catch (err) {
    console.error("[export] failed:", err);
    /*
     * A misconfigured or exhausted render provider is something the operator
     * can fix, and `PdfRenderError` already carries a sentence written to be
     * read. Collapsing it into "Could not build the export" would send them
     * looking through their own report data for a problem that is in an env
     * var. Anything else stays generic — an internal failure is not the
     * caller's to debug.
     */
    if (err instanceof PdfRenderError && err.configurable) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Error && err.name === "AbortError") {
      return NextResponse.json(
        { error: "The PDF took too long to render. Try a narrower range." },
        { status: 504 },
      );
    }
    return NextResponse.json(
      { error: "Could not build the export." },
      { status: 500 },
    );
  }

  const fmt = formatMeta(format);
  const filename = exportFilename(
    client.slug,
    dataset,
    rangeStart,
    rangeEnd,
    fmt.ext,
  );

  await record({
    action: "client.exported",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: {
      dataset,
      platform,
      rows,
      start: rangeStart,
      end: rangeEnd,
      /*
       * Recorded because the leads dataset carries names, and "who took a copy
       * of the lead list, when" is the question an audit log exists to answer.
       */
      personal: DATASETS.find((d) => d.id === dataset)?.personal === true,
      format,
      /** Recorded so "their copy was short" is answerable after the fact. */
      truncated,
      /*
       * Who, since clients can now export too. Without the role, a client
       * pulling their own numbers and the agency pulling them on the client's
       * behalf were the same audit row.
       */
      actorRole: session?.role ?? null,
      actorUserId: session?.userId ?? null,
    },
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      /*
       * For CSV, `charset=utf-8` sits alongside the BOM the serialiser writes.
       * Belt and braces: the header covers consumers that fetch the URL, the
       * BOM covers Excel opening the saved file, and neither one covers the
       * other. XLSX carries its encoding inside the container and needs
       * neither.
       */
      "Content-Type": fmt.mime,
      "Content-Disposition": `attachment; filename="${filename}"`,
      /*
       * Never cached. These files contain a client's spend and their leads'
       * names, and a shared or proxy cache holding one is a cross-tenant leak
       * waiting for a URL collision.
       */
      "Cache-Control": "no-store, must-revalidate",
      ...(truncated ? { "X-Export-Truncated": String(rows) } : {}),
    },
  });
}
