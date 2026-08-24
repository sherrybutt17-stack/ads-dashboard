import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type SessionPayload,
} from "@/lib/session";
import { safeEqual } from "@/lib/crypto";
import { BOOTSTRAP_AGENCY_ID } from "@/db/schema";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";
import {
  verifyCredentials,
  allowedSlugsForUser,
  touchLastLogin,
  getUserByEmail,
  countUsers,
} from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The identity-less session, now reachable ONLY on a first run.
 *
 * ⚠️ It has no database row, so `getSessionUser` returns it unchecked: no
 * demotion, deactivation or grant revocation can touch it, and every action it
 * takes is attributed to nobody. That is why the only remaining path to it is
 * an empty `users` table — where there is genuinely nothing to bind to and no
 * way to create the first account without getting in — and why it expires in
 * hours (`BOOTSTRAP_SESSION_TTL_MS`) rather than in thirty days.
 *
 * Pinned to the bootstrap agency rather than left tenant-less: an empty tenant
 * would buy nothing while `staff` still means "sees everything", and would
 * break the first-run flow it exists for.
 */
/**
 * A first-run session lasts hours, not a month.
 *
 * It is the one session in the system with no database row behind it, so no
 * demotion or deactivation can reach it and its expiry is the only control
 * over how long it exists. Long enough to create a real account, and no longer.
 */
const BOOTSTRAP_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The account the shared password acts as, if one is named and usable.
 *
 * `DASHBOARD_BOOTSTRAP_EMAIL` is how an operator keeps the shared password
 * working after real accounts exist — it stops being an anonymous skeleton key
 * and becomes a second credential for a named, revocable, auditable person.
 * Disabling that user turns the shared password off.
 */
async function bootstrapUser() {
  const email = process.env.DASHBOARD_BOOTSTRAP_EMAIL?.trim();
  if (!email) return null;
  const user = await getUserByEmail(email);
  // A disabled account must not be reachable through the side door either.
  return user && user.status === "active" ? user : null;
}

const SHARED_BOOTSTRAP = {
  agencyId: BOOTSTRAP_AGENCY_ID,
  role: "staff",
  slugs: [],
} as const satisfies Omit<SessionPayload, "userId">;

