import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { reportSchedules } from "@/db/schema";
import { getSessionUser, requireClient } from "@/lib/auth";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { emailConfigured, emailConfig, senderProblem } from "@/lib/reports/email";
import { isDue, lastCompletePeriod, type Cadence } from "@/lib/reports/schedule";
import { sendScheduledReport } from "@/lib/reports/send";
import { parseAdPlatform } from "@/lib/platforms";

/**
 * The scheduled-report configuration for one client.
 *
 * **Staff only.** Recipients are an outbound address list — a client-role user
 * able to edit it could have their own report mailed anywhere, and the report is
 * a link that opens without a login. Same reasoning as the alert destination.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CADENCES = ["weekly", "monthly"] as const;
const MAX_RECIPIENTS = 10;

const Body = z
  .object({
    platform: z.enum(["meta", "google"]).default("meta"),
    enabled: z.boolean().optional(),
    cadence: z.enum(CADENCES).optional(),
    sendHour: z.number().int().min(0).max(23).optional(),
    recipients: z
      .array(z.string().trim().email().max(320))
      .max(MAX_RECIPIENTS)
      .optional(),
    linkTtlDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
    /** Send this period's report now, without waiting for the schedule. */
    sendNow: z.boolean().optional(),
  })
  // Strict: an unknown key is a 400 rather than a silently ignored field.
  .strict();

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const platform = parseAdPlatform(req.nextUrl.searchParams.get("platform"));
  const [row] = await db
    .select()
    .from(reportSchedules)
    .where(
      and(
        eq(reportSchedules.clientId, client.id),
        eq(reportSchedules.platform, platform),
      ),
    );

  const cfg = emailConfig();
  const next = row
    ? lastCompletePeriod(row.cadence as Cadence, client.timezone, new Date())
    : null;

  return NextResponse.json({
    schedule: row ?? null,
    /*
     * The setup state travels with the config so the panel can be specific
     * rather than showing a generic "not configured". A wrong sender domain and
     * a missing API key need different actions.
     */
    configured: emailConfigured(),
    senderProblem: cfg ? senderProblem(cfg.from) : null,
    /** What the next send would cover, so the operator can sanity-check it. */
    nextPeriod: next,
    alreadySent: row?.lastSentPeriod === next?.key,
  });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }
  const { platform, sendNow, ...fields } = parsed.data;

  const gate = rateLimit(`reports:${client.id}`, 30, 10 * 60_000);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many changes. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const session = await getSessionUser();
  const actor = session?.userId ?? "unknown";

  /*
   * Recipients are deduplicated and lowercased on write. Two spellings of one
   * address would send the same person two copies, and nothing downstream is
   * going to notice that they are the same mailbox.
   */
  const recipients = fields.recipients
    ? [...new Set(fields.recipients.map((r) => r.trim().toLowerCase()))]
    : undefined;

  const [row] = await db
    .insert(reportSchedules)
    .values({
      clientId: client.id,
      platform,
      enabled: fields.enabled ?? false,
      cadence: fields.cadence ?? "monthly",
      sendHour: fields.sendHour ?? 8,
      recipients: recipients ?? [],
      linkTtlDays: fields.linkTtlDays ?? 30,
      updatedBy: actor,
    })
    .onConflictDoUpdate({
      target: [reportSchedules.clientId, reportSchedules.platform],
      /*
       * Only the keys actually supplied. A spread of the whole parsed body
       * would reset `cadence` to its default every time someone toggled
       * `enabled` — the write-path defect the layout work already learned once.
       */
      set: {
        ...(fields.enabled !== undefined ? { enabled: fields.enabled } : {}),
        ...(fields.cadence !== undefined ? { cadence: fields.cadence } : {}),
        ...(fields.sendHour !== undefined ? { sendHour: fields.sendHour } : {}),
        ...(recipients !== undefined ? { recipients } : {}),
        ...(fields.linkTtlDays !== undefined
          ? { linkTtlDays: fields.linkTtlDays }
          : {}),
        updatedAt: new Date(),
        updatedBy: actor,
      },
    })
    .returning();

  await record({
    action: "reports.schedule_saved",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: {
      platform,
      enabled: row.enabled,
      cadence: row.cadence,
      recipients: row.recipients.length,
    },
  });

  if (!sendNow) return NextResponse.json({ schedule: row });

  if (!emailConfigured()) {
    return NextResponse.json(
      { schedule: row, sent: false, error: "Email is not configured." },
      { status: 200 },
    );
  }

  /*
   * 🔴 A manual send goes through the SAME path as the cron, including the
   * claim on `report_sends`. Clicking "Send now" for a period the schedule has
   * already covered does nothing — which is the correct behaviour and the
   * reason this is not a separate, simpler code path.
   */
  const outcome = await sendScheduledReport(
    client,
    { ...row, enabled: true },
    new Date(),
  );

  await record({
    action: "reports.sent_manually",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: { platform, sent: outcome.sent, reason: outcome.sent ? null : outcome.reason },
  });

  return NextResponse.json({
    schedule: row,
    sent: outcome.sent,
    ...(outcome.sent
      ? { period: outcome.period.label, recipients: outcome.recipients }
      : { error: outcome.reason }),
  });
}

/**
 * Would a send fire right now? Used by the panel to explain itself.
 *
 * Exported for the tests rather than the route — the verdict is pure and worth
 * asserting directly.
 */
export function describeNext(
  schedule: typeof reportSchedules.$inferSelect,
  timezone: string,
  now: Date,
) {
  return isDue(
    {
      enabled: schedule.enabled,
      cadence: schedule.cadence as Cadence,
      timezone,
      sendHour: schedule.sendHour,
      lastSentKey: schedule.lastSentPeriod,
    },
    now,
  );
}
