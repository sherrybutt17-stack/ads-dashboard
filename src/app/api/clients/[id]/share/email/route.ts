import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, requireClient, agencyGuard } from "@/lib/auth";
import { isValidDateKey } from "@/lib/dates";
import { record as recordAudit, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  mintShareLink,
  shareUrlFor,
  SHARE_TTL_DAYS,
  DEFAULT_SHARE_TTL_DAYS,
  MIN_SHARE_PASSWORD,
} from "@/lib/share";
import {
  emailConfig,
  emailConfigured,
  senderProblem,
  sendEmail,
  EmailError,
} from "@/lib/reports/email";
import { renderReportEmail } from "@/lib/reports/template";
import { adHocPeriod } from "@/lib/reports/schedule";
import { getClientBranding } from "@/lib/branding-store";
import { getUserById } from "@/lib/users";
import { AD_PLATFORMS } from "@/lib/platforms";
import { appBaseUrl } from "@/lib/app-url";

export const runtime = "nodejs";

/**
 * Email a share link, now, to an address somebody typed.
 *
 * ── What this is, next to the scheduled report ────────────────────────
 *
 * `/api/clients/[id]/reports` sends the SAME email on a cadence, to a saved
 * recipient list, for whole completed periods only. This one sends it once, to
 * an address supplied in the request, for whatever range the operator is
 * looking at. Both mint a share link and both render through
 * `renderReportEmail`, deliberately — see the note on forking below.
 *
 * ── 🔴 A LINK, never an attachment ────────────────────────────────────
 *
 * The same rule `reports/send.ts` states and its tests enforce. A PDF in an
 * inbox is a frozen snapshot that cannot be corrected or revoked, and Meta
 * restates for up to 28 days. The link expires, can be revoked after the fact,
 * and resolves to current figures when it is opened. `Outgoing` has no
 * `attachments` field and this route does not add one.
 *
 * ── 🔴 Staff only, and the reason is the outbound address ─────────────
 *
 * `reports/route.ts` makes this argument already: a recipient list is an
 * OUTBOUND address list, and a client-role user able to set one could have
 * their own report mailed anywhere. It is more true here, because nothing
 * about this send is constrained by a schedule — the address arrives in the
 * request body.
 *
 * ── 🔴 The new abuse surface, named ───────────────────────────────────
 *
 * This is an authenticated relay: a signed-in operator can cause mail to be
 * sent, from a domain the agency went to some trouble to get DKIM-verified, to
 * an arbitrary address. That is worth a per-user limit and not only a
 * per-client one — without it, one operator can fan out across every client in
 * their book and burn the sending reputation that makes every other client's
 * report arrive at all.
 */

const Body = z
  .object({
    to: z
      .array(z.string().trim().email().max(320))
      .min(1)
      .max(5)
      .transform((xs) => [...new Set(xs.map((x) => x.toLowerCase()))]),
    rangeStart: z.string().refine(isValidDateKey, "Invalid start date"),
    rangeEnd: z.string().refine(isValidDateKey, "Invalid end date"),
    // Every platform with a dashboard tab — TikTok included.
    platform: z.enum(AD_PLATFORMS).default("meta"),
    label: z.string().max(80).optional(),
    ttlDays: z
      .number()
      .refine(
        (n) => (SHARE_TTL_DAYS as readonly number[]).includes(n),
        `Expiry must be one of ${SHARE_TTL_DAYS.join(", ")} days`,
      )
      .default(DEFAULT_SHARE_TTL_DAYS),
    password: z.string().min(MIN_SHARE_PASSWORD).max(64).optional(),
    message: z.string().max(500).optional(),
  })
  .strict()
  .refine((b) => b.rangeStart <= b.rangeEnd, {
    message: "Range starts after it ends",
    path: ["rangeStart"],
  });