export async function POST(req: NextRequest) {
  const ctx = audit.requestContext(req);

  // Throttle before any comparison so credentials aren't brute-forceable.
  const limit = rateLimit(`auth:${clientIp(req)}`, 8, 60_000);
  if (!limit.ok) {
    void audit.record({
      action: "auth.rate_limited",
      targetType: "session",
      ...ctx,
    });
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again shortly." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
        },
      },
    );
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  let payload: SessionPayload | null = null;
  let auditMeta: Record<string, unknown> = {};
  let sessionTtlMs = SESSION_TTL_MS;

  if (email) {
    // Individual user login.
    const user = await verifyCredentials(email, password);
    if (!user) {
      void audit.record({
        action: "auth.login_failed",
        targetType: "session",
        metadata: { email },
        ...ctx,
      });
      return NextResponse.json(
        { ok: false, error: "Incorrect email or password" },
        { status: 401 },
      );
    }
    /*
     * 🔴 An unproved address cannot hold a session.
     *
     * Sign-up deliberately issues no session, so this is the gate that makes
     * verification mean anything: without it, "confirm your email" is a
     * suggestion and anyone can hold a working account on an address they
     * typo'd or do not own.
     *
     * Existing logins are unaffected — the migration stamps every row that
     * predates self-serve sign-up, because those accounts were created by hand
     * by someone who already knew the person.
     */
    if (!user.emailVerifiedAt) {
      void audit.record({
        action: "auth.login_unverified",
        targetType: "session",
        /*
         * The user is known here even though the login is refused, and their
         * agency should see the attempt — "my new hire cannot get in" is a
         * support question the trail can answer.
         */
        agencyId: user.agencyId,
        metadata: { userId: user.id, email: user.email },
        ...ctx,
      });
      return NextResponse.json(
        {
          ok: false,
          error:
            "Confirm your email address before signing in. Check your inbox for the link we sent.",
          // Lets the login page offer to resend rather than leaving a dead end.
          needsVerification: true,
        },
        { status: 403 },
      );
    }

    const slugs =
      user.role === "client" ? await allowedSlugsForUser(user.id) : [];
    payload = {
      userId: user.id,
      agencyId: user.agencyId,
      role: user.role,
      slugs,
    };
    await touchLastLogin(user.id);
    auditMeta = { userId: user.id, email: user.email, role: user.role };
  } else {
    // Shared-password staff bootstrap (no email supplied).
    const expected = process.env.DASHBOARD_PASSWORD;
    if (!expected) {
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json(
          {
            ok: false,
            error: "Authentication is not configured on this server.",
          },
          { status: 503 },
        );
      }
      // Dev convenience: no shared password set → issue a staff session.
      payload = { userId: "shared", ...SHARED_BOOTSTRAP };
    } else if (!safeEqual(password, expected)) {
      void audit.record({
        action: "auth.login_failed",
        targetType: "session",
        ...ctx,
      });
      return NextResponse.json(
        { ok: false, error: "Incorrect password" },
        { status: 401 },
      );
    } else {
      /*
       * 🔴 Leak #11, closed here.
       *
       * The correct password used to mint `userId: "shared"` — a `staff`
       * session with no database row behind it. `getSessionUser` returns that
       * unchecked, so nothing could demote it, deactivate it or revoke it, and
       * it saw every client in the database for thirty days under no name at
       * all. Every action it took was attributed to nobody.
       *
       * Two legitimate uses survive, and neither needs a phantom:
       */
      const bound = await bootstrapUser();
      if (bound) {
        /*
         * 1. Bound to a real account. The shared password becomes a second
         *    credential for a NAMED user, so every database re-check applies,
         *    disabling that user revokes it, and the audit log has somebody in
         *    it. This is what an operator who wants to keep using it sets.
         */
        const slugs =
          bound.role === "client" ? await allowedSlugsForUser(bound.id) : [];
        payload = {
          userId: bound.id,
          agencyId: bound.agencyId,
          role: bound.role,
          slugs,
        };
        await touchLastLogin(bound.id);
        auditMeta = { shared: true, boundTo: bound.email, role: bound.role };
      } else if ((await countUsers()) === 0) {
        /*
         * 2. Genuine first run. There is no account to bind to and no way to
         *    create one without getting in, so the phantom is the only door —
         *    but it closes by itself the moment an account exists, and it
         *    expires in hours rather than in a month, because nothing can
         *    revoke a session with no row behind it.
         */
        payload = { userId: "shared", ...SHARED_BOOTSTRAP };
        sessionTtlMs = BOOTSTRAP_SESSION_TTL_MS;
        auditMeta = { shared: true, firstRun: true };
      } else {
        void audit.record({
          action: "auth.shared_refused",
          targetType: "session",
          ...ctx,
        });
        return NextResponse.json(
          {
            ok: false,
            error:
              "The shared password is no longer accepted — this deployment has user accounts. " +
              "Sign in with your email, or use \u201cForgot your password?\u201d below.",
          },
          { status: 401 },
        );
      }
    }
  }

  void audit.record({
    action: "auth.login",
    targetType: "session",
    // Stamped from the session, since a login names no client. Failed logins
    // below deliberately carry no tenant — see `audit.ts`.
    agencyId: payload.agencyId || null,
    metadata: auditMeta,
    ...ctx,
  });

  // Where the browser should land: a client with a single dashboard goes
  // straight to it; everyone else to the (role-filtered) client list.
  const redirect =
    payload.role === "client" && payload.slugs.length === 1
      ? `/c/${payload.slugs[0]}`
      : "/";

  const res = NextResponse.json({ ok: true, role: payload.role, redirect });
  const token = await createSessionToken(payload, Date.now(), sessionTtlMs);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(sessionTtlMs / 1000),
  });
  return res;
}
