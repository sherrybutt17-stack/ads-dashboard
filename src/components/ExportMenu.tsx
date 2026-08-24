import { DATASETS } from "@/lib/export/datasets";
import type { AdPlatform } from "@/lib/metrics/queries";

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
}: {
  slug: string;
  start: string;
  end: string;
  platform: AdPlatform;
}) {
  const href = (dataset: string) =>
    `/api/c/${encodeURIComponent(slug)}/export?dataset=${dataset}` +
    `&platform=${platform}&start=${start}&end=${end}`;

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
        {DATASETS.map((d) => (
          <a
            key={d.id}
            href={href(d.id)}
            /*
             * `download` is a hint only — the route's Content-Disposition is
             * what actually decides, and it has to, because a client can reach
             * this URL directly. Kept because it makes the intent legible in
             * the markup.
             */
            download
            className="block rounded-[7px] px-2.5 py-2 transition-colors hover:bg-[var(--surface-2)]"
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
          </a>
        ))}
        <p
          className="mt-1 px-2.5 py-1.5 text-[11px] leading-snug"
          style={{ color: "var(--text-muted)" }}
        >
          Comma-separated, UTF-8. Undefined values are left blank rather than
          written as zero.
        </p>
      </div>
    </details>
  );
}
