import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { reportSchedules, reportSends, type Client } from "@/db/schema";
import { mintShareLink } from "@/lib/share";
import { getClientBranding } from "@/lib/branding-store";
import { sendEmail, emailConfigured, EmailError } from "./email";
import { isDue, type Cadence, type Period } from "./schedule";
import { renderReportEmail } from "./template";
import { appBaseUrlOr } from "@/lib/app-url";

/**
 * Sending one client their report.
 *
 * ── 🔴 A LINK, never an attachment ────────────────────────────────────
 *
 * The obvious design is to attach the PDF. It is also the one that cannot be
 * undone: a PDF in an inbox has no expiry, no revocation, and no way to correct
 * a figure that Meta later restates — and Meta restates for up to 28 days, so a
 * monthly report sent on the 1st is provisional for most of its life.
 *
 * A share link keeps every one of those properties. It expires, it can be
 * revoked the moment a number turns out to be wrong, it can carry a password,
 * and what it opens is resolved at view time — so a branding change or a
 * corrected figure reaches every link already sent. It also carries no
 * lead-level data, which an emailed file would need separate thought about.
 *
 * ── 🔴 The row is inserted BEFORE the email is sent ───────────────────
 *
 * `report_sends` has a unique constraint on (client, platform, period). The
 * insert is attempted first and a conflict aborts the send. That ordering is
 * the entire idempotency story: two cron invocations racing — which happens
 * whenever a run is retried — both compute the same period, and exactly one
 * wins the insert. Sending first and recording afterwards would send twice and
 * record once.
 *
 * The cost is that a crash between insert and send leaves a row marked
 * `sending` and no email. That is the right way round: a missing report is
 * visible on the schedule and fixable by hand, whereas a client receiving the
 * same report three times is not recoverable at all.
 */

export type SendOutcome =
  | { sent: false; reason: string }
  | { sent: true; period: Period; recipients: number; shareLinkId: string };

export async function sendScheduledReport(
  client: Client,
  schedule: typeof reportSchedules.$inferSelect,
  now: Date = new Date(),
): Promise<SendOutcome> {
  if (!emailConfigured()) return { sent: false, reason: "email not configured" };

  const recipients = (schedule.recipients ?? []).filter(Boolean);
  if (recipients.length === 0) {
    return { sent: false, reason: "no recipients" };
  }

  const verdict = isDue(
    {
      enabled: schedule.enabled,
      cadence: schedule.cadence as Cadence,
      timezone: client.timezone,
      sendHour: schedule.sendHour,
      lastSentKey: schedule.lastSentPeriod,
    },
    now,
  );
  if (!verdict.due) return { sent: false, reason: verdict.reason };

  const { period, skipped } = verdict;
  const platform = schedule.platform;

  /*
   * Claim the period. A conflict means another invocation already has it —
   * not an error, and not something to report as a failure.
   */
  const claimed = await db
    .insert(reportSends)
    .values({
      clientId: client.id,
      platform,
      periodKey: period.key,
      periodStart: period.startKey,
      periodEnd: period.endKey,
      recipients,
      status: "sending",
      skippedPeriods: skipped.map((p) => p.key),
    })
    .onConflictDoNothing({
      target: [reportSends.clientId, reportSends.platform, reportSends.periodKey],
      /*
       * 🔴 This `where` is NOT optional, and omitting it broke every send.
       *
       * `report_sends_period_key` is a PARTIAL unique index
       * (`WHERE status <> 'failed'`). Postgres will not infer a partial index as
       * an ON CONFLICT arbiter unless the statement repeats its predicate — it
       * raises `there is no unique or exclusion constraint matching the ON
       * CONFLICT specification` (42P10) instead. Since this insert sits OUTSIDE
       * the try/catch below, that threw straight out of the function on every
       * invocation, so no scheduled report was ever sent.
       *
       * It typechecks either way, and the index is genuinely there — which is
       * why nothing caught it until a test actually ran the insert. Drizzle
       * renders this as `ON CONFLICT (...) WHERE ... DO NOTHING`, which is the
       * form Postgres can match against the partial index.
       */
      where: sql`${reportSends.status} <> 'failed'`,
    })
    .returning({ id: reportSends.id });

  const sendRow = claimed[0];
  if (!sendRow) return { sent: false, reason: "already claimed by another run" };

  try {
    const { token, row: link } = await mintShareLink({
      clientId: client.id,
      rangeStart: period.startKey,
      rangeEnd: period.endKey,
      platform,
      label: `${period.label} — emailed`,
      ttlDays: schedule.linkTtlDays,
      createdBy: "schedule",
    });

    const branding = await getClientBranding(client.id);
    const base = appBaseUrlOr("");
    const url = `${base}/r/${token}`;

    const mail = renderReportEmail({
      clientName: branding.displayName || client.name,
      period,
      url,
      expiresAt: link.expiresAt,
      skipped,
    });

    const { id } = await sendEmail({ to: recipients, ...mail });

    await db
      .update(reportSends)
      .set({ status: "sent", providerId: id, shareLinkId: link.id, sentAt: new Date() })
      .where(eq(reportSends.id, sendRow.id));

    await db
      .update(reportSchedules)
      .set({
        lastSentPeriod: period.key,
        lastSentAt: new Date(),
        // Cleared on success, so a stale failure cannot sit on the UI forever.
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(reportSchedules.id, schedule.id));

    return {
      sent: true,
      period,
      recipients: recipients.length,
      shareLinkId: link.id,
    };
  } catch (err) {
    const message =
      err instanceof EmailError ? err.message : "Could not send the report.";
    console.error("[reports] send failed:", err);

    await db
      .update(reportSends)
      .set({ status: "failed", error: message })
      .where(eq(reportSends.id, sendRow.id));

    /*
     * 🔴 `lastSentPeriod` is NOT advanced, so the next run retries this same
     * period — and the row just marked `failed` no longer blocks it, because
     * the unique index excludes failures. The failed row stays as history.
     *
     * Getting this wrong in either direction is bad: advance the pointer and
     * the report is never sent, keep a blocking claim and one provider blip
     * loses that period permanently.
     */
    await db
      .update(reportSchedules)
      .set({ lastError: message, updatedAt: new Date() })
      .where(eq(reportSchedules.id, schedule.id));

    return { sent: false, reason: message };
  }
}

/** Every enabled schedule, with its client. */
export async function dueSchedules() {
  return db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.enabled, true)));
}
