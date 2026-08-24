import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/session";
import { clientApiCarveOut } from "@/lib/proxy-rules";

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
 *   - staff / superadmin → full access.
 *   - agency             → everything except /audit, which cannot yet be
 *                          scoped to one tenant. Which ROWS they see is decided
 *                          behind the edge, not here.
 *   - client             → only "/" (the list, filtered server-side) and their
 *                          own /c/<slug> dashboards; never setup, audit, users,
 *                          other clients, or admin APIs.
 *
 * 🔴 The edge decides PATHS, never rows. It has no database, so it cannot ask
 * whether a client belongs to the session's agency — that question is answered
 * by `getClientForSession` / `requireClient` in the handler. Letting the agency
 * tier through here is not a grant of anything; it is a grant of the chance to
 * be scoped properly one layer down.
 */

const PUBLIC_PREFIXES = [
  "/api/webhooks/",
  "/api/cron/",
  "/api/auth",
  "/api/logout",
  "/login",
  /*
   * Password reset, both halves. Someone who cannot sign in cannot present a
   * session, so requiring one would make the feature unreachable by exactly the
   * people it exists for.
   *
   * `/forgot` holds no data and reveals nothing — its confirmation is identical
   * whether or not the address has an account. `/reset` renders a form and
   * nothing else; the HMAC-signed token is verified server-side on submit, and
   * because the signature covers the user's current password hash, a link stops
   * verifying the moment the password changes. See `lib/password-reset.ts`.
   */
  "/forgot",
  "/reset",
  /*
   * Sign-up and email confirmation. Neither can require a session — one creates
   * the account and the other exists precisely because the account cannot be
   * signed into yet.
   *
   * `/signup` is a form; the route behind it is rate-limited and creates an
   * account that cannot hold a session until the address is confirmed.
   * `/verify` renders a button and nothing else: the HMAC-signed token is
   * checked server-side on submit, and because the signature covers
   * `email_verified_at`, a link stops verifying the instant it is used.
   */
  "/signup",
  "/verify",
  /*
   * Shared reports. The recipient is a client's board member or accountant who
   * has no login and should not need one — the unguessable, expiring, revocable
   * token in the URL IS the credential, and the page verifies it against a
   * stored hash before rendering anything. See `src/lib/share.ts` for the threat
   * model, and `ReportDocument` for why a shared report carries no lead-level
   * data.
   */
  "/r/",
  /*
   * The report as fetched by the hosted headless browser that renders the PDF.
   * It arrives with no session — that is the entire problem this path solves —
   * and the 90-second HMAC-signed token in the URL is the credential. The page
   * verifies the signature and 404s on anything else, and the token covers the
   * client and the date range so a valid one cannot be replayed against a
   * different report. See `src/lib/report/render-token.ts`.
   */
  "/render/",
  /*
   * The three pages Google's OAuth verification requires to be reachable
   * WITHOUT signing in: an application home page, a privacy policy, and terms.
   * A reviewer who is bounced to a login cannot approve the consent screen, and
   * the whole app is behind this gate by default.
   *
   * They are safe to expose because they contain no client data of any kind —
   * no names, no figures, no links into the app beyond a sign-in button. That
   * is a property of what is written on them, so it is worth re-checking rather
   * than assuming whenever they change.
   */
  "/about",
  "/legal/",
  "/_next/",
  /*
   * The app icon.
   *
   * 🔴 `favicon.ico` is excluded by the matcher below, but `src/app/icon.svg`
   * builds as its own route and was not exempt anywhere — so a request for it
   * with no session got a 302 to `/login`, the browser received HTML where an
   * image should be, and every logged-out page rendered without an icon. That
   * is the login page, the sign-up page, a shared report at `/r/…`, and the
   * `/about` and `/legal/*` pages a Google OAuth reviewer is asked to look at.
   */
  "/icon.svg",
  "/favicon.ico",
];

/**
 * Is this path public?
 *
 * 🔴 Not a bare `startsWith`. That is what this was, and it makes every entry a
 * silent wildcard over its own name: `"/api/auth"` would exempt a future
 * `/api/authorize`, `"/about"` would exempt `/about-clients`, `"/verify"` would
 * exempt `/verify-anything`. Nothing in the list is currently reachable that
 * way — checked — but the failure mode is a route that is public because of how
 * it was NAMED, which is invisible at the point somebody adds it and is not the
 * kind of thing to leave to luck on an auth boundary.
 *
 * An entry ending in `/` is a subtree. Anything else matches exactly, or as a
 * path segment beneath itself — so `/about` still covers `/about/team` and
 * never covers `/about-us`.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) =>
    p.endsWith("/")
      ? pathname.startsWith(p)
      : pathname === p || pathname.startsWith(`${p}/`),
  );
}

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

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const session = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return loginRedirect(req, pathname);
  }

  /*
   * Agency operators: everything except the platform-wide surfaces.
   *
   * `staff` is the pre-tenancy role and still means "all of it". `superadmin`
   * is its successor. `agency` runs one book — the proxy lets it through, and
   * the SCOPING is done by the server components and route handlers behind it,
   * which return only that agency's rows. The edge cannot do the tenant check
   * without a database read, which is the one thing it exists to avoid.
   */
  if (session.role === "staff" || session.role === "superadmin") {
    return NextResponse.next();
  }
  if (session.role === "agency") {
    /*
     * `/audit` is reachable since 0024 gave `audit_log` an `agency_id`. The
     * page shows this agency its own entries and only those — decided in SQL by
     * `auditScope`, not here. The edge has no database and could not make that
     * distinction; all it does is stop being an obstacle to it.
     */
    return NextResponse.next();
  }

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

  /*
   * The one API path a client-role user may reach: their OWN branding.
   *
   * Without this, the blanket 403 below means the agency sees a client's logo on
   * every page while the client — the only person the branding exists for — sees
   * a broken image, and cannot edit anything.
   *
   * The rule itself lives in `proxy-rules.ts` so it can be tested against a full
   * decision table rather than through a constructed `NextRequest`. See that
   * file for why it has exactly this shape, and why it is not what authorizes
   * the request.
   */
  if (clientApiCarveOut(pathname, req.method, session.slugs)) {
    return NextResponse.next();
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
