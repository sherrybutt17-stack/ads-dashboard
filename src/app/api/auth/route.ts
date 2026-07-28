import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type SessionPayload,
} from "@/lib/session";
import { safeEqual } from "@/lib/crypto";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import * as audit from "@/lib/audit";
import {
  verifyCredentials,
  allowedSlugsForUser,
  touchLastLogin,
} from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const ctx = audit.requestContext(req);

  // Throttle before any comparison so credentials aren't brute-forceable.
  const limit = rateLimit(`auth:${clientIp(req)}`, 8, 60_000);
  if (!limit.ok) {
    void audit.record({ action: "auth.rate_limited", targetType: "session", ...ctx });
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  let payload: SessionPayload | null = null;
  let auditMeta: Record<string, unknown> = {};

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
    const slugs =
      user.role === "client" ? await allowedSlugsForUser(user.id) : [];
    payload = { userId: user.id, role: user.role, slugs };
    await touchLastLogin(user.id);
    auditMeta = { userId: user.id, email: user.email, role: user.role };
  } else {
    // Shared-password staff bootstrap (no email supplied).
    const expected = process.env.DASHBOARD_PASSWORD;
    if (!expected) {
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json(
          { ok: false, error: "Authentication is not configured on this server." },
          { status: 503 },
        );
      }
      // Dev convenience: no shared password set → issue a staff session.
      payload = { userId: "shared", role: "staff", slugs: [] };
    } else if (!safeEqual(password, expected)) {
      void audit.record({ action: "auth.login_failed", targetType: "session", ...ctx });
      return NextResponse.json(
        { ok: false, error: "Incorrect password" },
        { status: 401 },
      );
    } else {
      payload = { userId: "shared", role: "staff", slugs: [] };
      auditMeta = { shared: true };
    }
  }

  void audit.record({
    action: "auth.login",
    targetType: "session",
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
  res.cookies.set(SESSION_COOKIE, await createSessionToken(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
