import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { backfillClientMetrics, importMetaAdLevelHistory, syncClientMetrics } from "@/lib/meta/sync";
import { backfillClientTiktokMetrics } from "@/lib/tiktok/sync";
import { importTiktokAdLevelHistory } from "@/lib/tiktok/adlevel";
import { backfillClientGoogleMetrics } from "@/lib/google/sync";
import { backfillClientSnapshot } from "@/lib/ghl/backfill";
import { trailingWindowInclusive } from "@/lib/dates";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { safeFailure } from "@/lib/api-failure";
import { rateLimit } from "@/lib/rate-limit";
import { record } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BodySchema = z.object({
  action: z
    .enum([
      "meta_sync",
      "meta_backfill",
      "meta_adlevel_backfill",
      "google_backfill",
      "tiktok_backfill",
      "tiktok_adlevel_backfill",
      "ghl_backfill",
    ])
    .default("meta_sync"),
  /*
   * Meta retains insights for ~37 months, so the ceiling is 36 to leave a
   * month of margin. 365 was the old cap and it silently made dormant
   * accounts look empty: an account whose spend ended 17 months ago returned
   * zero rows from a backfill that reported success.
   */
  days: z.number().int().min(1).max(1095).default(90),
  /** Ad-level import only: carry on with the months before this day (the last answer's `nextBefore`). */
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Ad-level import requests per client per hour: a year resumes in a handful; this stops a loop gone wrong. */
const ADLEVEL_IMPORTS_PER_HOUR = 40;

/** Manual sync triggers, used by the onboarding wizard and the Re-test button. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;

  const body = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  try {
    switch (parsed.data.action) {
      case "meta_sync": {
        const window = trailingWindowInclusive(7, client.timezone);
        const res = await syncClientMetrics(client, {
          since: window.startKey,
          until: window.endKey,
          includeReach: true,
          // A manual "Sync now" is the operator asking for everything.
          includeAdLevel: true,
          includeBreakdowns: true,
        });
        return NextResponse.json({ ok: true, ...res });
      }
      case "meta_backfill": {
        const rows = await backfillClientMetrics(client, parsed.data.days);
        return NextResponse.json({ ok: true, rowsWritten: rows });
      }
      case "meta_adlevel_backfill": {
        /*
         * No lock: every write is an upsert and each month checks whether it is
         * already complete, so two overlapping runs only repeat work. The rate
         * limit and the button's own busy state keep that rare.
         */
        const limited = rateLimit(`adlevel-import:${client.id}`, ADLEVEL_IMPORTS_PER_HOUR, 60 * 60 * 1000);
        if (!limited.ok) {
          return NextResponse.json(
            { ok: false, error: "Too many imports in the last hour. Try again later." },
            { status: 429, headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) } },
          );
        }
        const res = await importMetaAdLevelHistory(client, {
          days: parsed.data.days,
          before: parsed.data.before,
        });
        await record({
          action: "client.adlevel_import",
          targetType: "client",
          targetId: client.id,
          clientId: client.id,
          metadata: {
            days: parsed.data.days,
            before: parsed.data.before ?? null,
            done: res.done,
            months: res.months.length,
            rowsWritten: res.rowsWritten,
          },
        });
        return NextResponse.json({ ok: true, ...res });
      }
      case "tiktok_adlevel_backfill": {
        // Meta's import above, for TikTok: the same rate limit, resume and audit.
        const limited = rateLimit(`tiktok-adlevel-import:${client.id}`, ADLEVEL_IMPORTS_PER_HOUR, 60 * 60 * 1000);
        if (!limited.ok) {
          return NextResponse.json(
            { ok: false, error: "Too many imports in the last hour. Try again later." },
            { status: 429, headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) } },
          );
        }
        const res = await importTiktokAdLevelHistory(client, {
          days: parsed.data.days,
          before: parsed.data.before,
        });
        await record({
          action: "client.tiktok_adlevel_import",
          targetType: "client",
          targetId: client.id,
          clientId: client.id,
          metadata: {
            days: parsed.data.days,
            before: parsed.data.before ?? null,
            done: res.done,
            months: res.months.length,
            rowsWritten: res.rowsWritten,
          },
        });
        return NextResponse.json({ ok: true, ...res });
      }
      case "google_backfill": {
        const rows = await backfillClientGoogleMetrics(client, parsed.data.days);
        return NextResponse.json({ ok: true, rowsWritten: rows });
      }
      case "tiktok_backfill": {
        const rows = await backfillClientTiktokMetrics(client, parsed.data.days);
        return NextResponse.json({ ok: true, rowsWritten: rows });
      }
      case "ghl_backfill": {
        const res = await backfillClientSnapshot(client);
        return NextResponse.json({
          ok: true,
          ...res,
          note: "Snapshot only — one synthetic arrival per opportunity. GHL cannot supply the path each lead took, so true stage flow begins from when the webhook went live.",
        });
      }
    }
  } catch (err) {
    /*
     * The action decides whose error this is. A thrown timeout says nothing
     * about which platform timed out, and reporting a GHL backfill failure as
     * "Meta did not respond" would send someone to re-check a connection that
     * was never involved.
     */
    const source =
      parsed.data.action === "ghl_backfill"
        ? "ghl"
        : parsed.data.action === "tiktok_backfill" || parsed.data.action === "tiktok_adlevel_backfill"
          ? "tiktok"
          : parsed.data.action === "google_backfill"
            ? "google"
            : "meta";
    return NextResponse.json(
      {
        ok: false,
        ...safeFailure(
          err,
          source,
          { superadmin: isSuperadmin(session) },
          "Sync failed",
        ),
      },
      { status: 502 },
    );
  }
}
