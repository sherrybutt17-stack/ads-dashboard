import { headerSafe } from "@/lib/invite-email";

/**
 * Who an agency's email is from — the rules, with no I/O.
 *
 * Pure on purpose: the Email domain tab's client component imports it to check
 * a domain as it is typed, so nothing here may reach the database or the
 * provider. The sending lives in `deliver.ts`, the provider calls in
 * `resend-domains.ts`.
 *
 * ── 🔴 Every string that lands in a header is treated as input ──────────
 *
 * The from name is typed by an agency, and the agency name it defaults to was
 * typed at sign-up. A From header is a header at the provider: a newline in it
 * is header injection, and a stray `"` or `<` changes which address the
 * recipient's client thinks the mail came from. `formatFrom` is the one place a
 * From is assembled, so it is the one place that has to get this right.
 */

/** Never-verified domains are released after this long. See `refresh.ts`. */
export const DOMAIN_EXPIRY_DAYS = 14;

/** The part before the @ that an agency gets unless it picks another. */
export const DEFAULT_FROM_LOCAL = "reports";

/**
 * Consumer mail services, which publish DMARC p=reject.
 *
 * Lives here rather than in `reports/email.ts` because both the platform
 * sender check and the agency domain check need it, and this module is the one
 * a client component can import.
 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "aol.com",
];

export type Checked<K extends string> =
  | ({ ok: true } & Record<K, string>)
  | { ok: false; error: string };

/** The address out of `Name <addr>`, or the whole string when it is bare. */
export function addressOf(from: string): string {
  const match = from.match(/<([^>]+)>\s*$/);
  return (match ? match[1] : from).trim();
}

/** The display name out of `Name <addr>`, or null for a bare address. */
export function displayNameOf(from: string): string | null {
  const at = from.lastIndexOf("<");
  if (at <= 0) return null;
  const name = from
    .slice(0, at)
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  return name || null;
}

/**
 * A From the way an inbox shows it — `Name <address>`, without the quote marks
 * a header may need. For screens only; never for a header.
 */
export function readableFrom(from: string): string {
  const name = displayNameOf(from);
  const address = addressOf(from);
  return name ? `${name} <${address}>` : address;
}

/**
 * The domain an agency typed, in the form we store and register.
 *
 * Forgiving about what people paste — a URL, an email address, capitals, a
 * trailing dot — and strict about what comes out, because the result becomes a
 * Resend domain and a DNS name the agency is told to edit.
 *
 * `platformFrom` is our own sender (`REPORT_FROM`). An agency must not be able
 * to register that domain, or anything under it: it would be asking to send as
 * us, and a pending claim on it would sit in the same Resend team as theirs.
 */
export function normalizeDomain(
  input: string,
  opts: { platformFrom?: string | null } = {},
): Checked<"domain"> {
  let s = input.trim().toLowerCase();
  if (!s) return { ok: false, error: "Enter your domain, like youragency.com." };

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Someone will paste their own address. The domain is the part after the @.
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, "").replace(/\.+$/, "");
  if (s.startsWith("www.")) s = s.slice(4);

  if (/[^\x00-\x7f]/.test(s)) {
    return {
      ok: false,
      error:
        "Use the plain form of your domain — the one starting xn-- that your DNS provider shows.",
    };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":")) {
    return { ok: false, error: "Enter a domain name, not an IP address." };
  }
  if (s.length > 253) return { ok: false, error: "That domain is too long." };

  const labels = s.split(".");
  if (labels.length < 2) {
    return { ok: false, error: "Enter the whole domain, like youragency.com." };
  }
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const tld = labels[labels.length - 1];
  if (!labels.every((l) => label.test(l)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) {
    return {
      ok: false,
      error: "That doesn't look like a domain. Use letters, numbers, dots and hyphens, like youragency.com.",
    };
  }

  if (FREE_MAIL_DOMAINS.some((d) => s === d || s.endsWith(`.${d}`))) {
    return {
      ok: false,
      error: `${s} is a public email service, not your own domain. Use a domain your agency owns.`,
    };
  }

  const ours = opts.platformFrom ? addressOf(opts.platformFrom).split("@")[1]?.toLowerCase() : null;
  if (ours && (s === ours || s.endsWith(`.${ours}`))) {
    return { ok: false, error: "That domain belongs to this dashboard. Use a domain your agency owns." };
  }

  return { ok: true, domain: s };
}

/**
 * The part before the @. Lower-case letters, digits and `._+-`, not starting or
 * ending with punctuation and without `..` — the subset every provider accepts,
 * which is all a "reports@" ever needs.
 */
export function normalizeLocalPart(input: string): Checked<"local"> {
  const s = input.trim().toLowerCase();
  if (!s) return { ok: false, error: "Enter the part before the @, like reports." };
  if (s.length > 64) return { ok: false, error: "That's too long for the part before the @." };
  if (!/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/.test(s) || s.includes("..")) {
    return {
      ok: false,
      error: "Use letters, numbers, dots or hyphens before the @, like reports or hello.",
    };
  }
  return { ok: true, local: s };
}

