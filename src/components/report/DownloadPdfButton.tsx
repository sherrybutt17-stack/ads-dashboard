"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import type { AdPlatform } from "@/lib/metrics/queries";

/**
 * Download a server-rendered PDF.
 *
 * Sits beside the print button rather than replacing it, and the ordering is
 * the recommendation: this one produces a file with nothing in the margin,
 * print produces one with the source URL stamped across every page unless the
 * reader happens to have unticked a checkbox. Both stay because the render
 * service can be down, out of credits, or simply not configured, and a report
 * you cannot get out of the screen at all is worse than one with a footer.
 *
 * ── Why this is a fetch and not a link ────────────────────────────────
 *
 * A plain `<a download>` would be less code and would fail invisibly: a render
 * takes several seconds with no feedback, and a failure arrives as a JSON error
 * body rendered into a blank tab. Holding the request means the wait can be
 * shown and the reason can be shown.
 */
export function DownloadPdfButton({
  slug,
  start,
  end,
  platform,
}: {
  slug: string;
  start: string;
  end: string;
  platform: AdPlatform;
}) {
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");
  const [problem, setProblem] = useState<string | null>(null);

  async function download() {
    setState("working");
    setProblem(null);
    try {
      const res = await fetch(
        `/api/c/${encodeURIComponent(slug)}/report-pdf?platform=${platform}&start=${start}&end=${end}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setProblem(body?.error ?? `Render failed (${res.status}).`);
        setState("failed");
        return;
      }

      /*
       * Blob → object URL → synthetic click. The response cannot be navigated
       * to directly because it was fetched with the session cookie and is
       * `no-store`; re-requesting it as a navigation would render the report a
       * second time and bill for it twice.
       */
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "report.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Freed on the next tick — revoking synchronously races the download in
      // Safari, which has not started reading the blob when click() returns.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState("idle");
    } catch {
      setProblem("Could not reach the server.");
      setState("failed");
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={download}
        disabled={state === "working"}
        aria-busy={state === "working"}
        className="inline-flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-[12px] font-medium transition-colors hover:opacity-80 disabled:opacity-60"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--surface-1)",
          color: "var(--text-secondary)",
        }}
      >
        <Icon name="download" size={12} />
        {state === "working" ? "Rendering…" : "Download PDF"}
      </button>
      {problem && (
        <span
          role="alert"
          className="text-[11.5px]"
          style={{ color: "var(--status-critical)" }}
        >
          {problem}
        </span>
      )}
    </span>
  );
}
