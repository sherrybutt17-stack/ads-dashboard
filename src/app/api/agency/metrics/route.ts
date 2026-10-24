import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";
import { CustomMetricDraftSchema } from "@/lib/board/custom-metric-schema";
import { createCustomMetric, customMetricUsage, listCustomMetrics } from "@/lib/board/custom-metrics";
import { CUSTOM_LIMITS, validateCustomMetric } from "@/lib/board/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Settings → Metrics: the agency's own metrics, listed and created.
 *
 * ── 🔴 The tenant is the session's, never the request's ──────────────────
 *
 * The same rule as the agency settings route: no agency id in the path or the
 * body, so no ownership check to forget. A client login never reaches this —
 * the proxy refuses `/api/agency/*` to clients — and client boards receive the
 * definitions as props, from the server, instead.
 */

const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 10 * 60_000;

export async function GET() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agencyId = session!.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "No agency on this session" }, { status: 409 });
  }
  const [metrics, usage] = await Promise.all([
    listCustomMetrics(agencyId),
    customMetricUsage(agencyId).catch(() => new Map<string, number>()),
  ]);
  return NextResponse.json({ metrics: metrics.map((m) => ({ ...m, boards: usage.get(m.id) ?? 0 })) });
}

export async function POST(req: NextRequest) {
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

  const parsed = CustomMetricDraftSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const existing = await listCustomMetrics(agencyId);
  if (existing.length >= CUSTOM_LIMITS.perAgency) {
    return NextResponse.json(
      { error: `An agency can have up to ${CUSTOM_LIMITS.perAgency} metrics. Delete one you no longer use first.` },
      { status: 400 },
    );
  }
  const verdict = validateCustomMetric(parsed.data, existing);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error, field: verdict.field }, { status: 400 });
  }

  let metric;
  try {
    metric = await createCustomMetric(agencyId, parsed.data, session!.userId ?? null);
  } catch (err) {
    console.error("[metrics] create failed:", err);
    return NextResponse.json(
      {
        error:
          "Could not save. If custom metrics have never saved on this deployment, the database migration for them (0032) has not been applied yet.",
      },
      { status: 500 },
    );
  }

  void audit.record({
    action: "agency.metric_create",
    targetType: "custom_metric",
    targetId: metric.id,
    agencyId,
    metadata: { kind: metric.kind, platform: metric.platform },
    ...audit.requestContext(req),
  });
  return NextResponse.json({ metric: { ...metric, boards: 0 } }, { status: 201 });
}
