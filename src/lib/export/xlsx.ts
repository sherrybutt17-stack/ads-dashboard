import writeXlsxFile from "write-excel-file/node";
import type { Cell, CsvTable } from "./csv";

/**
 * XLSX serialisation.
 *
 * ── 🔴 The entire point: a number arrives as a NUMBER ─────────────────
 *
 * CSV has no types. Every value in the file is a string, and what a spreadsheet
 * does with it is a guess made at import time by whichever program opened it —
 * which is why a campaign id has to be defended as text (`datasets.ts`) and why
 * a locale that reads `1,234.50` as two cells is a real failure mode.
 *
 * XLSX carries the type in the file. `{kind:"number"}` becomes a genuine
 * numeric cell with a display format attached, so the client opens the file,
 * selects the spend column, and the status bar shows a total that agrees with
 * the dashboard. That agreement is the whole reason this format is here; it is
 * not a nicer CSV.
 *
 * The `Cell` union from `csv.ts` is reused rather than re-derived precisely so
 * that the two serialisers cannot disagree about what a value IS. The dataset
 * builders already made that judgement once.
 *
 * ── 🔴 No formula defusing here, and adding it would be a bug ─────────
 *
 * `csv.ts` prefixes dangerous text with an apostrophe because a CSV importer
 * evaluates a leading `=`. That reasoning does NOT carry over. In OOXML a cell
 * is a formula only when it carries an `<f>` child element; a value written as
 * an inline or shared string is never evaluated, whatever it starts with. This
 * module never emits `type: 'Formula'`, so a campaign called `=HYPERLINK(...)`
 * lands as those literal characters.
 *
 * Carrying the apostrophe across would actively damage the file: in CSV the
 * prefix is consumed by the importer and disappears, in XLSX it is simply part
 * of the stored string and the client sees `'=HYPERLINK(...)` on screen.
 *
 * The invariant worth testing is therefore "the generated sheet XML contains no
 * `<f>` element", not "dangerous text was rewritten".
 *
 * ── Why the whole workbook is built in memory ─────────────────────────
 *
 * `toBuffer()` rather than `toStream()`/`toFile()`. The largest dataset is
 * `leads`, capped at 2000 rows by the query itself, which is a few hundred
 * kilobytes zipped — far inside the serverless response limit. Streaming would
 * buy nothing and `toFile` would need a writable directory, which is one more
 * thing to fail on a read-only filesystem.
 */

/** A named tab. Several of these become a workbook with several sheets. */
export interface Sheet {
  name: string;
  table: CsvTable;
}

/**
 * A sheet name Excel will actually open.
 *
 * Excel refuses the whole FILE — not the sheet, the file — when a tab name
 * carries `[ ] : * ? / \` or runs past 31 characters, and it does so with a
 * repair dialog that names nothing useful. That is the worst failure this
 * feature has available to it: the download succeeds, the bytes are fine, and
 * the client sees corruption. So the name is sanitised here rather than trusted
 * from a dataset label.
 */
export function sheetName(raw: string): string {
  const cleaned = raw
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned || "Sheet";
}

/**
 * IEEE-754 representation noise, removed — and nothing else.
 *
 * 🔴 `percent()` multiplies a stored ratio by 100, so `0.285` becomes
 * `28.499999999999996`. CSV never showed this because `renderCell` runs
 * `toFixed(digits)` on the way out, which both formats and rounds in one step.
 * XLSX deliberately does NOT round — the display format handles presentation
 * and the full value stays in the cell — so the noise would survive into the
 * file, and a client who widens the decimals would see fifteen digits of it and
 * reasonably conclude the export is broken.
 *
 * `toPrecision(15)` is the standard fix: a double carries about 15-17
 * significant decimal digits, so trimming to 15 discards the representation
 * artifact while keeping every digit that was ever meaningful. `10.126` stays
 * `10.126`; `28.499999999999996` becomes `28.5`.
 *
 * This is NOT rounding to the display precision. Doing that would throw away
 * real precision — a spend of `1234.5678` must stay `1234.5678` in the cell
 * even though the column shows `1234.57`.
 */
function cleanFloat(value: number): number {
  return Number(value.toPrecision(15));
}

/**
 * One cell, in the shape `write-excel-file` wants.
 *
 * 🔴 `null` produces an EMPTY cell — no value, no type — for exactly the reason
 * `renderCell` in `csv.ts` spells out at length. Zero is a claim we do not
 * have. Here the stakes are slightly higher than in CSV: a `0` written into a
 * typed numeric column is indistinguishable from a measured zero and will be
 * averaged as one.
 */
function toXlsxCell(cell: Cell) {
  if (cell.kind === "number") {
    if (cell.value === null || !Number.isFinite(cell.value)) return {};
    const digits = cell.digits ?? 0;
    return {
      value: cleanFloat(cell.value),
      type: Number,
      /*
       * A display format, not a rounding. The stored value keeps its full
       * precision — the client can widen the column or change the format and
       * see it — which is the behaviour a spreadsheet user expects and the
       * opposite of CSV, where `toFixed` discards the remainder permanently.
       */
      format: digits === 0 ? "#,##0" : `#,##0.${"0".repeat(digits)}`,
    };
  }
  if (cell.value === null || cell.value === "") return {};
  return { value: cell.value, type: String };
}

/**
 * Column widths, from the header text.
 *
 * Crude on purpose. Measuring the widest cell in a 2000-row column to fit it
 * exactly costs a full pass for a result nobody checks, and a column that is
 * slightly too wide reads fine while one that is too narrow shows `####` and
 * looks broken.
 */
function columnWidths(headers: readonly string[]) {
  return headers.map((h) => ({ width: Math.min(Math.max(h.length + 4, 12), 40) }));
}

export async function buildXlsx(sheets: readonly Sheet[]): Promise<Uint8Array> {
  if (sheets.length === 0) {
    throw new Error("buildXlsx: at least one sheet is required");
  }

  const workbook = sheets.map(({ name, table }) => {
    const width = table.headers.length;
    const header = table.headers.map((h) => ({
      value: h,
      type: String,
      fontWeight: "bold" as const,
    }));

    const body = table.rows.map((row) => {
      const cells = row.map(toXlsxCell);
      /*
       * Padded, never truncated — the same rule `buildCsv` follows, and for the
       * same reason: a ragged row is a bug in the caller and silently dropping
       * the overflow would hide it.
       */
      while (cells.length < width) cells.push({});
      return cells;
    });

    return {
      sheet: sheetName(name),
      /*
       * The header row stays visible while the client scrolls 2000 leads. This
       * is the one piece of presentation XLSX gets that CSV cannot, and it is
       * the difference between a file someone reads and one they re-sort in
       * frustration.
       */
      stickyRowsCount: 1,
      columns: columnWidths(table.headers),
      data: [header, ...body],
    };
  });

  const buf = await writeXlsxFile(workbook).toBuffer();
  return new Uint8Array(buf);
}
