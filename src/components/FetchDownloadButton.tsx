"use client";

import { useState } from "react";

/**
 * Download a file the server has to BUILD before it can answer.
 *
 * ── Why this is not a plain `<a download>` ────────────────────────────
 *
 * CSV and XLSX are produced in milliseconds from data already in memory, so a
 * link is exactly right for them — the browser downloads natively and no
 * JavaScript is involved.
 *
 * A PDF is different in two ways that a link handles badly:
 *
 *   · It takes SECONDS. A hosted browser has to fetch the page, wait for it to
 *     settle and return bytes. A link gives no feedback at all for that whole
 *     time, so the operator clicks again, and again — each click a paid render.
 *   · It can FAIL, and failure arrives as a JSON body. Followed as a link, that
 *     opens a blank tab containing `{"error":"…"}`, which reads as the product
 *     breaking rather than as a message.
 *
 * So the response is fetched, errors are surfaced in place, and only a genuine
 * success turns into a download. This is the same reasoning `DownloadPdfButton`
 * was built on, generalised so both callers share it rather than growing a
 * second copy that drifts.
 */
export function FetchDownloadButton({
  url,
  label,
  pendingLabel = "…",
  title,
  className,
  style,
}: {
  url: string;
  label: string;
  pendingLabel?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `Failed (${res.status})`);
        return;
      }

      /*
       * The filename comes from the server's Content-Disposition, which is the
       * only party that knows the range the rows actually cover — `monthly`
       * ignores the picker entirely, so a name built here would be wrong for it.
       */
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);

      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = match?.[1] ?? "export";
      document.body.appendChild(a);
      a.click();
      a.remove();
      /*
       * Revoked late rather than immediately: Safari has raced a synchronous
       * revoke and cancelled the download it had only just started.
       */
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title={title}
        className={className}
        style={style}
      >
        {busy ? pendingLabel : label}
      </button>
      {error && (
        /*
         * Shown next to the control that caused it. A toast would be dismissed
         * before it was read, and this text is usually the name of an env var
         * the operator has to go and set.
         *
         * `basis-full` forces it onto its own line inside the wrapping flex row
         * it lives in, and `break-words` keeps a long identifier like
         * `PDF_RENDER_KEY` from pushing the container wider than the menu.
         */
        <span
          className="mt-1 basis-full text-[10.5px] leading-snug break-words"
          style={{ color: "var(--danger, #b3261e)" }}
        >
          {error}
        </span>
      )}
    </>
  );
}
