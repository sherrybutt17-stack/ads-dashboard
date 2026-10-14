"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EXPORT_FORMATS, type ExportFormat } from "@/lib/export/formats";
import { FetchDownloadButton } from "@/components/FetchDownloadButton";
import { useDismissOnEscape } from "@/components/Modal";
import {
  PeriodFilter,
  periodProblem,
  type PeriodSelection,
} from "@/components/PeriodFilter";
import type { AdPlatform } from "@/lib/platforms";

export interface ExportDataset {
  id: string;
  label: string;
  description: string;
  personal?: boolean;
}

const LINK_CLASS =
  "rounded-[var(--radius-xs)] border px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-[var(--surface-raised)] disabled:opacity-60";
const LINK_STYLE = {
  borderColor: "var(--border)",
  color: "var(--text-secondary)",
} as const;

/**
 * The Export popover: choose a period and platform, then a dataset and format.
 *
 * ── Why this became a client component ────────────────────────────────
 *
 * It was a `<details>`, which needed no JavaScript — and could not be closed
 * by clicking anywhere else, which is what every other menu on the page does.
 * Operators had to find the Export button again to put it away. It also had no
 * state, so it could only ever write the range the dashboard happened to show.
 *
 * Still a plain popover rather than a portal: it is `absolute`, not `fixed`,
 * so the header's backdrop filter does not trap it (see
 * `overlay-containment.test.ts`).
 */
export function ExportPanel({
  slug,
  screen,
  today,
  platforms,
  datasets,
  pdfEnabled,
}: {
  slug: string;
  screen: PeriodSelection;
  today: string;
  platforms: readonly AdPlatform[];
  datasets: readonly ExportDataset[];
  pdfEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<PeriodSelection>(screen);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismissOnEscape(open, close, trigger);

  // A press anywhere outside the button and the panel puts it away.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (root.current && !root.current.contains(e.target as Node)) close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  const problem = periodProblem(sel, today);
  const formats = EXPORT_FORMATS.filter((f) => f.id !== "pdf" || pdfEnabled);
  const href = (dataset: string, format: ExportFormat) =>
    `/api/c/${encodeURIComponent(slug)}/export?dataset=${dataset}` +
    `&format=${format}&platform=${sel.platform}&start=${sel.start}&end=${sel.end}`;
  const reportHref =
    `/c/${encodeURIComponent(slug)}/report?start=${sel.start}&end=${sel.end}` +
    (sel.platform !== "meta" ? `&platform=${sel.platform}` : "");

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          // Every opening starts from what is on screen, so a period picked
          // last time cannot quietly carry into the next download.
          if (!open) setSel(screen);
          setOpen((o) => !o);
        }}
        className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)]"
        style={{
          borderColor: "var(--border-strong)",
          color: "var(--text-secondary)",
        }}
      >
        Export
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Export"
          className="absolute right-0 z-20 mt-1.5 max-h-[calc(100vh-7rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-[var(--radius)] border p-1.5"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            boxShadow: "var(--shadow-overlay)",
          }}
        >
          <div
            className="mb-1 border-b px-2.5 pt-2 pb-3"
            style={{ borderColor: "var(--border)" }}
          >
            <PeriodFilter
              value={sel}
              onChange={setSel}
              screen={screen}
              today={today}
              platforms={platforms}
            />
          </div>

          {datasets.map((d) => (
            <div
              key={d.id}
              className="rounded-[var(--radius-xs)] px-2.5 py-2 transition-colors hover:bg-[var(--surface-2)]"
            >
              <span
                className="block text-[13px] font-medium"
                style={{ color: "var(--text-primary)" }}
              >
                {d.label}
                {d.personal && (
                  // Named where the click happens: a file of people's names
                  // leaves the product the moment this is clicked.
                  <span
                    className="ml-1.5 text-[11px] font-normal"
                    style={{ color: "var(--text-muted)" }}
                  >
                    · names
                  </span>
                )}
              </span>
              <span
                className="mt-0.5 block text-[11.5px] leading-snug"
                style={{ color: "var(--text-muted)" }}
              >
                {d.description}
              </span>
              <span className="mt-1.5 flex min-w-0 flex-wrap items-start gap-1.5">
                {formats.map((f) =>
                  problem ? (
                    <button
                      key={f.id}
                      type="button"
                      disabled
                      title={problem}
                      className={LINK_CLASS}
                      style={LINK_STYLE}
                    >
                      {f.label}
                    </button>
                  ) : f.metered ? (
                    <FetchDownloadButton
                      key={f.id}
                      url={href(d.id, f.id)}
                      label={f.label}
                      pendingLabel="Rendering…"
                      title={f.description}
                      className={LINK_CLASS}
                      style={LINK_STYLE}
                    />
                  ) : (
                    <a
                      key={f.id}
                      href={href(d.id, f.id)}
                      download
                      title={f.description}
                      className={LINK_CLASS}
                      style={LINK_STYLE}
                    >
                      {f.label}
                    </a>
                  ),
                )}
              </span>
            </div>
          ))}

          <p
            className="mt-1 px-2.5 py-1.5 text-[11px] leading-snug"
            style={{ color: "var(--text-muted)" }}
          >
            Undefined values are left blank rather than written as zero. Excel
            files carry real number types, so totals work on open.
            {!pdfEnabled && (
              <>
                {" "}
                For a PDF, open the{" "}
                <a
                  href={reportHref}
                  className="underline underline-offset-2"
                  style={{ color: "var(--text-secondary)" }}
                >
                  report
                </a>{" "}
                and choose Print, then Save as PDF.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
