import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";
import { checkWidget } from "@/lib/board/catalog";
import { CustomMetricArchiveSchema, CustomMetricDraftSchema } from "@/lib/board/custom-metric-schema";
import {
  customMetricUsage,
  deleteCustomMetric,
  getCustomMetric,
  listCustomMetrics,
  setCustomMetricArchived,
  updateCustomMetric,
  widgetsUsingMetric,
} from "@/lib/board/custom-metrics";
import { widgetQueryOf } from "@/lib/board/query";
import { buildRegistry, validateCustomMetric } from "@/lib/board/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One of the agency's metrics: changed, archived or restored (PUT), deleted
 * (DELETE).
 *
 * The id in the path names a metric, never an agency: every lookup is scoped
 * by the session's agency, so another agency's metric id is simply not found.
 *
 * An edit applies at once to every board that shows the metric — that is what
 * an agency-wide definition means — and the answer says how many widgets it
 * leaves unable to draw as set up, so the form can say so. Share links are
 * untouched: each froze the definitions it was sent with.
 */

const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agencyId = session!.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }

  const gate = rateLimit(`agency-metrics:${agencyId}`, WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes just now. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const { id } = await ctx.params;
  const current = UUID.test(id) ? await getCustomMetric(agencyId, id) : null;
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const by = session!.userId ?? null;
  const body: unknown = await req.json().catch(() => null);

  const archive = CustomMetricArchiveSchema.safeParse(body);
  if (archive.success) {
    const metric = await setCustomMetricArchived(agencyId, id, archive.data.archived, by);
    void audit.record({
      action: archive.data.archived ? "agency.metric_archive" : "agency.metric_restore",
      targetType: "custom_metric",
      targetId: id,
      agencyId,
      ...audit.requestContext(req),
    });
    return NextResponse.json({ metric });
  }

  const parsed = CustomMetricDraftSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.kind !== current.kind || parsed.data.platform !== current.platform) {
    return NextResponse.json(
      { error: "A metric's kind and platform can't change. Duplicate it to make a new one instead." },
      { status: 400 },
    );
  }
  const others = (await listCustomMetrics(agencyId)).filter((m) => m.id !== id);
  const verdict = validateCustomMetric(parsed.data, others);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error, field: verdict.field }, { status: 400 });
  }

  const metric = await updateCustomMetric(agencyId, id, parsed.data, by);
  if (!metric) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Widgets the new definition no longer fits explain themselves until edited; count them.
  const reg = buildRegistry([...others, metric]);
  const broken = (await widgetsUsingMetric(agencyId, id).catch(() => [])).filter(
    (w) => !checkWidget(widgetQueryOf(w), reg).ok,
  ).length;

  void audit.record({
    action: "agency.metric_update",
    targetType: "custom_metric",
    targetId: id,
    agencyId,
    metadata: { broken },
    ...audit.requestContext(req),
  });
  return NextResponse.json({ metric, broken });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agencyId = session!.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }

  const gate = rateLimit(`agency-metrics:${agencyId}`, WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes just now. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const { id } = await ctx.params;
  const current = UUID.test(id) ? await getCustomMetric(agencyId, id) : null;
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });

  /*
   * A metric a board still shows is archived, not deleted: deleting it would
   * leave those widgets unable to say what they were. Archived, it leaves the
   * picker and keeps working where it is used.
   */
  const boards = (await customMetricUsage(agencyId)).get(id) ?? 0;
  if (boards > 0) {
    return NextResponse.json(
      {
        error: `“${current.label}” is on ${boards} ${boards === 1 ? "board" : "boards"}. Archive it instead: it leaves the picker and keeps working where it is used.`,
        boards,
      },
      { status: 409 },
    );
  }

  await deleteCustomMetric(agencyId, id);
  void audit.record({
    action: "agency.metric_delete",
    targetType: "custom_metric",
    targetId: id,
    agencyId,
    metadata: { label: current.label },
    ...audit.requestContext(req),
  });
  return NextResponse.json({ ok: true });
}
