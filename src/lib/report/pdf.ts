/**
 * Server-rendered PDF, via a hosted headless browser.
 *
 * ── 🔴 What this exists to fix ─────────────────────────────────────────
 *
 * `window.print()` works, and Chrome stamps the document title, the date, the
 * **source URL** and the page number into the margin whenever its "Headers and
 * footers" checkbox is ticked — which is the default, and which is unreachable
 * from CSS or JavaScript by design. So the first report a client forwards to
 * their board carries this app's Vercel URL in the footer of every page.
 *
 * A "please untick that box" instruction is not a fix; it will not survive one
 * real client. Rendering server-side removes the browser chrome entirely,
 * because there is no browser window and no print dialog. That is the whole
 * point of this file — not fidelity, not automation, just the margin.
 *
 * ── Why a hosted service rather than bundling Chromium ────────────────
 *
 * `@sparticuz/chromium` is ~45MB compressed against Vercel Hobby's 250MB
 * function limit, and it would be bundled into a deployment whose other
 * functions are a webhook receiver and a nightly cron. A hosted renderer is one
 * `fetch` and no bundle cost at all.
 *
 * ── Not configured is a first-class state ─────────────────────────────
 *
 * Same rule as the written summaries: with no key set, `isPdfConfigured()` is
 * false, the button is absent, and the print path still works exactly as before.
 * Nothing degrades into a broken button, and no page needs to know why.
 */

export type PdfProvider = "browserless" | "pdfshift";

export interface PdfConfig {
  provider: PdfProvider;
  key: string;
  /** Override for a self-hosted instance or a different region. */
  url?: string;
}

export function pdfConfig(): PdfConfig | null {
  const key = process.env.PDF_RENDER_KEY;
  if (!key) return null;
  const provider =
    process.env.PDF_RENDER_PROVIDER === "pdfshift" ? "pdfshift" : "browserless";
  return { provider, key, url: process.env.PDF_RENDER_URL || undefined };
}

export function isPdfConfigured(): boolean {
  return pdfConfig() !== null;
}

const DEFAULT_URL: Record<PdfProvider, string> = {
  browserless: "https://production-sfo.browserless.io/pdf",
  pdfshift: "https://api.pdfshift.io/v3/convert/pdf",
};

export class PdfRenderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when the operator can fix this by changing configuration. */
    readonly configurable: boolean,
  ) {
    super(message);
    this.name = "PdfRenderError";
  }
}

/**
 * Build the request for whichever provider is configured.
 *
 * Two adapters rather than one generic shape, because the two differ in where
 * the credential goes (query string vs Basic auth) and in what the URL field is
 * called. A single "generic" adapter would work with neither.
 */
function buildRequest(
  cfg: PdfConfig,
  targetUrl: string,
): { url: string; init: RequestInit } {
  const base = cfg.url ?? DEFAULT_URL[cfg.provider];

  if (cfg.provider === "pdfshift") {
    return {
      url: base,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`api:${cfg.key}`).toString("base64")}`,
        },
        body: JSON.stringify({
          source: targetUrl,
          format: "Letter",
          margin: "0",
          /*
           * The renderer must wait for the charts. Recharts draws after
           * hydration, so a screenshot taken at DOMContentLoaded catches an
           * empty SVG — the exact failure the print spike found on the client
           * side, arriving here by a different route.
           */
          delay: 2500,
        }),
      },
    };
  }

  const url = new URL(base);
  url.searchParams.set("token", cfg.key);
  return {
    url: url.toString(),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: targetUrl,
        options: {
          format: "Letter",
          printBackground: true,
          /*
           * Zero margins. The document supplies its own padding, and a margin
           * here is exactly the strip Chrome would otherwise stamp a URL into —
           * leaving it empty is not a cosmetic choice.
           */
          margin: { top: "0", bottom: "0", left: "0", right: "0" },
        },
        gotoOptions: { waitUntil: "networkidle0", timeout: 30_000 },
      }),
    },
  };
}

/**
 * Render a URL to PDF bytes.
 *
 * 🔴 The URL must be reachable from the public internet. A hosted renderer
 * cannot fetch `localhost`, so this returns a `configurable` error on a local
 * development origin rather than a timeout thirty seconds later that reads like
 * the service is down.
 */
export async function renderPdf(
  targetUrl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const cfg = pdfConfig();
  if (!cfg) {
    throw new PdfRenderError("PDF rendering is not configured.", 503, true);
  }

  const parsed = new URL(targetUrl);
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    throw new PdfRenderError(
      "A hosted renderer cannot reach localhost. Set NEXT_PUBLIC_APP_URL to a public URL, or use the print button locally.",
      503,
      true,
    );
  }

  const { url, init } = buildRequest(cfg, targetUrl);
  const res = await fetch(url, { ...init, signal: opts.signal, cache: "no-store" });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    /*
     * 401/403 is a wrong or exhausted key — something the operator can fix, and
     * worth saying so rather than reporting a generic failure they would go
     * looking for in their own report data.
     */
    const configurable = res.status === 401 || res.status === 403;
    throw new PdfRenderError(
      `PDF service returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
      res.status,
      configurable,
    );
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  /*
   * 🔴 Check it is actually a PDF before handing it back.
   *
   * Some providers answer a failure with 200 and a JSON error body. Serving
   * that as `application/pdf` produces a file that downloads, does not open,
   * and gives the operator nothing to go on — strictly worse than an error.
   * Every PDF begins `%PDF-`.
   */
  const magic = new TextDecoder().decode(bytes.slice(0, 5));
  if (magic !== "%PDF-") {
    throw new PdfRenderError(
      "PDF service answered with something that is not a PDF.",
      502,
      false,
    );
  }

  return bytes;
}
