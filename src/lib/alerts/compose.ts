/**
 * Real-time new-lead alerts.
 *
 * A lead lands in this database roughly a second after somebody fills the form,
 * and until now nothing did anything with that second. The product reads as a
 * monthly report because that is when anyone opens it.
 *
 * ---
 *
 * **🔴 SMS is deliberately not built, and this is not a shortcut.**
 *
 * GoHighLevel is a CRM with a messaging engine and a workflow builder: "on
 * contact created → send SMS" is three clicks inside the product the client
 * already pays for, from a number their leads already recognise. Building a
 * second path would mean a Twilio account, A2P 10DLC registration that takes
 * weeks and blocks unregistered traffic, per-message billing, and carrier
 * compliance — for a strictly worse version of something already available.
 * The same reasoning the plan applies to call tracking applies here.
 *
 * Slack and Discord are different: GHL cannot reach either, and it is where the
 * agency actually is.
 *
 * ---
 *
 * **🔴 What makes the message worth the interruption is NOT that a lead
 * arrived.** GHL can already say that. What only this system can add is the
 * campaign the lead came from, how many have arrived today, and whether the
 * pipeline has been silent for days — and the phone number, because the entire
 * point of interrupting somebody is that they pick up a phone.
 *
 * **What is deliberately kept out: any cost figure.** At the instant a lead
 * arrives, today's spend is a partial day and the campaign's lead count is one.
 * "$412 per lead" computed from that is noise wearing a decimal point, and an
 * alert is the worst possible place to put an unstable number — it is read
 * once, out of context, and never revisited.
 */

/* ------------------------------------------------------------------ *
 * Destination
 * ------------------------------------------------------------------ */

export type AlertTarget = "slack" | "discord";

/**
 * Hosts a webhook URL may point at.
 *
 * 🔴 An allowlist, not a private-IP filter. A URL the server is made to fetch
 * is an SSRF primitive: point it at a cloud metadata endpoint and the response
 * — or merely the timing — leaks. Filtering by resolved IP is the general
 * solution and is notoriously hard to get right, because DNS can answer
 * differently on the second lookup than it did on the check. Two known hosts
 * are a rule that fits in a sentence and cannot be walked around.
 *
 * The cost is real and worth stating: Zapier, Make, n8n and custom endpoints
 * are not supported. That is a deliberate trade, not an oversight.
 */
const ALLOWED_HOSTS: Record<string, AlertTarget> = {
  "hooks.slack.com": "slack",
  "discord.com": "discord",
  "discordapp.com": "discord",
  "canary.discord.com": "discord",
  "ptb.discord.com": "discord",
};

export interface TargetCheck {
  ok: boolean;
  target: AlertTarget | null;
  /** Why it was rejected, phrased for the person pasting the URL. */
  error: string | null;
}

export function classifyWebhookUrl(raw: string): TargetCheck {
  const value = raw.trim();
  if (value === "") {
    return { ok: false, target: null, error: "Paste a webhook URL." };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, target: null, error: "That is not a valid URL." };
  }

  // Plain http would send lead names and phone numbers in the clear, and would
  // also open the door to plain-http internal addresses.
  if (url.protocol !== "https:") {
    return { ok: false, target: null, error: "The URL must start with https://." };
  }

  const target = ALLOWED_HOSTS[url.hostname.toLowerCase()];
  if (!target) {
    return {
      ok: false,
      target: null,
      error:
        "Only Slack and Discord webhook URLs are accepted. Other destinations are not supported for security reasons.",
    };
  }

  return { ok: true, target, error: null };
}

/* ------------------------------------------------------------------ *
 * Whether to send at all
 * ------------------------------------------------------------------ */

/**
 * How old a lead may be and still count as news.
 *
 * 🔴 This is the guard against the worst failure this feature can have. A
 * backfill, a reconnection, or a burst of catch-up webhooks re-upserts every
 * contact the client has — on this deployment, sixteen hundred of them. Without
 * an age bound that is sixteen hundred Slack messages, and the channel is
 * abandoned the same afternoon.
 */
export const FRESH_HOURS = 6;

/**
 * Most alerts an hour, per client.
 *
 * Not a batching scheme, on purpose. Every message carries "Nth today", so a
 * suppressed run shows up as a jump in that number on the next one that gets
 * through — self-evident, and needing no state to track what was muted.
 */
export const MAX_PER_HOUR = 10;

/** A gap at least this long makes "first lead in N days" worth saying. */
const QUIET_DAYS = 3;