/** A display name fit for a header: one line, no quoting characters, bounded. */
export function cleanDisplayName(name: string | null | undefined): string {
  return headerSafe(name ?? "")
    .replace(/["\\<>]/g, "")
    .trim()
    .slice(0, 100)
    .trim();
}

/**
 * `Name <address>`, the way our sender has always been written.
 *
 * A name made only of word characters, spaces, `&`, `'` and `-` goes out
 * unquoted — byte-for-byte the shape production already sends. Anything else
 * (a comma, a full stop, brackets) is quoted, because in a header those are
 * structure: an unquoted "Smith, Jones" reads as two addresses.
 */
export function formatFrom(name: string | null | undefined, address: string): string {
  const clean = cleanDisplayName(name);
  if (!clean) return address;
  return /^[\p{L}\p{N} &'-]+$/u.test(clean) ? `${clean} <${address}>` : `"${clean}" <${address}>`;
}

/**
 * The name on OUR address when an agency has no verified domain.
 *
 * "Salman Marketing via Growth Guild", not "Salman Marketing". Anyone can sign
 * up as an agency and type any name, and the invite email goes to any address
 * they choose — a bare "PayPal Security" on our domain would borrow our
 * reputation for theirs. "via" is the convention people already read (Google
 * Calendar, Docusign) for exactly this: who it is for, and who carried it.
 *
 * Our own agency, or an agency whose name is unknown, keeps the plain platform
 * name. A platform sender configured as a bare address has no name to put after
 * "via", so the address is left bare, as it always was.
 */
export function platformSenderName(
  agencyName: string | null | undefined,
  platformFrom: string,
): string | null {
  const platform = displayNameOf(platformFrom);
  const agency = cleanDisplayName(agencyName);
  if (!platform) return null;
  if (!agency || agency.toLowerCase() === platform.toLowerCase()) return platform;
  return `${agency} via ${platform}`;
}

export type StatusTone = "good" | "warn" | "bad" | "neutral";

/**
 * A Resend domain or record status, in words an agency can act on.
 *
 * Resend's own strings are stored as they come, so a status this list does not
 * know yet still reads sensibly ("Not verified yet") rather than as a raw token.
 * `recheck` is ours: a send from the domain was refused, so mail is going from
 * our address until the next check says it is fine.
 */
export function statusLabel(status: string | null | undefined): {
  label: string;
  tone: StatusTone;
  hint: string;
} {
  switch (status) {
    case "verified":
      return { label: "Verified", tone: "good", hint: "" };
    case "not_started":
      return {
        label: "Waiting for records",
        tone: "neutral",
        hint: "Add the records below at your DNS provider, then press Check now.",
      };
    case "pending":
      return {
        label: "Checking",
        tone: "warn",
        hint: "Your DNS is being checked. This usually takes a few minutes, and can take a few hours.",
      };
    case "failed":
      return {
        label: "Not found",
        tone: "bad",
        hint: "The records weren't found. Check each one matches exactly, then press Check now.",
      };
    case "temporary_failure":
      return {
        label: "Temporary problem",
        tone: "warn",
        hint: "Your DNS couldn't be reached just now. It will be checked again automatically.",
      };
    case "recheck":
      return {
        label: "Needs a re-check",
        tone: "warn",
        hint: "An email from this domain was refused, so emails are going from our address until it checks out again.",
      };
    default:
      return {
        label: "Not verified yet",
        tone: "neutral",
        hint: "Add the records below at your DNS provider, then press Check now.",
      };
  }
}

/** One DNS record an agency has to add, as Resend describes it. */
export interface DnsRecord {
  /** What it is for: "DKIM", "SPF", "DMARC". */
  record: string;
  /** The host, exactly as Resend gives it. */
  name: string;
  type: string;
  value: string;
  priority: number | null;
  ttl: string | null;
  status: string | null;
}

/**
 * The DNS zone Resend writes its host names relative to — what an agency's DNS
 * provider appends to every host it is given.
 *
 * Resend names hosts relative to the main (registrable) domain, not to the
 * domain being verified: for `test.growthguild.agency` the DKIM host is
 * `resend._domainkey.test`, to be added in the growthguild.agency zone — seen
 * against the live API. So the zone is read off Resend's own DKIM record:
 * whatever follows `resend._domainkey.` is the part of the domain in front of
 * the zone. No public-suffix list needed, and it follows Resend if it changes.
 */
export function dnsZoneOf(domain: string, records: readonly DnsRecord[]): string {
  const dkim = records.find((r) => r.name === "resend._domainkey" || r.name.startsWith("resend._domainkey."));
  const prefix = dkim ? dkim.name.slice("resend._domainkey".length).replace(/^\./, "") : "";
  return prefix && domain.startsWith(`${prefix}.`) ? domain.slice(prefix.length + 1) : domain;
}

/** A host's full DNS name, for providers that ask for it whole. */
export function fullHostName(host: string, zone: string): string {
  return !host || host === "@" ? zone : `${host}.${zone}`;
}

/** What the Email domain tab is given about an agency's domain. */
export interface DomainView {
  domain: string;
  status: string;
  records: DnsRecord[];
  fromLocal: string;
  fromName: string | null;
  replyTo: string | null;
  lastError: string | null;
  verifiedAt: string | null;
  checkedAt: string | null;
  /** When a never-verified domain will be released. Null once it has worked. */
  expiresAt: string | null;
}

/** What an agency's emails would be sent from right now. See `senderFor`. */
export interface SenderSummary {
  /** The From an email for this agency would carry, if known. */
  from: string | null;
  /** True when that is the agency's own verified domain. */
  viaDomain: boolean;
  /** The agency's domain, verified or not, when it has one. */
  domain: string | null;
  domainStatus: string | null;
  /** Whether custom domains are available on this deployment at all. */
  available: boolean;
}
