import type { User } from "@/db/schema";
import {
  createInviteToken,
  inviteUrl,
  INVITE_TTL_MS,
  PASSWORD_LINK_TTL_MS,
} from "@/lib/invites";
import { renderAccessEmail, lifetime, type AccessLinkKind } from "@/lib/invite-email";
import { emailConfig, senderProblem, sendEmail } from "@/lib/reports/email";
import { getAgencySettings } from "@/lib/branding-store";

/**
 * Mint an invite or password link for a login, and try to email it.
 *
 * ── 🔴 The link comes back to the operator either way ────────────────────
 *
 * Email on this deployment can be unconfigured, or configured on a domain the
 * provider has not verified yet — and then every send fails. If the link only
 * ever travelled by email, inviting someone would be impossible until DNS was
 * fixed, and the operator would be pushed straight back to typing a password
 * into WhatsApp, which is the thing this replaces.
 *
 * So the operator always gets the URL to copy, and is told plainly whether the
 * email went. Handing it to them grants nothing they lacked: an operator who
 * may manage this login could already set its password outright.
 *
 * ── Sent in the request, not in `after()` ────────────────────────────────
 *
 * `/api/auth/forgot` defers its send so its response cannot reveal whether an
 * address has an account. That concern does not exist here — the caller is an
 * authenticated operator looking at their own team — and the thing they need to
 * know is precisely whether the email went, so they can fall back to copying.
 */

export interface IssuedLink {
  kind: AccessLinkKind;
  url: string;
  expiresAt: string;
  /** "7 days", "24 hours" — the same words the email uses. */
  lifetime: string;
  /** True only when the provider accepted the message. */
  emailed: boolean;
  /** Why it was not emailed, in a sentence the operator can act on. */
  emailProblem: string | null;
}

/** Long enough for a slow provider, short enough that the button feels alive. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Returns null when no signing secret is configured — in which case no link
 * can be minted at all. Callers check `invitesConfigured()` first so that never
 * happens after a login has already been created.
 */
export async function issueAccessLink(opts: {
  user: Pick<User, "id" | "email" | "passwordHash" | "agencyId" | "name">;
  kind: AccessLinkKind;
  inviterName: string | null;
  clientNames: readonly string[];
}): Promise<IssuedLink | null> {
  const ttlMs = opts.kind === "invite" ? INVITE_TTL_MS : PASSWORD_LINK_TTL_MS;
  const minted = createInviteToken(opts.user, { ttlMs });
  if (!minted) return null;

  const url = inviteUrl(minted.token);
  const base = {
    kind: opts.kind,
    url,
    expiresAt: minted.expiresAt.toISOString(),
    lifetime: lifetime(ttlMs),
  };

  const cfg = emailConfig();
  if (!cfg) {
    return {
      ...base,
      emailed: false,
      emailProblem: "Email isn't set up on this deployment, so nothing was sent.",
    };
  }
  const bad = senderProblem(cfg.from);
  if (bad) return { ...base, emailed: false, emailProblem: bad };

  try {
    const { agencyName } = await getAgencySettings(opts.user.agencyId);
    const mail = renderAccessEmail({
      kind: opts.kind,
      agencyName: agencyName ?? "",
      name: opts.user.name,
      inviterName: opts.inviterName,
      clientNames: opts.clientNames,
      url,
      ttlMs,
    });
    await sendEmail(
      { to: [opts.user.email], ...mail },
      { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    );
    return { ...base, emailed: true, emailProblem: null };
  } catch (err) {
    /*
     * The provider's own sentence, passed through. "The growthguild.us domain
     * is not verified" is exactly what the operator needs to read, and this
     * response goes only to an authenticated operator.
     */
    const why = (err instanceof Error ? err.message : "")
      .trim()
      .replace(/[.\s]+$/, "");
    return {
      ...base,
      emailed: false,
      // Always ends a sentence: the panel follows it with "Copy the link…".
      emailProblem: `The email didn't send (${why || "the email provider refused it"}).`,
    };
  }
}
