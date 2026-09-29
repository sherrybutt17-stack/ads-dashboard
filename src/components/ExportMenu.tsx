import { DATASETS } from "@/lib/export/datasets";
import { EXPORT_FORMATS, type ExportFormat } from "@/lib/export/formats";
import { FetchDownloadButton } from "@/components/FetchDownloadButton";
import type { AdPlatform } from "@/lib/metrics/queries";

/**
 * Formats offered in the menu.
 *
 * All three. PDF only answers on a deployment with `PDF_RENDER_KEY` set and a
 * public `NEXT_PUBLIC_APP_URL` — locally it returns 501 with that sentence,
 * which `FetchDownloadButton` renders in place rather than opening a blank tab
 * full of JSON.
 */
const OFFERED: readonly ExportFormat[] = ["csv", "xlsx", "pdf"];

/**
 * Download the numbers.
 *
 * ── Why this is a `<details>` and not a client component ──────────────
 *
 * Every item is a plain link to a GET route that answers with
 * `Content-Disposition: attachment`, so the browser does the download natively.
 * There is no state to hold, nothing to fetch, and no response to render — so a
 * `"use client"` boundary here would ship JavaScript to reimplement a disclosure
 * widget the platform already provides, along with the focus handling, the
 * Escape key and the ARIA wiring that get forgotten when it is reimplemented.
 *
 * ── The date range travels in the URL, deliberately ───────────────────
 *
 * The links carry the range the operator is looking at, so what downloads is
 * what is on screen. The month-on-month file is the exception and says so on
 * its own line rather than in a footnote: those rows are a fixed trailing 12
 * months and do not move with the picker, which is the same thing the report
 * table's "Fixed trailing windows" label exists to say.
 */
export function ExportMenu({
  slug,
  start,
  end,
  platform,
  staff,
}: {
  slug: string;
  start: string;
  end: string;
  platform: AdPlatform;
  /**
   * Agency staff see every dataset; a client-role viewer does not see the ones
   * carrying lead names. This hides them — the route REFUSES them, which is the
   * check that actually holds. Filtering here only means a client never clicks
   * something that answers 403.
   */
  staff: boolean;
}) {
  const datasets = DATASETS.filter((d) => staff || !d.personal);
  const href = (dataset: string, format: ExportFormat) =>
    `/api/c/${encodeURIComponent(slug)}/export?dataset=${dataset}` +
    `&format=${format}&platform=${platform}&start=${start}&end=${end}`;

  return (
    <details className="relative">
      <summary
        className="cursor-pointer list-none rounded-[9px] border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)] [&::-webkit-details-marker]:hidden"
        style={{
          borderColor: "var(--border-strong)",
          color: "var(--text-secondary)",
        }}
      >
        Export
      </summary>
      <div
        className="absolute right-0 z-20 mt-1.5 w-72 rounded-[10px] border p-1.5"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--surface-1)",
          boxShadow: "var(--shadow-overlay)",
        }}
      >
        {datasets.map((d) => (
          <div
            key={d.id}
            className="rounded-[7px] px-2.5 py-2 transition-colors hover:bg-[var(--surface-2)]"
          >
            <span
              className="block text-[13px] font-medium"
              style={{ color: "var(--text-primary)" }}
            >
              {d.label}
              {d.personal && (
                /*
                 * Named where the click happens, not in a policy page. A file
                 * of people's names leaves the product the moment this is
                 * clicked, and the one moment that fact is useful is now.
                 */
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
            {/*
             * The format choice sits under the dataset rather than beside it:
             * the dataset is what the operator is choosing, and the format is
             * how they want it. A grid of label×format at the top level would
             * make those look like eight peer options instead of four.
             */}
            {/*
              `flex-wrap` and `min-w-0`: an error message renders inside this
              row, and without both it pushed the buttons out through the side
              of a 288px menu instead of wrapping under them.
            */}
            <span className="mt-1.5 flex min-w-0 flex-wrap items-start gap-1.5">
              {EXPORT_FORMATS.filter((f) => OFFERED.includes(f.id)).map((f) =>
                /*
                 * The metered formats go through a fetch so a slow render shows
                 * progress and a failure shows its message; the instant ones
                 * stay plain links, which is why this component can remain a
                 * server component with one small client island inside it.
                 */
                f.metered ? (
                  <FetchDownloadButton
                    key={f.id}
                    url={href(d.id, f.id)}
                    label={f.label}
                    pendingLabel="Rendering…"
                    title={f.description}
                    className="rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-[var(--surface-raised)] disabled:opacity-60"
                    style={{
                      borderColor: "var(--border)",
                      color: "var(--text-secondary)",
                    }}
                  />
                ) : (
                  <a
                    key={f.id}
                    href={href(d.id, f.id)}
                    /*
                     * `download` is a hint only — the route's
                     * Content-Disposition is what actually decides, and it has
                     * to, because a client can reach this URL directly. Kept
                     * because it makes the intent legible in the markup.
                     */
                    download
                    title={f.description}
                    className="rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-[var(--surface-raised)]"
                    style={{
                      borderColor: "var(--border)",
                      color: "var(--text-secondary)",
                    }}
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
        </p>
      </div>
    </details>
  );
}
