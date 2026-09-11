/**
 * Path rules for the edge proxy, as pure functions.
 *
 * Extracted from `proxy.ts` so they can be tested directly. A `NextRequest` is
 * awkward to construct and the proxy pulls in `next/server`, so in practice the
 * rules would end up covered either by nothing or by a reimplementation in the
 * test file — and a reimplemented rule is one that silently stops matching the
 * real one.
 *
 * Everything here must stay edge-safe: string logic only, no node built-ins, no
 * database, no imports beyond types.
 */

/**
 * The `/api/c/<slug>/…` resources a client-role user may reach, and how.
 *
 * An allowlist keyed by the resource segment. Adding a resource is a deliberate
 * line here rather than a widened string prefix — under a prefix rule, every
 * future route under `/api/c/` would be reachable by clients the moment it
 * shipped, and nobody adding one would have a reason to think about it.
 */
const CLIENT_RESOURCES: Record<string, readonly string[]> = {
  /*
   * Their own brand. GET covers the logo asset at `branding/logo`; PUT is W3's
   * self-service editing, gated further by the stored `clientEditable` flag.
   */
  branding: ["GET", "PUT"],
  /*
   * Which sections their dashboard shows. DELETE is "reset to defaults" — a
   * destructive verb on a preference, not on data.
   */
  layout: ["GET", "PUT", "DELETE"],
};

/**
 * May a CLIENT-role user reach this `/api/` path?
 *
 * 🔴 The only hole in the blanket `/api/*` deny, and the reason §0a's work
 * mattered: every handler under `/api/` used to survive on that deny alone.
 * Deliberately the narrowest shape that works:
 *
 *   · only `/api/c/<slug>/<resource>…`, for a resource named above
 *   · only a slug the session actually grants
 *   · GET may reach a subpath (the logo asset); writes may NOT. A write to a
 *     subpath is not a route that exists, and a carve-out must not
 *     pre-authorise one that might.
 *
 * This makes a path REACHABLE. It is not what authorizes it — each handler
 * re-derives all of the above from the database and additionally consults the
 * stored permission for that resource before parsing any body.
 */
export function clientApiCarveOut(
  pathname: string,
  method: string,
  slugs: readonly string[],
): boolean {
  if (!pathname.startsWith("/api/c/")) return false;

  const seg = pathname.split("/"); // ["", "api", "c", "<slug>", "<resource>", …]
  const owns = Boolean(seg[3]) && slugs.includes(seg[3]);
  if (!owns) return false;

  const allowed = CLIENT_RESOURCES[seg[4] ?? ""];
  if (!allowed || !allowed.includes(method)) return false;

  // Reads may go deeper; writes act on the resource itself.
  return method === "GET" || seg.length === 5;
}

/* ------------------------------------------------------------------ *
 * One address, not two
 * ------------------------------------------------------------------ */

/**
 * Should this request be sent to the deployment's real domain?
 *
 * ── The failure ───────────────────────────────────────────────────────
 *
 * A Vercel project answers on its `*.vercel.app` name as well as on whatever
 * custom domain is pointed at it, and both serve the same application. Sessions
 * do not work that way: a cookie set on one host is invisible on the other.
 *
 * 🔴 So signing in on the vercel.app name and then starting an OAuth flow
 * produces a completed consent that lands back on the custom domain — where
 * there is no session — and is refused as `unauthorized` at this very gate. The
 * refresh token is discarded, and nothing on screen suggests the cause was
 * which of two equivalent-looking addresses the operator happened to open.
 *
 * ── Why the rule is this narrow ───────────────────────────────────────
 *
 * It fires ONLY for a `*.vercel.app` request host when the configured base URL
 * is something else. Written as "redirect anything that is not canonical", a
 * mistyped `NEXT_PUBLIC_APP_URL` would bounce every visitor, including those on
 * the real domain, to a host that may not answer — the site would be gone and
 * the fix would need a redeploy. Under this rule the worst case is that
 * vercel.app visitors are misdirected while the custom domain keeps serving.
 *
 * Two further exemptions, both load-bearing:
 *
 *   - **`/api/` is never redirected.** GoHighLevel's webhooks may be pointed at
 *     any host we gave the operator, and a webhook sender is not a browser: one
 *     that does not follow a 308 drops the delivery, and a dropped stage change
 *     is funnel history that no later sync can reconstruct. Vercel's own cron
 *     invocations are the same shape, and redirects can strip an Authorization
 *     header. Machines keep talking to whatever address they were given.
 *   - **Preview deployments are never redirected.** Their whole address is a
 *     `*.vercel.app` name; redirecting them to production would make previews
 *     untestable, which is a slower and more confusing failure than the one
 *     this fixes.
 */
export function canonicalHostRedirect(opts: {
  /** The full request URL. */
  url: string;
  /** Origin from `appBaseUrl()`, or null when it cannot be determined. */
  canonicalOrigin: string | null;
  /** True on a Vercel preview deployment (`VERCEL_ENV === "preview"`). */
  isPreview: boolean;
}): string | null {
  const { canonicalOrigin, isPreview } = opts;
  if (!canonicalOrigin || isPreview) return null;

  let req: URL;
  let canonical: URL;
  try {
    req = new URL(opts.url);
    canonical = new URL(canonicalOrigin);
  } catch {
    return null;
  }

  if (req.pathname.startsWith("/api/")) return null;

  const isVercelAlias = (host: string) =>
    host === "vercel.app" || host.endsWith(".vercel.app");

  // Only the shared platform name gets moved, and only when there is somewhere
  // better to move it to.
  if (!isVercelAlias(req.hostname)) return null;
  if (isVercelAlias(canonical.hostname)) return null;
  if (req.hostname === canonical.hostname) return null;

  const target = new URL(req.pathname + req.search, canonical.origin);
  return target.toString();
}
