/**
 * Where to send the browser after sign-in, given an untrusted `?next=`.
 *
 * No imports: the login page is a client component, and this must stay out of
 * reach of anything that would drag a server module into its bundle.
 *
 * 🔴 Decided by RESOLVING the URL, not by pattern-matching the string.
 *
 * This was `/^\/(?![/\\])/`, which looks complete and is not. The WHATWG URL
 * parser — which `router.push` uses — silently strips tab, CR and LF before it
 * parses, so `/%09/evil.example` passes the regex as "a path starting with a
 * single slash" and then resolves to `https://evil.example/`. The victim types
 * their real password into the real sign-in page and lands on the attacker's
 * "session expired, sign in again". Every variation of that trick (`//`, `/\`,
 * encoded controls, an absolute URL) is answered the same way here: resolve it
 * against our own origin and keep it only if it is still our origin.
 *
 * Returns a same-origin path (pathname + search + hash), or null.
 */
export function safeNextPath(next: string | null | undefined, origin: string): string | null {
  if (!next) return null;
  // Belt and braces: control characters and backslashes have no business in a
  // path we issued, and both are what URL normalisation quietly rewrites. The
  // origin comparison below is what actually decides — it alone refuses every
  // case in the tests — so this line is never the only thing standing guard.
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return null;
  if (!next.startsWith("/")) return null;
  try {
    const url = new URL(next, origin);
    if (url.origin !== new URL(origin).origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
