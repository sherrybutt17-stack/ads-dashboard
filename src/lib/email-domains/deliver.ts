import {
  EmailError,
  agencyEmailConfigured,
  emailConfig,
  sendEmail,
  type Outgoing,
} from "@/lib/reports/email";
import { getAgencySettings } from "@/lib/branding-store";
import { addressOf, formatFrom, platformSenderName, type SenderSummary } from "./identity";
import type { AgencyEmailDomainRow } from "@/db/schema";
import { getAgencyDomain, markRecheck } from "./store";

/**
 * Sending an email on an agency's behalf — the one way every agency email
 * leaves: invites, password links and resets, scheduled and emailed reports.
 *
 * ── Which address ─────────────────────────────────────────────────────
 *
 * A verified domain: the agency's own address, through the agency-domains
 * Resend team. Anything else — no domain yet, not verified, the feature not
 * configured, the lookup failing — our own address under the agency's name
 * ("Salman Marketing via Growth Guild"). See `identity.ts` for why "via".
 *
 * ── 🔴 When the agency's domain refuses, send it from ours ─────────────
 *
 * A password reset that fails because an agency's DNS changed locks a person
 * out. So when the agency attempt is REFUSED, the same message goes from our
 * address instead. But only when it is certain nothing was sent:
 *
 *   · refused before leaving (`providerStatus` null), or Resend answered 4xx —
 *     nothing was sent; send it from ours.
 *   · Resend answered 5xx, the network failed, or the request timed out — the
 *     message may well have been delivered. A second attempt could put it in
 *     the inbox twice, so the ORIGINAL error is rethrown, untouched, exactly as
 *     a platform failure always has been. Callers depend on that object: the
 *     report job records its message and retries next hour.
 *
 * The fallback goes first and the bookkeeping after, so a slow database cannot
 * spend the caller's time budget before the email has gone.
 */

export interface Delivery {
  id: string | null;
  via: "agency_domain" | "platform";
  /** The From the message went out with, when we set one. */
  from: string | null;
  /** Why the agency's domain was passed over, when it was tried and refused. */
  fellBack: string | null;
}

interface Sender {
  agencyName: string | null;
  supportEmail: string | null;
  /** The agency's domain row, whatever its status. */
  row: AgencyEmailDomainRow | null;
  /** Present only when the agency has a verified domain AND the feature is on. */
  domain: { agencyId: string; name: string; from: string; replyTo: string | null } | null;
}

/** Never throws — `getAgencySettings` and `getAgencyDomain` both degrade to nothing. */
async function resolveSender(agencyId: string | null | undefined): Promise<Sender> {
  if (!agencyId) return { agencyName: null, supportEmail: null, row: null, domain: null };
  const [settings, row] = await Promise.all([
    getAgencySettings(agencyId),
    agencyEmailConfigured() ? getAgencyDomain(agencyId) : Promise.resolve(null),
  ]);
  const domain =
    row && row.status === "verified"
      ? {
          agencyId,
          name: row.domain,
          from: formatFrom(row.fromName || settings.agencyName, `${row.fromLocal}@${row.domain}`),
          replyTo: row.replyTo || settings.supportEmail || null,
        }
      : null;
  return { agencyName: settings.agencyName, supportEmail: settings.supportEmail, row, domain };
}

/** Certain that the provider did not accept the message. See the header. */
function nothingWasSent(err: unknown): err is EmailError {
  if (!(err instanceof EmailError)) return false;
  if (err.providerStatus === null) return true;
  return err.providerStatus >= 400 && err.providerStatus < 500;
}

/** The From our own address goes out with for this agency, or null if unchanged. */
function platformFrom(sender: Pick<Sender, "agencyName">): string | null {
  const cfg = emailConfig();
  if (!cfg) return null;
  const name = platformSenderName(sender.agencyName, cfg.from);
  return name ? formatFrom(name, addressOf(cfg.from)) : cfg.from;
}

async function sendFromPlatform(
  sender: Sender,
  msg: Outgoing,
  opts: { signal?: AbortSignal },
): Promise<Delivery> {
  const from = platformFrom(sender);
  if (!from) {
    /*
     * Nothing to dress: the platform sender is not configured. Passed through
     * as it came, so `sendEmail` raises its own "not configured" — the error
     * every caller already knows how to show.
     */
    const { id } = await sendEmail(msg, opts);
    return { id, via: "platform", from: null, fellBack: null };
  }
  const replyTo = sender.supportEmail ?? emailConfig()?.replyTo;
  const { id } = await sendEmail({ ...msg, from, ...(replyTo ? { replyTo } : {}) }, opts);
  return { id, via: "platform", from, fellBack: null };
}

/**
 * What a refusal says about the domain. A 403 that names the domain as not
 * verified means DNS changed under it: stop using it until a check passes. A
 * bad key, a rate limit or a quota is ours to fix, not the agency's — logged
 * loudly, and the domain is left as it is.
 */
async function noteRefusal(domain: NonNullable<Sender["domain"]>, err: EmailError): Promise<void> {
  if (err.providerStatus === 403 && /not verified|verify|domain/i.test(err.message)) {
    await markRecheck(domain.agencyId, err.message);
    return;
  }
  console.error(
    `[email-domains] ${domain.name} refused a send (${err.providerStatus ?? "before sending"}): ${err.message}`,
  );
}

export async function sendForAgency(
  agencyId: string | null | undefined,
  msg: Outgoing,
  opts: { signal?: AbortSignal } = {},
): Promise<Delivery> {
  const sender = await resolveSender(agencyId);

  if (sender.domain) {
    const domain = sender.domain;
    try {
      const { id } = await sendEmail(
        { ...msg, from: domain.from, ...(domain.replyTo ? { replyTo: domain.replyTo } : {}) },
        { signal: opts.signal, account: "agency" },
      );
      return { id, via: "agency_domain", from: domain.from, fellBack: null };
    } catch (err) {
      if (!nothingWasSent(err)) throw err;
      const delivered = await sendFromPlatform(sender, msg, opts);
      await noteRefusal(domain, err);
      return { ...delivered, fellBack: err.message };
    }
  }

  return sendFromPlatform(sender, msg, opts);
}

/**
 * What an agency's emails would be sent from right now — for the line under the
 * "Email this report" and schedule panels. Never throws.
 */
export async function senderFor(agencyId: string | null | undefined): Promise<SenderSummary> {
  const available = agencyEmailConfigured();
  try {
    const sender = await resolveSender(agencyId);
    return {
      from: sender.domain ? sender.domain.from : platformFrom(sender),
      viaDomain: Boolean(sender.domain),
      domain: sender.row?.domain ?? null,
      domainStatus: sender.row?.status ?? null,
      available,
    };
  } catch (err) {
    console.error("[email-domains] sender summary failed", err);
    return { from: null, viaDomain: false, domain: null, domainStatus: null, available };
  }
}