export interface AlertLead {
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  /** Lead-in time, ISO. */
  leadAt: string;
  campaignName: string | null;
  /**
   * Whether the lead carries a campaign id at all.
   *
   * 🔴 Separate from having a NAME. A lead attributed to campaign 1203… whose
   * name has not synced yet is not an unattributed lead, and calling it one
   * would report a working UTM setup as a broken one — in a message read once
   * and never revisited.
   */
  attributed: boolean;
  /** Including this one, in the client's day. */
  nthToday: number;
  /** Days since the previous paid lead; null when this is the first ever. */
  daysSincePrevious: number | null;
}

export interface AlertContext {
  clientName: string;
  clientSlug: string;
  /** Absolute dashboard URL, or null when no base URL is configured. */
  dashboardUrl: string | null;
}

export type SkipReason =
  | "disabled"
  | "no_destination"
  | "not_paid"
  | "stale"
  | "already_alerted"
  | "rate_limited";

export interface AlertDecision {
  send: boolean;
  reason: SkipReason | null;
}

/**
 * Should this lead produce an alert?
 *
 * Everything except the "already alerted" claim, which cannot be decided here:
 * it is an atomic UPDATE, because two concurrent webhook retries both reading
 * `alerted_at IS NULL` would both send.
 */
export function decideAlert(opts: {
  enabled: boolean;
  hasDestination: boolean;
  isPaidLead: boolean;
  leadAt: string;
  sentInLastHour: number;
  now: Date;
}): AlertDecision {
  if (!opts.enabled) return { send: false, reason: "disabled" };
  if (!opts.hasDestination) return { send: false, reason: "no_destination" };
  /*
   * The same lead definition every number on the dashboard divides by. An alert
   * for a lead the dashboard will not count is a message about something the
   * reader cannot then find, and the client's own referrals are not news the
   * agency needs pushing at them.
   */
  if (!opts.isPaidLead) return { send: false, reason: "not_paid" };

  const ageHours = (opts.now.getTime() - new Date(opts.leadAt).getTime()) / 3_600_000;
  // NaN from an unparseable date fails both comparisons and is treated as stale,
  // which is the safe direction: a missing arrival time is not evidence of news.
  if (!(ageHours >= 0 && ageHours <= FRESH_HOURS)) {
    return { send: false, reason: "stale" };
  }

  if (opts.sentInLastHour >= MAX_PER_HOUR) {
    return { send: false, reason: "rate_limited" };
  }

  return { send: true, reason: null };
}

/* ------------------------------------------------------------------ *
 * The message
 * ------------------------------------------------------------------ */

function displayName(l: AlertLead): string {
  const full = [l.firstName, l.lastName].filter(Boolean).join(" ").trim();
  return full || l.email || l.phone || "Unnamed lead";
}

const ordinal = (n: number): string => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** The message as plain lines — the shape both destinations are built from. */
export function composeLines(lead: AlertLead, ctx: AlertContext): string[] {
  const lines: string[] = [`New lead — ${displayName(lead)}`];

  const detail = [
    /*
     * Three states, not two. A named campaign; an attributed lead whose
     * campaign name has not synced; and a genuinely unattributed one — the last
     * being worth noticing on its own, since it usually means the ad URL
     * parameters were never applied.
     */
    lead.campaignName ??
      (lead.attributed ? "campaign name not synced yet" : "no campaign attributed"),
    `${ordinal(lead.nthToday)} today`,
  ];
  lines.push(detail.join(" · "));

  // The phone number is the reason for the interruption. Anything that pushes
  // it below the fold defeats the message.
  const contact = [lead.phone, lead.email].filter(Boolean);
  if (contact.length > 0) lines.push(contact.join(" · "));
  else lines.push("No phone or email on the record");

  /*
   * The one genuinely notable thing a CRM notification cannot say. A pipeline
   * restarting after a week of silence is worth more attention than the fourth
   * lead of a busy Tuesday.
   */
  if (lead.daysSincePrevious !== null && lead.daysSincePrevious >= QUIET_DAYS) {
    lines.push(`First lead in ${Math.floor(lead.daysSincePrevious)} days.`);
  } else if (lead.daysSincePrevious === null) {
    lines.push("First lead ever recorded for this client.");
  }

  if (ctx.dashboardUrl) lines.push(ctx.dashboardUrl);
  return lines;
}

/**
 * The JSON body for the destination.
 *
 * Built per target rather than sending both keys and letting each side ignore
 * the other's. That trick works today and is exactly the kind of thing that
 * stops working quietly.
 */
export function composeBody(
  target: AlertTarget,
  lead: AlertLead,
  ctx: AlertContext,
): Record<string, unknown> {
  const lines = composeLines(lead, ctx);
  const [headline, ...rest] = lines;

  if (target === "discord") {
    return { content: [`**${headline}**`, ...rest].join("\n") };
  }
  return {
    text: `${headline} (${ctx.clientName})`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: [`*${headline}*`, ...rest].join("\n") },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: ctx.clientName }],
      },
    ],
  };
}
