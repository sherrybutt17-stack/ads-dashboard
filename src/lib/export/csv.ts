/**
 * CSV serialisation.
 *
 * ── 🔴 Why cells carry a KIND rather than being stringified uniformly ──
 *
 * Two requirements pull in opposite directions and only a type split satisfies
 * both.
 *
 * **Text cells must be defused.** A cell whose first character is `=`, `+`, `-`,
 * `@`, tab or carriage return is evaluated as a FORMULA by Excel and Sheets when
 * the file is opened. The values in this export are not ours — campaign names
 * and lead names come from GHL and from whoever typed them into Meta Ads
 * Manager — so a campaign called `=HYPERLINK(...)` is a live injection into a
 * spreadsheet the client opens on their own machine. This is CSV injection, and
 * it is the only genuinely dangerous thing about exporting data.
 *
 * **Numeric cells must NOT be defused.** Every negative number starts with `-`.
 * Run the same guard over `-12.40` and it exports as text, every SUM over the
 * column silently drops it, and the client's own spreadsheet disagrees with the
 * dashboard — which is precisely the class of quiet wrongness this product
 * exists to replace.
 *
 * So the guard is applied to text and never to numbers, and the only way to get
 * that right is for the caller to have said which is which. Hence `Cell`.
 *
 * ── What the apostrophe costs, and why it is still the right trade ─────
 *
 * The defusing prefix is a single quote. In Sheets it is consumed as a
 * text marker and is invisible; in Excel opening a `.csv` it is displayed
 * literally, so a campaign genuinely named `-Summer Promo` reads `'-Summer
 * Promo` in one of the two. That is a visible blemish on a rare name, against a
 * formula executing on a client's laptop. It is not a close call.
 *
 * ── The two format details that look like trivia and are not ──────────
 *
 * · **A UTF-8 BOM leads the file.** Excel on Windows assumes the system code
 *   page for a `.csv` with no BOM, so `Nicolás` arrives as `NicolÃ¡s`. Every
 *   other consumer ignores a BOM. It costs three bytes.
 * · **Lines end CRLF**, per RFC 4180. Excel accepts LF; some older importers do
 *   not, and this is a file that gets opened by whatever the client happens to
 *   have.
 */

export type Cell =
  | { kind: "text"; value: string | null }
  | { kind: "number"; value: number | null; digits?: number };

export const text = (value: string | null | undefined): Cell => ({
  kind: "text",
  value: value ?? null,
});

export const num = (value: number | null | undefined, digits = 0): Cell => ({
  kind: "number",
  value: value ?? null,
  digits,
});

/** Money, at two decimal places and with no symbol — see `money` below. */
export const money = (value: number | null | undefined): Cell => num(value, 2);

/**
 * A ratio, rendered as the PERCENTAGE NUMBER.
 *
 * `bookPct` is stored as `0.285` and rendered on screen as `28.50%`. Exporting
 * the raw ratio under a header reading "Book %" would put `0.285` beside a
 * dashboard showing `28.50%` and invite exactly one conclusion: that the export
 * is broken. The header names the unit, so the cell carries that unit.
 */
export const percent = (value: number | null | undefined): Cell =>
  num(value === null || value === undefined ? null : value * 100, 2);

/** Characters that make a spreadsheet treat the rest of the cell as a formula. */
const DANGEROUS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * One text value, defused and quoted.
 *
 * Quoting alone does NOT defuse a formula — Excel happily evaluates `"=1+1"` —
 * so the prefix is load-bearing and the quotes are only about commas and
 * newlines inside the value.
 */
export function escapeText(value: string): string {
  const guarded = DANGEROUS.has(value.charAt(0)) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * One cell.
 *
 * 🔴 `null` becomes an EMPTY cell, not `0` and not the dashboard's `–`.
 *
 * Zero would be a claim we do not have — a cost per lead is null because spend
 * or leads was zero, and `$0.00` is the exact failure visible in the source
 * spreadsheet this product replaces. The en-dash would be worse still: it is
 * text, so it poisons the column's type and every downstream `AVERAGE` returns
 * `#DIV/0!`. An empty cell is skipped by `AVERAGE` and `SUM` and is the only
 * representation a spreadsheet reads as "no value".
 */
export function renderCell(cell: Cell): string {
  if (cell.kind === "number") {
    if (cell.value === null || !Number.isFinite(cell.value)) return "";
    return cell.value.toFixed(cell.digits ?? 0);
  }
  if (cell.value === null || cell.value === "") return "";
  return escapeText(cell.value);
}

export interface CsvTable {
  /** Column headings, in order. Always escaped as text. */
  headers: readonly string[];
  rows: ReadonlyArray<readonly Cell[]>;
}

const CRLF = "\r\n";
const BOM = "﻿";

/**
 * Serialise a table.
 *
 * Rows shorter than the header are padded and rows longer are NOT truncated —
 * a ragged row is a bug in the caller, and dropping the overflow would hide it
 * while padding merely looks odd. `buildCsv` is not the place to decide that
 * data may be discarded.
 */
export function buildCsv(table: CsvTable): string {
  const width = table.headers.length;
  const lines = [table.headers.map((h) => escapeText(h)).join(",")];

  for (const row of table.rows) {
    const cells = row.map(renderCell);
    while (cells.length < width) cells.push("");
    lines.push(cells.join(","));
  }

  return BOM + lines.join(CRLF) + CRLF;
}

/**
 * A filename a human can find again in six months.
 *
 * `parfaire-daily-2026-07-01_2026-07-31.csv`. Slugified hard, because this
 * string lands in a `Content-Disposition` header: a client display name
 * carrying a quote or a newline would otherwise split the header, and a name
 * carrying a `/` would look like a path.
 */
export function exportFilename(
  slug: string,
  dataset: string,
  startKey: string,
  endKey: string,
): string {
  const safe = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "export";
  return `${safe(slug)}-${safe(dataset)}-${safe(startKey)}_${safe(endKey)}.csv`;
}
