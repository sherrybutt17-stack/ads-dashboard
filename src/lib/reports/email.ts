/**
 * Sending an email.
 *
 * One provider, one `fetch`, two environment variables. Resend by default
 * because its REST surface is a single POST and its free tier covers a book
 * this size; the API base is overridable for anything that speaks the same
 * shape.
 *
 * ── 🔴 Unconfigured is a supported state, and it is the DEFAULT ────────
 *
 * Same rule as the written summaries and the PDF renderer: with no key set,
 * `emailConfigured()` is false, the schedule UI says so, and the cron reports
 * "not configured" rather than failing. Nothing in this product should degrade
 * into a button that does nothing.
 *
 * ── 🔴 The sender domain is the part that cannot be skipped ────────────
 *
 * `REPORT_FROM` must be an address on a domain with SPF, DKIM and DMARC
 * published, verified with the provider. This is not optional polish: mail from
 * an unauthenticated domain is filed as spam by Gmail and Outlook, and a client
 * report that silently lands in a junk folder is worse than one that was never
 * sent — the agency believes it arrived and the client believes it never did.
 * `senderProblem()` exists so that failure is stated up front rather than
 * discovered in a meeting.
 */

export interface EmailConfig {
  key: string;
  from: string;
  /** Override for a compatible API or a self-hosted relay. */
  url: string;
  /** Where replies go, if not the sender. */
  replyTo?: string;
}

const DEFAULT_URL = "https://api.resend.com/emails";

export function emailConfig(): EmailConfig | null {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.REPORT_FROM;
  if (!key || !from) return null;
  return {
    key,
    from,
    url: process.env.RESEND_API_URL || DEFAULT_URL,
    replyTo: process.env.REPORT_REPLY_TO || undefined,
  };
}

export function emailConfigured(): boolean {
  return emailConfig() !== null;
}

/**
 * Why this sender will not work, if it will not.
 *
 * Deliberately narrow — it catches the shapes that are certainly wrong rather
 * than trying to validate deliverability, which cannot be known from a string.
 * A free-mail sender is the one that matters: DMARC on `gmail.com` is `p=reject`
 * and mail claiming to be from it will be rejected outright, not merely
 * filtered.
 */
export function senderProblem(from: string): string | null {
  const match = from.match(/<([^>]+)>\s*$/);
  const address = (match ? match[1] : from).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return "REPORT_FROM is not a valid email address.";
  }
  const domain = address.split("@")[1].toLowerCase();
  const free = [
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "icloud.com",
    "aol.com",
  ];
  if (free.includes(domain)) {
    return `${domain} publishes DMARC p=reject, so mail claiming to be from it will be rejected rather than delivered. Use an address on your own domain.`;
  }
  return null;
}

export class EmailError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when the operator can fix this by changing configuration. */
    readonly configurable: boolean,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

export interface Outgoing {
  to: readonly string[];
  subject: string;
  html: string;
  /** Plain-text alternative. Never optional — see below. */
  text: string;
}

export async function sendEmail(
  msg: Outgoing,
  opts: { signal?: AbortSignal } = {},
): Promise<{ id: string | null }> {
  const cfg = emailConfig();
  if (!cfg) {
    throw new EmailError("Email is not configured.", 503, true);
  }
  const problem = senderProblem(cfg.from);
  if (problem) throw new EmailError(problem, 503, true);

  if (msg.to.length === 0) {
    throw new EmailError("No recipients.", 400, true);
  }

  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key}`,
    },
    signal: opts.signal,
    body: JSON.stringify({
      from: cfg.from,
      to: [...msg.to],
      subject: msg.subject,
      html: msg.html,
      /*
       * 🔴 A plain-text part on every message, always.
       *
       * HTML-only mail scores badly with every spam filter, and a report that
       * lands in junk is the failure mode this whole feature has to avoid. It
       * also covers the readers — watches, screen readers, text-mode clients —
       * for whom the HTML is nothing at all.
       */
      text: msg.text,
      ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
    }),
  });

  const body = (await res.json().catch(() => null)) as
    | { id?: string; message?: string; name?: string }
    | null;

  if (!res.ok) {
    throw new EmailError(
      body?.message ?? `Email provider returned ${res.status}`,
      res.status,
      // 401/403 is a bad key; 422 is usually an unverified sending domain.
      res.status === 401 || res.status === 403 || res.status === 422,
    );
  }

  return { id: body?.id ?? null };
}
