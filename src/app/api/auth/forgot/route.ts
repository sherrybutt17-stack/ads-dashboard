import { NextRequest, NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { sendEmail } from "@/lib/reports/email";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";
import { createResetToken, resetUrl, RESET_TTL_MS } from "@/lib/password-reset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Request a password reset link.
 *
 * Public by necessity — someone who cannot sign in cannot present a session.
 *
 * ── 🔴 The response never varies ──────────────────────────────────────
 *
 * Always `200 { ok: true }`, whether the address belongs to an account, a
 * disabled account, or nobody at all. An endpoint that answers differently for a
 * known address is a membership oracle: point it at a list and it tells you
 * which of your competitor's staff have logins here. The cost of getting this
 * wrong is silent and permanent, and the cost of getting it right is one
 * slightly less helpful message.
 *
 * The send itself runs in `after()`, so the response time does not vary with
 * whether an email was actually dispatched either — a timing side channel would
 * leak exactly what the uniform body is there to hide.
 */
export async function POST(req: NextRequest) {
  const ctx = audit.requestContext(req);

  /*
   * Tighter than the login limiter (8/min), because this one sends mail. An
   * unthrottled endpoint that emails an arbitrary address on demand is a way to
   * use our domain's reputation to flood someone else's inbox.
   */
  const limit = rateLimit(`forgot:${clientIp(req)}`, 4, 60_000);
  if (!limit.ok) {
    void audit.record({ action: "auth.reset_rate_limited", targetType: "session", ...ctx });
    return NextResponse.json(
      { ok: false, error: "Too many requests. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  // The uniform answer. Everything below decides only whether an email goes out.
  const ok = NextResponse.json({ ok: true });
  if (!email) return ok;

  after(async () => {
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (!user || user.status !== "active") {
        // Recorded so a burst against unknown addresses is visible in the audit
        // log even though the caller cannot tell it from a hit.
        void audit.record({
          action: "auth.reset_requested_unknown",
          targetType: "session",
          metadata: { email },
          ...ctx,
        });
        return;
      }

      const token = createResetToken(user);
      if (!token) {
        console.error("[forgot] no AUTH_SECRET/ENCRYPTION_KEY — cannot mint a reset token");
        return;
      }

      const url = resetUrl(token);
      const hours = Math.round(RESET_TTL_MS / 3_600_000);
      await sendEmail({
        to: [user.email],
        subject: "Reset your dashboard password",
        text: [
          "Someone asked to reset the password for this dashboard account.",
          "",
          `Open this link to choose a new one: ${url}`,
          "",
          `The link works for ${hours} hour${hours === 1 ? "" : "s"} and once only.`,
          "If this wasn't you, ignore this email — nothing has changed and your current password still works.",
        ].join("\n"),
        html: [
          `<p>Someone asked to reset the password for this dashboard account.</p>`,
          `<p><a href="${url}">Choose a new password</a></p>`,
          `<p>The link works for ${hours} hour${hours === 1 ? "" : "s"} and once only.</p>`,
          `<p>If this wasn't you, ignore this email — nothing has changed and your current password still works.</p>`,
        ].join("\n"),
      });

      void audit.record({
        action: "auth.reset_requested",
        targetType: "user",
        targetId: user.id,
        // 🔴 The token is never logged. It IS the credential for the next hour,
        // and an audit log is read by more people than a password store.
        metadata: { email: user.email },
        ...ctx,
      });
    } catch (err) {
      // Swallowed: the caller already has its 200, and there is no one left to
      // report to. A send failure is a mail-transport problem, visible in the
      // logs, not something the requester can act on.
      console.error("[forgot] reset email failed:", err);
    }
  });

  return ok;
}