/** Per client. A handful of ad-hoc sends an hour is already generous. */
const PER_CLIENT = 5;
/** Per operator, across every client they can reach. See the header. */
const PER_USER = 20;
const WINDOW_MS = 60 * 60_000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await agencyGuard();
  if (denied) return denied;

  const { id } = await params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client } = got;

  /*
   * Configuration is checked before the body is read, so an operator on a
   * deployment with no mail set up is told that rather than having their
   * carefully typed message rejected for a validation reason.
   *
   * 501 and 503 are distinct on purpose: 501 is "this deployment does not do
   * email", 503 is "it does, and it is misconfigured in a way you can fix" —
   * and `senderProblem` already returns a sentence written to be read by an
   * operator rather than a developer.
   */
  if (!emailConfigured()) {
    return NextResponse.json(
      {
        error:
          "Email is not configured on this deployment. Set RESEND_API_KEY and REPORT_FROM (or RESEND_FROM).",
      },
      { status: 501 },
    );
  }
  const problem = senderProblem(emailConfig()!.from);
  if (problem) return NextResponse.json({ error: problem }, { status: 503 });
  /*
   * 🔴 The emailed link must be one the recipient can open. `shareUrlFor`
   * falls back to http://localhost:3000 when no public URL is resolvable — so
   * a deployment missing NEXT_PUBLIC_APP_URL would email a client a link to
   * their own machine, and report it as sent. Refused before anything is
   * minted or any budget spent.
   */
  if (!appBaseUrl()) {
    return NextResponse.json(
      {
        error:
          "This deployment's public URL could not be determined, so an emailed link would not open. Set NEXT_PUBLIC_APP_URL.",
      },
      { status: 501 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }
  const { to, rangeStart, rangeEnd, platform, label, ttlDays, password, message } =
    parsed.data;

  const session = await getSessionUser();

  const perClient = rateLimit(`share-email:${client.id}`, PER_CLIENT, WINDOW_MS);
  if (!perClient.ok) {
    return NextResponse.json(
      { error: "Too many reports emailed for this client. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(perClient.retryAfterMs / 1000)) },
      },
    );
  }
  const perUser = rateLimit(
    `share-email-user:${session?.userId ?? "unknown"}`,
    PER_USER,
    WINDOW_MS,
  );
  if (!perUser.ok) {
    return NextResponse.json(
      { error: "Too many reports emailed. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(perUser.retryAfterMs / 1000)) },
      },
    );
  }

  let token: string;
  let row: Awaited<ReturnType<typeof mintShareLink>>["row"];
  try {
    ({ token, row } = await mintShareLink({
      clientId: client.id,
      rangeStart,
      rangeEnd,
      platform,
      /*
       * Labelled with the first recipient by default. This is what makes
       * "revoke the one the CFO got" an answerable question later — the share
       * list shows labels, and an unlabelled emailed link is indistinguishable
       * from one that was copied.
       */
      label: label?.trim() || `Emailed — ${to[0]}`,
      ttlDays,
      password: password || null,
      createdBy: session?.userId ?? null,
    }));
  } catch (err) {
    console.error("[share-email] mint failed:", err);
    return NextResponse.json(
      { error: "Could not create the link, so nothing was sent." },
      { status: 500 },
    );
  }

  /*
   * Who it came from, named in the body so a recipient who was not expecting it
   * knows why it arrived. Best-effort: the shared-password bootstrap session
   * has `userId: "shared"` and no row behind it, and a failed lookup here must
   * not stop a send — the email simply reads the way the scheduled one does.
   */
  const sender = session?.userId
    ? await getUserById(session.userId).catch(() => null)
    : null;

  const branding = await getClientBranding(client.id).catch(() => null);
  const mail = renderReportEmail({
    clientName: branding?.displayName || client.name,
    period: adHocPeriod(rangeStart, rangeEnd),
    url: shareUrlFor(token),
    expiresAt: row.expiresAt,
    /* Ad-hoc sends have no cadence, so nothing can have been skipped. */
    skipped: [],
    message: message ?? null,
    senderName: sender?.name ?? null,
  });

  let providerId: string | null = null;
  try {
    ({ id: providerId } = await sendEmail({ to, ...mail }));
  } catch (err) {
    /*
     * The link already exists at this point and is left in place rather than
     * rolled back: it is harmless, it is visible in the share list, and it is
     * revocable. Deleting it would be the more surprising behaviour if the
     * provider actually did deliver and only the response was lost.
     */
    const e = err as EmailError;
    console.error("[share-email] send failed:", err);
    /*
     * The link is live even though the email is not, so it is audited here
     * too. Otherwise a working bearer link exists that no audit entry
     * mentions — "who created this?" would have no answer.
     */
    await recordAudit({
      action: "share_link.email_failed",
      targetType: "share_link",
      targetId: row.id,
      clientId: client.id,
      ...requestContext(req),
      metadata: {
        recipients: to,
        providerStatus: e instanceof EmailError ? e.status : null,
        expiresAt: row.expiresAt.toISOString(),
      },
    }).catch(() => {});
    /*
     * Never the provider's own status. Resend answers 401/403 for a bad key or
     * an unverified domain, and in THIS app 401/403 mean "you are not allowed"
     * — passing them through tells the operator their session is the problem.
     * 503 for something configuration can fix, 502 for anything else.
     */
    return NextResponse.json(
      {
        error:
          e instanceof EmailError && e.configurable
            ? e.message
            : "The link was created but the email could not be sent.",
        url: shareUrlFor(token),
      },
      { status: e instanceof EmailError && e.configurable ? 503 : 502 },
    );
  }

  await recordAudit({
    action: "share_link.emailed",
    targetType: "share_link",
    targetId: row.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: {
      /*
       * The recipients ARE the record. Same reasoning as the `personal` flag on
       * `client.exported`: "who sent this client's figures to whom, and when"
       * is precisely the question an audit log exists to answer, and a share
       * link row cannot answer it — it stores who created the link, not who it
       * was sent to.
       *
       * The token is not here, for the same reason `share_link.create` omits
       * it: the log is read by more people than hold the link.
       */
      recipients: to,
      providerId,
      hasMessage: Boolean(message?.trim()),
      rangeStart: row.rangeStart,
      rangeEnd: row.rangeEnd,
      expiresAt: row.expiresAt.toISOString(),
      hasPassword: Boolean(row.passwordHash),
    },
  });

  return NextResponse.json({
    id: row.id,
    /*
     * Returned once, exactly as the mint endpoint does — the operator gets the
     * send AND a copyable link, so "also paste it in Slack" does not require a
     * second link with its own expiry to revoke later.
     */
    url: shareUrlFor(token),
    expiresAt: row.expiresAt.toISOString(),
    recipients: to.length,
  });
}
