import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getClientUnscoped } from "@/lib/clients";
import { loadDashboard } from "@/lib/metrics/dashboard";
import { getClientBranding, getAgencySettings } from "@/lib/branding-store";
import { rangeLabel } from "@/lib/dates";
import type { AdPlatform } from "@/lib/metrics/queries";
import { parseAdPlatform } from "@/lib/platforms";
import {
  resolveShareToken,
  recordShareView,
  checkSharePassword,
  sharePassProof,
  checkPassProof,
  passCookieName,
  type ShareFailure,
} from "@/lib/share";
import { rateLimit } from "@/lib/rate-limit";
import { ReportDocument, REPORT_WIDTH } from "@/components/report/ReportDocument";
import { PrintButton } from "@/components/report/PrintButton";
import { Icon } from "@/components/Icon";
import { record as recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * A shared report, reached by an unauthenticated bearer URL.
 *
 * This is the only page in the app outside the session gate, so everything it
 * does is deliberate:
 *
 *   · The token is the credential. It is hashed before any lookup, never logged,
 *     and never echoed back into the page.
 *   · The period is whatever was frozen into the link, NOT a URL parameter — a
 *     recipient cannot widen the range to a quarter the sender never approved.
 *   · No lead-level data, ever (see `ReportDocument`).
 *   · `noindex`, and a referrer policy that stops the token leaking outward in
 *     a `Referer` header.
 *
 * The failure states are distinguished — expired vs revoked vs unknown —
 * because "this link expired on 3 August, ask for a new one" is actionable and
 * "not found" sends the reader back down the chain for nothing. Saying which of
 * the three applies reveals nothing about any OTHER link; the reader already
 * holds this one.
 */

export const metadata: Metadata = {
  // Belt and braces with the header below. A shared report is a private
  // document that happens to be reachable without a login.
  robots: { index: false, follow: false, nocache: true },
};

export default async function SharedReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const resolution = await resolveShareToken(token);

  if (!resolution.ok) return <ShareProblem reason={resolution.reason} />;
  const { link } = resolution;

  /*
   * The password gate.
   *
   * Held in a cookie bound to the link id AND the current password hash, so
   * rotating the password invalidates every proof already handed out — a
   * rotation that left old sessions working would protect nothing.
   */
  const jar = await cookies();
  if (link.passwordHash) {
    const proof = jar.get(passCookieName(link.id))?.value;
    if (!checkPassProof(link, proof)) {
      return <PasswordGate token={token} problem={sp.e} />;
    }
  }
  // Unscoped by design: a share link is authorized by its unguessable token,
  // which was already verified above. There is no session to scope against —
  // the whole point of the link is that the recipient does not have one.
  const client = await getClientUnscoped(link.clientId, "share_token");
  if (!client) return <ShareProblem reason="not_found" />;

  const platform: AdPlatform = parseAdPlatform(link.platform);
  const [data, branding, agency] = await Promise.all([
    loadDashboard(
      client,
      { startKey: link.rangeStart, endKey: link.rangeEnd },
      platform,
    ),
    getClientBranding(client.id),
    // Branding follows the client's OWNER, not the viewer: a report is signed
    // by the agency whose client it is, wherever it is being read from.
    getAgencySettings(client.agencyId),
  ]);

  /*
   * Counted after the response, not before it. `after()` rather than a floating
   * promise for the same reason the dashboard uses it: a serverless invocation
   * can be frozen the instant its response flushes, cutting a detached write off
   * mid-flight.
   */
  after(async () => {
    await recordShareView(link.id);
  });

  return (
    <ReportDocument
      client={client}
      branding={branding}
      agency={agency}
      data={data}
      platform={platform}
      rangeStart={link.rangeStart}
      rangeEnd={link.rangeEnd}
      toolbar={
        <div
          className="no-print mx-auto flex flex-wrap items-center justify-between gap-3 px-4 pt-6"
          style={{ maxWidth: REPORT_WIDTH }}
        >
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Shared report · <span className="tnum">{rangeLabel(link.rangeStart, link.rangeEnd)}</span>
            {" · "}
            access expires{" "}
            <span className="tnum">
              {link.expiresAt.toISOString().slice(0, 10)}
            </span>
          </span>
          <PrintButton />
        </div>
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * The password gate
 * ------------------------------------------------------------------ */

/**
 * A plain form posting to a server action — no client JavaScript.
 *
 * A shared report is a document sent to someone who did not ask for an app.
 * Mail clients, corporate proxies and locked-down browsers all break JavaScript
 * far more often than they break a form POST, and "the password box does
 * nothing" is not a support conversation worth having with a client's board
 * member.
 *
 * Outcomes are carried back in the URL rather than in component state for the
 * same reason: a redirect works without JavaScript, and a gate that silently
 * does nothing on a wrong password is indistinguishable from a broken one.
 */
async function unlock(formData: FormData) {
  "use server";

  const token = String(formData.get("token") ?? "");
  const attempt = String(formData.get("password") ?? "");

  const resolution = await resolveShareToken(token);
  // The link died between render and submit — fall through to the page, which
  // will report expired/revoked properly.
  if (!resolution.ok) redirect(`/r/${token}`);
  const { link } = resolution;

  /*
   * Rate limited per link, not per IP.
   *
   * The threat here is someone who legitimately holds the URL — it was
   * forwarded to them — trying to guess a phrase they were not given. Keying on
   * IP alone would let that same person retry from a phone; keying on the link
   * caps the total attempts against THIS report regardless of where they come
   * from. The cost is that a determined guesser can lock out honest readers for
   * a few minutes, which is the correct trade for a document containing a
   * client's revenue.
   */
  const gate = rateLimit(`share:${link.id}`, 8, 10 * 60_000);
  if (!gate.ok) redirect(`/r/${token}?e=wait`);

  if (!checkSharePassword(link, attempt)) {
    await recordAudit({
      action: "share_link.password_failed",
      targetType: "share_link",
      targetId: link.id,
      clientId: link.clientId,
    });
    redirect(`/r/${token}?e=bad`);
  }

  const jar = await cookies();
  jar.set(passCookieName(link.id), sharePassProof(link), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    /*
     * Scoped to THIS link's path. A cookie at `/` would ride along to every
     * other shared report on the domain — harmless today because each one is
     * checked against its own proof, but it would put one recipient's cookie in
     * requests for another client's report, which is not a property to leave
     * lying around.
     */
    path: `/r/${token}`,
    // Never outlives the link it unlocks.
    expires: link.expiresAt,
  });

  // Force a fresh GET so the newly-set cookie is read on the way back in.
  redirect(`/r/${token}`);
}

const GATE_PROBLEM: Record<string, string> = {
  bad: "That password was not right. Check it with whoever sent you the link.",
  wait: "Too many attempts. Try again in a few minutes.",
};

function PasswordGate({ token, problem }: { token: string; problem?: string }) {
  const message = problem ? GATE_PROBLEM[problem] : null;
  return (
    <Centred>
      <h1
        className="text-[17px] font-semibold"
        style={{ color: "var(--text-primary)" }}
      >
        This report is password protected
      </h1>
      <p className="mt-1 mb-4 text-[13px]" style={{ color: "var(--text-secondary)" }}>
        Enter the password you were given alongside the link.
      </p>
      {message && (
        <p
          role="alert"
          className="mb-3 flex items-start gap-1.5 text-[12px]"
          style={{ color: "var(--status-critical)" }}
        >
          <Icon name="alert" size={12} className="mt-[2px] shrink-0" />
          {message}
        </p>
      )}
      <form action={unlock} className="flex flex-col gap-2">
        <input type="hidden" name="token" value={token} />
        <input
          type="password"
          name="password"
          autoFocus
          required
          aria-label="Report password"
          className="w-full rounded-[8px] border px-3 py-2 text-[13px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
        <button
          type="submit"
          className="rounded-[8px] px-3 py-2 text-[13px] font-medium text-white"
          style={{ background: "var(--brand, var(--series-1))" }}
        >
          View report
        </button>
      </form>
    </Centred>
  );
}

/* ------------------------------------------------------------------ *
 * Failure states
 * ------------------------------------------------------------------ */

const PROBLEM: Record<ShareFailure, { title: string; detail: string }> = {
  not_found: {
    title: "This link is not valid",
    detail:
      "It may have been copied incompletely — share links break easily when a URL wraps across two lines in an email. Ask whoever sent it for a fresh one.",
  },
  expired: {
    title: "This link has expired",
    detail:
      "Share links are time-limited on purpose, because a forwarded URL cannot be recalled. Ask for a new one and it will open straight away.",
  },
  revoked: {
    title: "This link has been turned off",
    detail: "Whoever created it has revoked access. Ask them for a new link.",
  },
  unavailable: {
    title: "This report cannot be loaded right now",
    detail:
      "The link itself is fine — we could not reach the data behind it. This is our problem, not yours; try again shortly, and tell whoever sent it if it persists.",
  },
};

function ShareProblem({ reason }: { reason: ShareFailure }) {
  const { title, detail } = PROBLEM[reason];
  return (
    <Centred>
      <h1 className="text-[17px] font-semibold" style={{ color: "var(--text-primary)" }}>
        {title}
      </h1>
      <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
        {detail}
      </p>
    </Centred>
  );
}

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-20">
      <div className="card w-full max-w-[420px] p-6">{children}</div>
    </div>
  );
}
