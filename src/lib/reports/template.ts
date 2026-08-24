import type { Period } from "./schedule";

/**
 * The email body.
 *
 * ── 🔴 No numbers in the email ────────────────────────────────────────
 *
 * The tempting version puts the headline figures in the message — spend, leads,
 * cost per lead — so the client sees them without clicking. It is wrong here for
 * a specific reason rather than a stylistic one: **Meta restates for up to 28
 * days**, so a monthly report emailed on the 1st is provisional for most of its
 * life. A figure in an email is frozen forever and cannot be corrected; the same
 * figure behind the link is resolved when the link is opened, so a restatement
 * reaches everyone who has not read it yet.
 *
 * An email that says "$5.61 cost per lead" and a dashboard that later says
 * $6.10 is the exact class of quiet disagreement this product exists to remove.
 * So the email carries the period, the link and nothing quantitative.
 *
 * ── Inline CSS, tables, no external anything ──────────────────────────
 *
 * Email clients strip `<style>` blocks (Gmail keeps them, Outlook does not),
 * ignore flexbox and grid, and block remote images by default. This is written
 * the way email has to be written rather than the way the rest of the app is:
 * inline attributes, a single-column table, system fonts, and no image that
 * matters. It is deliberately plain — a plain message that renders everywhere
 * beats a designed one that renders in Gmail and collapses in Outlook.
 */

export interface ReportEmailInput {
  clientName: string;
  period: Period;
  url: string;
  expiresAt: Date;
  /** Periods that went by without a report. Named rather than hidden. */
  skipped: readonly Period[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const day = (d: Date) =>
  `${d.getUTCDate()} ${
    [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ][d.getUTCMonth()]
  } ${d.getUTCFullYear()}`;

export function renderReportEmail(input: ReportEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const { clientName, period, url, expiresAt, skipped } = input;

  const subject = `${clientName} — ${period.label}`;

  const gap =
    skipped.length > 0
      ? `This report covers ${period.label}. No report went out for ${
          skipped.length === 1
            ? skipped[0].label
            : `${skipped.length} earlier periods (${skipped.map((p) => p.label).join(", ")})`
        } — those figures are still available in the dashboard.`
      : null;

  const text = [
    `${clientName} — ${period.label}`,
    "",
    `Your report for ${period.label} is ready.`,
    "",
    url,
    "",
    `This link works until ${day(expiresAt)}.`,
    ...(gap ? ["", gap] : []),
  ].join("\n");

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f6f4;padding:32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e5e4df;border-radius:12px;">
      <tr><td style="padding:28px 28px 8px 28px;">
        <p style="margin:0;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#6b6a65;">${escapeHtml(period.label)}</p>
        <h1 style="margin:6px 0 0 0;font-size:20px;line-height:1.3;font-weight:600;color:#1a1a18;">${escapeHtml(clientName)}</h1>
      </td></tr>
      <tr><td style="padding:12px 28px 0 28px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:#44443f;">Your report for ${escapeHtml(period.label)} is ready.</p>
      </td></tr>
      <tr><td style="padding:20px 28px 4px 28px;">
        <a href="${escapeHtml(url)}" style="display:inline-block;background:#1a1a18;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:8px;">View the report</a>
      </td></tr>
      <tr><td style="padding:16px 28px 28px 28px;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#6b6a65;">This link works until ${escapeHtml(day(expiresAt))}.</p>
        ${gap ? `<p style="margin:10px 0 0 0;font-size:12px;line-height:1.6;color:#6b6a65;">${escapeHtml(gap)}</p>` : ""}
      </td></tr>
    </table>
  </td></tr>
</table>`;

  return { subject, html, text };
}
