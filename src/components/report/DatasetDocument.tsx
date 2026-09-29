import type { CSSProperties } from "react";
import { getClientLogoDataUri } from "@/lib/branding-store";
import type { ClientBranding } from "@/lib/branding";
import { accentFor } from "@/lib/branding";
import type { Client } from "@/db/schema";
import { rangeLabel } from "@/lib/dates";
import type { Cell, CsvTable } from "@/lib/export/csv";

/**
 * One exported dataset, laid out for print.
 *
 * ── What this is, next to `ReportDocument` ────────────────────────────
 *
 * `ReportDocument` is the narrative: KPIs, a funnel, charts, written
 * commentary, laid out for portrait at `REPORT_WIDTH`. This is the raw table
 * behind one dataset — the same rows the CSV and the XLSX carry, rendered so
 * they can be read and forwarded rather than reconciled.
 *
 * 🔴 **It is deliberately NOT the format for reconciling.** Twenty-odd columns
 * on a landscape page is small type, and a reader who needs to check a figure
 * against their own books wants the spreadsheet. The footnote says so, because
 * a PDF that looks authoritative and is hard to read is worse than one that
 * admits what it is for.
 *
 * ── Why the header is duplicated rather than imported ─────────────────
 *
 * `ReportDocument`'s header is embedded in a 424-line component that three
 * routes render. Extracting it is the right refactor and is not this change:
 * the shared component is on the live client-facing path and the share-link
 * path, and a layout regression there costs more than the duplication here.
 * The pieces that actually matter — the logo as a data URI, the brand name
 * resolution, `rangeLabel` — are imported, so the two cannot disagree about
 * anything a reader would notice.
 *
 * ── The logo is inlined, not linked ───────────────────────────────────
 *
 * Same reason as the report: the renderer fetches this page with no session, so
 * an `<img src="/api/…/logo">` would 401 and render as a broken image in the
 * client's PDF.
 */

const PAGE_WIDTH = 1040;

/**
 * A cell as display text.
 *
 * 🔴 NOT `renderCell`. That function produces CSV: it doubles interior quotes
 * and prefixes an apostrophe to text starting with `= + - @` so a spreadsheet
 * will not execute it. Both are correct in a .csv and wrong on a page — a
 * campaign called `-Summer` printed as `'-Summer`. React already escapes for
 * HTML, so text goes through untouched.
 *
 * What IS shared with the CSV is the rule that matters: null is an empty cell,
 * never `0` and never a dash.
 */
