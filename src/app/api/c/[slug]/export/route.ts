import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, agencyGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { loadDashboard, loadDeferredTables } from "@/lib/metrics/dashboard";
import { buildCsv, exportFilename } from "@/lib/export/csv";
import {
  DATASETS,
  campaignsTable,
  dailyTable,
  isDatasetId,
  leadsTable,
  monthlyTable,
} from "@/lib/export/datasets";

/**
 * CSV export — §6.20.
 *
 * ── Staff only, for now, and that is a decision rather than an oversight ──
 *
 * `export` is not in `CLIENT_RESOURCES` in `proxy-rules.ts`, so a client-role
 * session is refused at the edge before this file runs. Giving clients their own
 * export is a reasonable thing to want and a one-line carve-out — but a
 * carve-out is a change to the security model, and the plan is explicit that
 * those ship deliberately rather than as a side effect of a feature. Staff can
 * export on a client's behalf today.
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
  platform: z.enum(["meta", "google"]).default("meta"),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * Deliberately tight. An export is a person clicking a button, so a handful per
 * minute is generous — and each one costs a full dashboard load, which makes
 * this the most expensive GET in the application.
 */
const EXPORT_LIMIT = 20;
const EXPORT_WINDOW_MS = 5 * 60_000;

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

  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    dataset: sp.get("dataset") ?? "",
    platform: sp.get("platform") ?? "meta",
    start: sp.get("start") ?? undefined,
    end: sp.get("end") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid export request" }, { status: 400 });
  }
  const { dataset, platform, start, end } = parsed.data;

  const gate = rateLimit(`export:${client.id}`, EXPORT_LIMIT, EXPORT_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many exports. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  let csv: string;
  let rangeStart: string;
  let rangeEnd: string;
  let rows: number;

  try {
    if (dataset === "monthly") {
      /*
       * The one dataset that does not read the date range. `monthOnMonth` is a
       * fixed trailing 12 months by design — the same reason the table on the
       * page carries a "Fixed trailing windows" label — so it loads from
       * `loadDeferredTables` and the filename carries the months it actually
       * contains rather than the range the operator happened to have selected.
       */
      const tables = await loadDeferredTables(client, platform);
      const table = monthlyTable(tables.monthOnMonth);
      csv = buildCsv(table);
      rows = table.rows.length;
      rangeStart = tables.monthOnMonth[0]?.window.startKey ?? "";
      rangeEnd =
        tables.monthOnMonth[tables.monthOnMonth.length - 1]?.window.endKey ?? "";
    } else {
      const data = await loadDashboard(
        client,
        start && end ? { startKey: start, endKey: end } : {},
        platform,
      );
      rangeStart = data.range.startKey;
      rangeEnd = data.range.endKey;

      const table =
        dataset === "daily"
          ? dailyTable(data.daily)
          : dataset === "campaigns"
            ? campaignsTable(data.campaignStages.rows)
            : leadsTable(data.leads);
      csv = buildCsv(table);
      rows = table.rows.length;
    }
  } catch (err) {
    console.error("[export] failed:", err);
    return NextResponse.json(
      { error: "Could not build the export." },
      { status: 500 },
    );
  }

  const filename = exportFilename(client.slug, dataset, rangeStart, rangeEnd);

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
    },
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      /*
       * `charset=utf-8` alongside the BOM the serialiser writes. Belt and
       * braces: the header covers consumers that fetch the URL, the BOM covers
       * Excel opening the saved file, and neither one covers the other.
       */
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      /*
       * Never cached. These files contain a client's spend and their leads'
       * names, and a shared or proxy cache holding one is a cross-tenant leak
       * waiting for a URL collision.
       */
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
