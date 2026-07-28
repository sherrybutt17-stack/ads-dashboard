import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/session";

/**
 * Auth + authorization gate.
 *
 * Public paths (no session needed):
 *   /api/webhooks/*  — GoHighLevel cannot present a session; secured by its
 *                      unguessable per-client token / signature instead.
 *   /api/cron/*      — guarded by CRON_SECRET.
 *   /api/auth, /login, static — needed to obtain a session.
 *
 * Everything else requires a valid signed session. The token itself carries the
 * user's role and the client slugs they may see, so authorization is enforced
 * here at the edge with NO database call:
 *   - staff  → full access.
 *   - client → only "/" (the list, filtered server-side) and their own
 *              /c/<slug> dashboards; never setup, audit, users, other clients,
 *              or admin APIs.
 */

const PUBLIC_PREFIXES = [
  "/api/webhooks/",
  "/api/cron/",
  "/api/auth",
  "/api/logout",
  "/login",
  "/_next/",
  "/favicon",
];

function loginRedirect(req: NextRequest, pathname: string) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

function to(req: NextRequest, pathname: string) {
  const url = req.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return NextResponse.redirect(url);
}

export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const session = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return loginRedirect(req, pathname);
  }

  // Staff: unrestricted.
  if (session.role === "staff") return NextResponse.next();

  // Client: scoped to their own dashboards only.
  if (pathname === "/") return NextResponse.next(); // list, filtered server-side

  if (pathname.startsWith("/c/")) {
    const seg = pathname.split("/"); // ["", "c", "<slug>", "setup"?]
    const slug = seg[2];
    const isSetup = seg[3] === "setup";
    const owns = Boolean(slug) && session.slugs.includes(slug);
    if (owns && !isSetup) return NextResponse.next();
    // Their own client but a staff-only subpage (setup) → back to the dashboard;
    // someone else's client → back to their list.
    return to(req, owns ? `/c/${slug}` : "/");
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // /audit, /users, anything else staff-only → their own list.
  return to(req, "/");
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
