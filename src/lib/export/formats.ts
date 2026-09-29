/**
 * The file formats a dataset can be served as.
 *
 * ── One dataset, three renderings, one source of numbers ──────────────
 *
 * Format and dataset are deliberately orthogonal. `datasets.ts` decides WHICH
 * rows a file contains and answers with a `CsvTable`; this file decides what
 * that table is serialised INTO. Neither knows about the other, so a new
 * dataset gains three formats for free and a new format gains every dataset.
 *
 * The alternative — a `daily-csv`, `daily-xlsx`, `daily-pdf` enumeration — is
 * the same matrix written out longhand, and it drifts the first time someone
 * adds a dataset and forgets one of the three.
 *
 * ── Why the extension lives here rather than being derived ────────────
 *
 * `exportFilename` takes the extension as a parameter because a filename is a
 * string in a `Content-Disposition` header and the mapping from format to
 * suffix is a fact about the format, not about the filename builder.
 */

export type ExportFormat = "csv" | "xlsx" | "pdf";

export const EXPORT_FORMATS: ReadonlyArray<{
  id: ExportFormat;
  label: string;
  ext: string;
  mime: string;
  /** Shown beside the link. One line, and it must say what the reader gains. */
  description: string;
  /**
   * True when producing the file costs money at a third party and takes
   * seconds rather than milliseconds — see the second rate limit in the route.
   */
  metered?: boolean;
}> = [
  {
    id: "csv",
    label: "CSV",
    ext: "csv",
    mime: "text/csv; charset=utf-8",
    description: "Opens anywhere. Comma-separated, UTF-8.",
  },
  {
    id: "xlsx",
    label: "Excel",
    ext: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    description: "Real Excel types, so totals and averages work on open.",
  },
  {
    id: "pdf",
    label: "PDF",
    ext: "pdf",
    mime: "application/pdf",
    description: "Branded and printable. For reading, not reconciling.",
    metered: true,
  },
];

const FORMAT_IDS = EXPORT_FORMATS.map((f) => f.id);

export function isExportFormat(v: string): v is ExportFormat {
  return (FORMAT_IDS as readonly string[]).includes(v);
}

export function formatMeta(id: ExportFormat) {
  /*
   * Non-null asserted rather than guarded: `id` is an `ExportFormat`, every
   * member of that union has a row above, and a missing one is a programming
   * error that should surface in the tests rather than degrade into a
   * plausible-looking `text/plain` download.
   */
  return EXPORT_FORMATS.find((f) => f.id === id)!;
}