function displayCell(cell: Cell | undefined): string {
  if (!cell || cell.value === null) return "";
  if (cell.kind === "text") return cell.value;
  if (!Number.isFinite(cell.value)) return "";
  const digits = cell.digits ?? 0;
  // Separators for reading; the spreadsheet exports stay separator-free.
  return cell.value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** `YYYY-MM-DD` — must never wrap at its hyphens into three lines. */
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export async function DatasetDocument({
  client,
  branding,
  table,
  datasetLabel,
  datasetDescription,
  rangeStart,
  rangeEnd,
  truncatedAt,
}: {
  client: Client;
  branding: ClientBranding;
  table: CsvTable;
  datasetLabel: string;
  datasetDescription: string;
  rangeStart: string;
  rangeEnd: string;
  /** The row cap, when the source query hit one. Printed as a footnote. */
  truncatedAt: number | null;
}) {
  const logoDataUri = branding.hasLogo
    ? await getClientLogoDataUri(client.id)
    : null;
  const brandName = branding.displayName ?? client.name;

  /*
   * The same accent resolution the report uses — a branded client's dataset
   * PDF should not arrive in a different colour from their report.
   */
  const accent = accentFor(client.id, branding);
  const accentVars = {
    "--accent": accent.color,
  } as CSSProperties;

  return (
    <div style={accentVars}>
      <main
        className="mx-auto flex flex-col gap-5 px-6 py-8"
        style={{ maxWidth: PAGE_WIDTH }}
      >
        <header className="avoid-break flex items-start gap-4">
          {logoDataUri ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={logoDataUri}
              alt={brandName}
              className="h-12 w-auto max-w-[200px] shrink-0 object-contain"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[13px] text-[19px] font-bold text-white"
              style={{
                background:
                  "linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 50%, #0d1b30) 100%)",
              }}
            >
              {brandName.trim().charAt(0).toUpperCase() || "•"}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1
              className="truncate text-[22px] leading-tight font-semibold"
              style={{ color: "var(--text-primary)", letterSpacing: "-0.015em" }}
            >
              {brandName}
            </h1>
            <p
              className="mt-0.5 text-[13px]"
              style={{ color: "var(--text-secondary)" }}
            >
              {datasetLabel} ·{" "}
              <span className="tnum">{rangeLabel(rangeStart, rangeEnd)}</span>
            </p>
            <p
              className="mt-0.5 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {datasetDescription} All figures in{" "}
              {client.timezone.replace(/_/g, " ")}.
            </p>
          </div>
        </header>

        {/*
          🔴 Sized to the column count. Month-on-month is 21 columns, and at
          10.5px with 8px cell padding its natural width exceeded the landscape
          page — the renderer clipped it and the right-most column (CPC) was
          simply missing from the PDF. Wide tables drop to 8.5px and tighter
          padding, and headers may wrap, so every column lands on the page.
        */}
        <table
          className={
            table.headers.length > 14
              ? "w-full border-collapse text-[8.5px] [&_td]:px-1 [&_th]:px-1"
              : "w-full border-collapse text-[10.5px]"
          }
          style={{ color: "var(--text-primary)" }}
        >
          <thead>
            <tr>
              {table.headers.map((h) => (
                <th
                  key={h}
                  /*
                   * Headers align with their column: a right-aligned numeric
                   * column under a left-aligned label reads as two columns.
                   * Decided per column from the FIRST row's cell kind, which is
                   * the same thing every row carries — the builders emit one
                   * shape per column by construction.
                   */
                  className={
                    table.rows[0]?.[table.headers.indexOf(h)]?.kind === "number"
                      ? "border-b px-2 py-1.5 text-right align-bottom font-semibold"
                      : "border-b px-2 py-1.5 text-left align-bottom font-semibold"
                  }
                  style={{ borderColor: "var(--border-strong)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr
                key={i}
                className="avoid-break"
                style={{
                  background: i % 2 ? "var(--surface-2)" : "transparent",
                }}
              >
                {table.headers.map((_, c) => {
                  const cell = row[c];
                  const numeric = cell?.kind === "number";
                  const text = displayCell(cell);
                  return (
                    <td
                      key={c}
                      className={
                        numeric
                          ? "tnum border-b px-2 py-1 text-right whitespace-nowrap"
                          : DATE_KEY.test(text)
                            ? "tnum border-b px-2 py-1 text-left whitespace-nowrap"
                            : "border-b px-2 py-1 text-left"
                      }
                      style={{ borderColor: "var(--border)" }}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <footer
          className="text-[10px] leading-snug"
          style={{ color: "var(--text-muted)" }}
        >
          <p>
            {table.rows.length}{" "}
            {table.rows.length === 1 ? "row" : "rows"}. Undefined values are left
            blank rather than written as zero. For checking figures against your
            own records, use the Excel export of this dataset, which carries
            full precision.
          </p>
          {truncatedAt !== null && (
            /*
             * The one thing this page must not do quietly. A reader comparing
             * a busy month against their CRM would otherwise find a shortfall
             * with nothing anywhere to explain it.
             */
            <p className="mt-1" style={{ color: "var(--text-secondary)" }}>
              This list may stop at {truncatedAt} rows — every export of it
              does. The full list is in the CRM.
            </p>
          )}
        </footer>
      </main>
    </div>
  );
}
