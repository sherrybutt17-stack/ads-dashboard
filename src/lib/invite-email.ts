/**
 * The email that carries an invite, or an operator-sent password link.
 *
 * Pure: strings in, strings out. Sending lives in `access-links.ts`, so this
 * can be tested without a provider and the two rules below can be pinned.
 *
 * 🔴 No caller-typed string reaches the subject except the agency name, and
 * that one is stripped of control characters — a subject is a header at the
 * provider, and a newline inside it is header injection. The agency name is
 * editable on the settings page, so it is treated as input, not as a constant.
 *
 * 🔴 Everything interpolated into the HTML is escaped. The invitee's name and
 * the client names were typed by people, and this lands in someone else's
 * inbox.
 *
 * Plain on purpose, in the same inline-styled single-column table the report
 * email uses: it has to render in Outlook as well as Gmail, and an invite that
 * looks broken looks like phishing.
 */

export type AccessLinkKind = "invite" | "password";

export interface AccessEmailInput {
  kind: AccessLinkKind;
  /** The agency whose dashboard this is — "Growth Guild". */
  agencyName: string;
  /** The invitee's name, if the operator gave one. */
  name?: string | null;
  /** Who sent it, if known. The first-run session has no name. */
  inviterName?: string | null;
  /** For a client login: the dashboards it opens. Empty for team roles. */
  clientNames: readonly string[];
  url: string;
  /** Lifetime, for the "works for …" line. */
  ttlMs: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Control characters out, whitespace collapsed — for anything in a header. */
function headerSafe(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "7 days", "24 hours" — the lifetime as a person would say it. */
export function lifetime(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** "A", "A and B", "A, B and C". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function renderAccessEmail(input: AccessEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const agency = headerSafe(input.agencyName) || "your agency";
  const name = input.name?.trim() || null;
  const inviter = input.inviterName?.trim() || null;
  const clients = input.clientNames.map((c) => c.trim()).filter(Boolean);
  const life = lifetime(input.ttlMs);

  const subject =
    input.kind === "invite"
      ? `You're invited to ${agency}'s reporting dashboard`
      : `Set a new password for ${agency}'s reporting dashboard`;

  const greeting = name ? `Hi ${name},` : "Hi,";

  const lead =
    input.kind === "invite"
      ? `${inviter ?? agency} set up a login for you on ${agency}'s reporting dashboard` +
        (clients.length ? `, where you can follow ${list(clients)}.` : ".")
      : `${inviter ?? agency} sent you a link to choose a new password for ${agency}'s reporting dashboard.`;

  const action =
    input.kind === "invite"
      ? "Choose your password to finish setting it up:"
      : "Choose your new password here:";

  const button = input.kind === "invite" ? "Set up my login" : "Choose a new password";

  const fine =
    input.kind === "invite"
      ? `The link works once, for ${life}. Nobody else knows the password you choose, including whoever invited you. If you weren't expecting this, you can ignore it.`
      : `The link works once, for ${life}. Your current password keeps working until you use it. If you didn't ask for this, you can ignore it.`;

  const text = [greeting, "", lead, "", action, input.url, "", fine].join("\n");

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f6f4;padding:32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e5e4df;border-radius:12px;">
      <tr><td style="padding:28px 28px 8px 28px;">
        <p style="margin:0;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#6b6a65;">${escapeHtml(agency)}</p>
        <h1 style="margin:6px 0 0 0;font-size:20px;line-height:1.3;font-weight:600;color:#1a1a18;">${input.kind === "invite" ? "You're invited" : "Set a new password"}</h1>
      </td></tr>
      <tr><td style="padding:12px 28px 0 28px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:#44443f;">${escapeHtml(greeting)}</p>
        <p style="margin:10px 0 0 0;font-size:14px;line-height:1.6;color:#44443f;">${escapeHtml(lead)}</p>
      </td></tr>
      <tr><td style="padding:20px 28px 4px 28px;">
        <a href="${escapeHtml(input.url)}" style="display:inline-block;background:#1a1a18;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:8px;">${button}</a>
      </td></tr>
      <tr><td style="padding:16px 28px 28px 28px;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#6b6a65;">${escapeHtml(fine)}</p>
        <p style="margin:10px 0 0 0;font-size:12px;line-height:1.6;color:#6b6a65;word-break:break-all;">Or paste this into your browser: ${escapeHtml(input.url)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>`;

  return { subject, html, text };
}
