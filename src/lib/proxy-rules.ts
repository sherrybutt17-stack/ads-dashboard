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
