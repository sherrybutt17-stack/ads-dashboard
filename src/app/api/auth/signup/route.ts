import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { agencies, users } from "@/db/schema";
import { hashPassword } from "@/lib/crypto";
import { uniqueAgencySlug } from "@/lib/agencies";
import { getUserByEmail } from "@/lib/users";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { createVerifyToken, verifyUrl, VERIFY_TTL_MS } from "@/lib/email-verification";
import { sendEmail, emailConfigured } from "@/lib/reports/email";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Self-serve sign-up: a new agency, and the person who owns it.
 *
 * ── 🔴 One transaction, or neither row ───────────────────────────────────
 *
 * An agency with no owner is unreachable — nobody can log into it, and it holds
 * the `agencies.slug` its owner wanted forever. A user with no agency cannot
 * exist at all (`users.agency_id` is NOT NULL). Between those, a partial
 * sign-up is a support ticket from someone who has not yet used the product,
 * which is the worst possible moment to ask for one.
 *
 * ── Why this does NOT sign the user in ───────────────────────────────────
 *
 * Issuing a session here would mean the address is never actually proved: click
 * through, land on the dashboard, and the verification email becomes a thing to
 * ignore. Worse, sign-up would then be a way to obtain a working session with a
 * typo'd or someone else's address. They verify first, then log in.
 */

const SignupSchema = z.object({
  agencyName: z.string().trim().min(2, "Agency name is required").max(120),
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().toLowerCase().email("That does not look like an email"),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(200),
});

export async function POST(req: NextRequest) {
  const ctx = audit.requestContext(req);

  /*
   * Tight, and per-IP. This endpoint writes two rows and sends mail on every
   * success, so an unthrottled version is both a way to fill the database and a
   * way to use our sending domain to flood an arbitrary inbox.
   */
  const limit = rateLimit(`signup:${clientIp(req)}`, 3, 60_000);
  if (!limit.ok) {
    void audit.record({ action: "auth.signup_rate_limited", targetType: "session", ...ctx });
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  const parsed = SignupSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Check the form and try again.",
      },
      { status: 400 },
    );
  }
  const { agencyName, email, password, name } = parsed.data;

  /*
   * ⚠️ This tells an anonymous caller whether an address has an account, and
   * that is a membership oracle — the exact thing `/api/auth/forgot` goes to
   * lengths to avoid.
   *
   * It is accepted here, unlike there, because the alternatives are worse.
   * `users.email` is globally unique (the login form has no tenant field, so
   * the address is the only lookup key), so a duplicate cannot silently
   * succeed. The choices are: say so, or return a generic success and send a
   * "you already have an account" email instead — which is the polished answer
   * and needs a second template, a second copy of the send path, and leaves
   * someone who genuinely mistyped staring at a screen that says it worked.
   *
   * The leak is also much weaker than the reset endpoint's: this one is
   * rate-limited to 3/min and every probe is an audited write attempt.
   */
  if (await getUserByEmail(email)) {
    return NextResponse.json(
      {
        ok: false,
        error: "An account with that email already exists. Sign in, or reset your password.",
      },
      { status: 409 },
    );
  }

  /*
   * Resolved BEFORE the transaction, because it reads the same table it is
   * about to write. Inside an interactive transaction that is a self-deadlock
   * waiting for a busy moment.
   */
  const slug = await uniqueAgencySlug(agencyName);
  const passwordHash = hashPassword(password);

  /*
   * If email cannot be sent, the address is verified on creation rather than
   * left permanently unprovable.
   *
   * A self-hosted deployment with no Resend key would otherwise create an
   * account nobody can ever finish, and the operator's only clue would be a
   * verification email that never arrives. Recorded in the audit log so the
   * difference between "proved" and "assumed" survives.
   */
  const canSend = emailConfigured();

  let created;
  try {
    created = await db.transaction(async (tx) => {
      const [agency] = await tx
        .insert(agencies)
        .values({ name: agencyName, slug })
        .returning();
      const [user] = await tx
        .insert(users)
        .values({
          agencyId: agency.id,
          email,
          passwordHash,
          name: name || null,
          // The signer-up owns the agency; they are not platform staff.
          role: "agency",
          emailVerifiedAt: canSend ? null : new Date(),
        })
        .returning();
      return { agency, user };
    });
  } catch (err) {
    /*
     * Almost certainly a unique-index collision on email — two sign-ups racing
     * past the check above. Named rather than surfaced raw: a Postgres
     * constraint string in a sign-up form is neither actionable nor something
     * we want an anonymous caller reading.
     */
    console.error("[signup] failed:", err);
    return NextResponse.json(
      { ok: false, error: "Could not create the account. Try again." },
      { status: 500 },
    );
  }

  void audit.record({
    action: "auth.signup",
    targetType: "agency",
    targetId: created.agency.id,
    // The tenant's own first entry. Without this its creation would be the one
    // event about the agency that the agency cannot see.
    agencyId: created.agency.id,
    metadata: {
      email: created.user.email,
      agency: created.agency.name,
      // Whether the address was proved or merely assumed, at a glance.
      verificationSent: canSend,
    },
    ...ctx,
  });

  /*
   * The send runs after the response. It is a network call to a third party and
   * the account already exists — making the user wait on Resend's latency, or
   * fail on its outage, would turn a completed sign-up into an apparent error
   * and invite them to try again against an email that is now taken.
   */
  if (canSend) {
    after(async () => {
      try {
        const token = createVerifyToken(created.user);
        if (!token) {
          // No signing secret. Loud in the log, because it means nobody who
          // signs up on this deployment can ever finish.
          console.error("[signup] AUTH_SECRET/ENCRYPTION_KEY not set — cannot verify emails");
          return;
        }
        const hours = Math.round(VERIFY_TTL_MS / 3_600_000);
        await sendEmail({
          to: [created.user.email],
          subject: "Confirm your email",
          html:
            `<p>Confirm your address to finish setting up ${escapeHtml(created.agency.name)}.</p>` +
            `<p><a href="${verifyUrl(token)}">Confirm my email</a></p>` +
            `<p>This link works for ${hours} hours. If you did not sign up, ignore this — no account can be used until it is confirmed.</p>`,
          text:
            `Confirm your address to finish setting up ${created.agency.name}.\n\n` +
            `${verifyUrl(token)}\n\n` +
            `This link works for ${hours} hours. If you did not sign up, ignore this.`,
        });
      } catch (err) {
        // Never rethrown: the account exists and the user can request another
        // link. A crash here would be an unhandled rejection and nothing more.
        console.error("[signup] verification email failed:", err);
      }
    });
  }

  return NextResponse.json({
    ok: true,
    // Drives the copy on the confirmation screen — "check your inbox" is a lie
    // on a deployment that cannot send.
    verificationSent: canSend,
    email: created.user.email,
  });
}

/** Minimal escaping — the only untrusted value in the template is the name. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
