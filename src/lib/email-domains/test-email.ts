/**
 * The email the Email domain tab's "Send a test email" sends to the operator.
 *
 * Pure, and deliberately plain — the same inline-styled single column as the
 * report and invite emails, because its whole job is to look like what clients
 * will receive. The agency name is the only interpolated string, and it is
 * escaped: it was typed by someone.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderTestEmail(agencyName: string): {
  subject: string;
  html: string;
  text: string;
} {
  const name = agencyName.trim() || "your agency";
  const lines = [
    `This is a test email from ${name}'s reporting dashboard.`,
    "Look at who it's from. Once your domain is verified, invites, password resets and reports to your clients come from that same address.",
    "Nothing else happens — you can delete this email.",
  ];
  return {
    subject: "Test email from your reporting dashboard",
    text: lines.join("\n\n"),
    html:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2430">` +
      `<tr><td style="padding:24px 8px;max-width:560px">` +
      lines.map((l) => `<p style="margin:0 0 14px">${escapeHtml(l)}</p>`).join("") +
      `</td></tr></table>`,
  };
}
