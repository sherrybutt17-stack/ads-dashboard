import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PdfRenderError, isPdfConfigured, pdfConfig, renderPdf } from "./pdf";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.PDF_RENDER_KEY = "test-key";
  delete process.env.PDF_RENDER_PROVIDER;
  delete process.env.PDF_RENDER_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

/** A response carrying real PDF magic bytes. */
function pdfResponse(body = "%PDF-1.7\n…") {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("configuration", () => {
  it("is unconfigured with no key, and that is a normal state", () => {
    // Same rule as the written summaries: the button is absent, the print path
    // still works, and nothing degrades into a broken control.
    delete process.env.PDF_RENDER_KEY;
    expect(isPdfConfigured()).toBe(false);
    expect(pdfConfig()).toBeNull();
  });

  it("defaults to browserless", () => {
    expect(pdfConfig()?.provider).toBe("browserless");
  });

  it("selects pdfshift when asked", () => {
    process.env.PDF_RENDER_PROVIDER = "pdfshift";
    expect(pdfConfig()?.provider).toBe("pdfshift");
  });

  it("falls back to browserless for an unknown provider rather than failing", () => {
    process.env.PDF_RENDER_PROVIDER = "wingdings";
    expect(pdfConfig()?.provider).toBe("browserless");
  });
});

describe("renderPdf", () => {
  it("returns the bytes on success", async () => {
    stubFetch(async () => pdfResponse());
    const out = await renderPdf("https://app.example.com/render/tok");
    expect(new TextDecoder().decode(out.slice(0, 5))).toBe("%PDF-");
  });

  it("🔴 refuses to render a localhost URL", async () => {
    /*
     * A hosted browser cannot see localhost. Detected up front, because the
     * alternative is a thirty-second hang followed by a generic failure — the
     * single most misleading way this could break.
     */
    const spy = stubFetch(async () => pdfResponse());
    await expect(renderPdf("http://localhost:3000/render/tok")).rejects.toThrow(
      /cannot reach localhost/i,
    );
    await expect(renderPdf("http://127.0.0.1:3000/render/tok")).rejects.toThrow(
      /cannot reach localhost/i,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("marks a localhost refusal as the operator's to fix", async () => {
    stubFetch(async () => pdfResponse());
    await renderPdf("http://localhost:3000/x").catch((e: PdfRenderError) => {
      expect(e.configurable).toBe(true);
    });
    expect.assertions(1);
  });

  it("throws when unconfigured rather than calling anything", async () => {
    delete process.env.PDF_RENDER_KEY;
    const spy = stubFetch(async () => pdfResponse());
    await expect(renderPdf("https://app.example.com/x")).rejects.toThrow(
      /not configured/i,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("🔴 rejects a 200 response that is not a PDF", async () => {
    /*
     * Some providers answer a failure with 200 and a JSON error body. Served as
     * `application/pdf` that produces a file which downloads, does not open,
     * and gives the operator nothing to go on — strictly worse than an error.
     */
    stubFetch(async () => pdfResponse('{"error":"out of credits"}'));
    await expect(renderPdf("https://app.example.com/x")).rejects.toThrow(
      /not a PDF/i,
    );
  });

  it("names a rejected key as configurable, and a server fault as not", async () => {
    stubFetch(async () => ({
      ok: false,
      status: 401,
      text: async () => "bad token",
    }) as unknown as Response);
    await renderPdf("https://app.example.com/x").catch((e: PdfRenderError) => {
      expect(e.configurable).toBe(true);
      expect(e.status).toBe(401);
    });

    stubFetch(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
    }) as unknown as Response);
    await renderPdf("https://app.example.com/x").catch((e: PdfRenderError) => {
      expect(e.configurable).toBe(false);
    });
    expect.assertions(3);
  });

  it("truncates a provider's error body rather than forwarding all of it", async () => {
    stubFetch(async () => ({
      ok: false,
      status: 500,
      text: async () => "x".repeat(5000),
    }) as unknown as Response);
    await renderPdf("https://app.example.com/x").catch((e: PdfRenderError) => {
      expect(e.message.length).toBeLessThan(400);
    });
    expect.assertions(1);
  });
});

describe("provider requests", () => {
  it("browserless: key in the query string, zero margins", async () => {
    const spy = stubFetch(async () => pdfResponse());
    await renderPdf("https://app.example.com/render/tok");

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("token=test-key");
    const body = JSON.parse(String(init.body));
    expect(body.url).toBe("https://app.example.com/render/tok");
    /*
     * 🔴 The margins are the point of this whole feature. A margin here is
     * exactly the strip Chrome stamps the source URL into when printing.
     */
    expect(body.options.margin).toEqual({
      top: "0",
      bottom: "0",
      left: "0",
      right: "0",
    });
    expect(body.options.printBackground).toBe(true);
  });

  it("browserless waits for the network to settle, so the charts exist", async () => {
    // Recharts draws after hydration. A screenshot at DOMContentLoaded catches
    // an empty SVG — the same failure the client-side print spike found.
    const spy = stubFetch(async () => pdfResponse());
    await renderPdf("https://app.example.com/x");
    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.gotoOptions.waitUntil).toBe("networkidle0");
  });

  it("pdfshift: Basic auth, and a delay for the same reason", async () => {
    process.env.PDF_RENDER_PROVIDER = "pdfshift";
    const spy = stubFetch(async () => pdfResponse());
    await renderPdf("https://app.example.com/render/tok");

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("pdfshift.io");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
      "api:test-key",
    );
    const body = JSON.parse(String(init.body));
    expect(body.source).toBe("https://app.example.com/render/tok");
    expect(body.delay).toBeGreaterThan(0);
  });

  it("honours a URL override for a self-hosted instance", async () => {
    process.env.PDF_RENDER_URL = "https://chrome.internal/pdf";
    const spy = stubFetch(async () => pdfResponse());
    await renderPdf("https://app.example.com/x");
    expect((spy.mock.calls[0] as [string, RequestInit])[0]).toContain(
      "chrome.internal",
    );
  });

  it("passes the abort signal through", async () => {
    const spy = stubFetch(async () => pdfResponse());
    const controller = new AbortController();
    await renderPdf("https://app.example.com/x", { signal: controller.signal });
    expect((spy.mock.calls[0] as [string, RequestInit])[1].signal).toBe(
      controller.signal,
    );
  });
});
