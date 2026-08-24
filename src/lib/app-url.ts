/**
 * Where this deployment lives, as one answer instead of fifteen.
 *
 * ── The defect ────────────────────────────────────────────────────────
 *
 * `process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000"`
 * appeared verbatim in fifteen modules, with four different fallbacks
 * (`localhost`, `null`, `""`, `undefined`) and two different trailing-slash
 * regexes. It builds:
 *
 *   - the password-reset link in an email
 *   - the address-verification link in an email
 *   - the scheduled-report link in an email
 *   - the OAuth `redirect_uri` for Meta, Google, TikTok and GHL
 *   - the webhook URL an operator pastes into GoHighLevel
 *
 * 🔴 So a production deploy with that one variable unset mails
 * `http://localhost:3000/reset?token=…` to a real person, and the app reports
 * the mail as sent. The reader is not misconfigured — we are — and nothing in
 * the app can tell, because a link is not checked by sending it. The GHL case
 * is worse still: the wizard shows a localhost webhook URL, the operator pastes
 * it, and step 5 waits for a first event that can never arrive.
 *
 * ── The rules ─────────────────────────────────────────────────────────
 *
 * An explicit setting always wins. Failing that we can usually work it out:
 * Vercel supplies the deployment's own hostname, so "unset" is recoverable in
 * the environment where it matters most. Only after all of that do we fall back
 * to localhost, and only when this is not a production build — a localhost URL
 * is correct in development and is never correct in production.
 *
 * Every caller keeps its own answer to "and what if we still cannot tell":
 * alert payloads omit the link, the report link is left relative, the setup
 * wizard shows what it has. That judgement belongs at the call site; only the
 * derivation is shared.
 */

function clean(value: string | undefined | null): string | null {
  const v = value?.trim();
  if (!v) return null;
  // A bare host ("dash.example.com") would otherwise concatenate into a
  // relative path and produce a link that silently resolves against whatever
  // page it appears on.
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  // All trailing slashes, not one: `https://x.com//` was becoming
  // `https://x.com//api/webhooks/...`, which some routers 404 and some accept.
  return withScheme.replace(/\/+$/, "");
}

/**
 * The public origin of this deployment — scheme and host, no trailing slash —
 * or null when it genuinely cannot be determined.
 */
export function appBaseUrl(): string | null {
  const explicit = clean(process.env.NEXT_PUBLIC_APP_URL);
  if (explicit) return explicit;

  // In the browser the answer is simply where we are. Server-only variables
  // below are not inlined into the client bundle, so this is also the only
  // fallback that works there.
  if (typeof window !== "undefined" && window.location?.origin) {
    return clean(window.location.origin);
  }

  /*
   * Vercel sets both. `VERCEL_URL` is the per-deployment hostname, which is
   * right for a preview branch and wrong for anything durable — a password
   * reset link pointing at a deployment that will be superseded still works
   * today and rots later. `VERCEL_PROJECT_PRODUCTION_URL` is the stable
   * production domain, so it wins everywhere except an actual preview.
   */
  if (process.env.VERCEL_ENV === "preview") {
    const preview = clean(process.env.VERCEL_URL);
    if (preview) return preview;
  }
  const production = clean(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  if (production) return production;
  const deployment = clean(process.env.VERCEL_URL);
  if (deployment) return deployment;

  // Deliberately NOT a production fallback. See the header.
  if (process.env.NODE_ENV !== "production") {
    return `http://localhost:${process.env.PORT || 3000}`;
  }
  return null;
}

/**
 * `appBaseUrl()` with a caller-supplied fallback, for the sites that would
 * rather render something than nothing.
 */
export function appBaseUrlOr<T>(fallback: T): string | T {
  return appBaseUrl() ?? fallback;
}
