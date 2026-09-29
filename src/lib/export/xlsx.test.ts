import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildXlsx, sheetName } from "./xlsx";
import { money, num, percent, text, type CsvTable } from "./csv";

/**
 * The workbook is a ZIP, so the assertions unzip it and read the real sheet
 * XML. Asserting on the bytes we passed in would test nothing — the whole
 * question is what the serialiser produced.
 */
function sheetXml(buf: Uint8Array, index = 1): string {
  const files = unzipSync(buf);
  const key = `xl/worksheets/sheet${index}.xml`;
  const entry = files[key];
  if (!entry) {
    throw new Error(
      `no ${key} — entries: ${Object.keys(files).sort().join(", ")}`,
    );
  }
  return strFromU8(entry);
}

/** Shared strings live in their own part; inline cells do not. Read both. */
function sharedStrings(buf: Uint8Array): string {
  const files = unzipSync(buf);
  const entry = files["xl/sharedStrings.xml"];
  return entry ? strFromU8(entry) : "";
}

/**
 * A NUMERIC cell at an address: no `t=` attribute (so not a shared or inline
 * string) holding exactly this value. Several earlier assertions matched a bare
 * `<v>2</v>`, which is also what the THIRD SHARED STRING looks like — they
 * passed on files that did not contain the number at all.
 */
const numericAt = (xml: string, ref: string, value: string) =>
  new RegExp(`<c r="${ref}"(?![^>]*\\bt=)[^>]*><v>${value.replace(".", "\\.")}</v></c>`).test(xml);

/** A row's markup, or "" when the row is absent. */
const rowXml = (xml: string, n: number) =>
  xml.match(new RegExp(`<row r="${n}"[^>]*>.*?</row>`))?.[0] ?? "";

const table = (rows: CsvTable["rows"], headers = ["A", "B"]): CsvTable => ({
  headers,
  rows,
});

describe("buildXlsx", () => {
  it("produces a real ZIP container", async () => {
    const buf = await buildXlsx([
      { name: "Daily", table: table([[text("x"), num(1)]]) },
    ]);
    // Same reasoning as pdf.ts checking for `%PDF-`: a provider or a library
    // that answers with something else should fail here, not in Excel.
    expect(Array.from(buf.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("🔴 writes numbers as numbers, not strings", async () => {
    const buf = await buildXlsx([
      { name: "S", table: table([[text("row"), money(1234.5)]]) },
    ]);
    const xml = sheetXml(buf);
    // A numeric cell has no t="s"/t="inlineStr" and carries a bare <v>.
    // If money(1234.5) had been stringified, SUM over the column would be 0 —
    // which is the entire failure this format exists to avoid.
    expect(xml).toMatch(/<v>1234\.5<\/v>/);
    expect(xml).not.toMatch(/t="s"><v>1234\.5/);
  });

  it("🔴 never emits a formula element, even for dangerous text", async () => {
    const hostile = [
      "=HYPERLINK(\"http://evil\",\"click\")",
      "+1+1",
      "-SUM(A1:A9)",
      "@import",
    ];
    const buf = await buildXlsx([
      { name: "S", table: table(hostile.map((h) => [text(h), num(1)])) },
    ]);
    const xml = sheetXml(buf);
    const strings = sharedStrings(buf);

    // In OOXML a cell is only a formula when it carries an <f> child. This
    // module never sets type:'Formula', so the guard is that no <f> appears.
    expect(xml).not.toMatch(/<f[ >]/);

    // And the text survives verbatim — no apostrophe prefix. CSV's defusing
    // would be visible characters here, which is a different bug.
    const all = xml + strings;
    expect(all).toContain("HYPERLINK");
    expect(all).not.toContain("'=HYPERLINK");
  });

  it("🔴 leaves a null number empty rather than writing zero", async () => {
    const buf = await buildXlsx([
      { name: "S", table: table([[text("a"), money(null)]]) },
    ]);
    const xml = sheetXml(buf);
    /*
     * Asserted on the CELL COUNT of the data row, not on the absence of
     * `<v>0</v>` — strings are stored in a shared-strings part and referenced
     * by index, so a `t="s"` cell holding `<v>0</v>` is the FIRST STRING, not a
     * numeric zero. An earlier version of this test matched that index and
     * failed on a perfectly correct file.
     *
     * The real invariant: the null cell is omitted entirely, so the row that
     * declares two columns emits one cell.
     */
    const row = xml.match(/<row r="2">.*?<\/row>/)?.[0] ?? "";
    expect(row).toMatch(/<c /);
    expect(row.match(/<c /g)).toHaveLength(1);
    // Zero would be a claim we do not have, and unlike CSV it would be typed
    // as a measured number and averaged as one.
    expect(row).not.toMatch(/<c [^>]*\/?>(<v>0<\/v>)/);
  });

  it("leaves a null/empty string cell empty", async () => {
    const buf = await buildXlsx([
      { name: "S", table: table([[text(null), text("")]]) },
    ]);
    // Both cells omitted: the data row carries no <c> at all.
    expect(rowXml(sheetXml(buf), 2)).not.toMatch(/<c /);
  });

  it("keeps full precision in the stored value, formatting only for display", async () => {
    const buf = await buildXlsx([
      { name: "S", table: table([[text("a"), money(10.126)]]) },
    ]);
    // toFixed(2) in CSV would discard the third decimal permanently; here the
    // stored number is intact and only the display format is two places.
    expect(sheetXml(buf)).toMatch(/<v>10\.126<\/v>/);
  });

  it("writes percent cells as the percentage number, matching CSV", async () => {
    const buf = await buildXlsx([
      { name: "S", table: table([[text("a"), percent(0.285)]]) },
    ]);
    expect(sheetXml(buf)).toMatch(/<v>28\.5(0*)?<\/v>/);
  });

  it("pads a short row instead of truncating a long one", async () => {
    const buf = await buildXlsx([
      {
        name: "S",
        table: table(
          [[text("only-one")], [text("a"), num(1), num(2)]],
          ["A", "B"],
        ),
      },
    ]);
    // Same contract as buildCsv: ragged rows are a caller bug and dropping the
    // overflow would hide it.
    const xml = sheetXml(buf);
    // The overflow cell C3 survives as the number 2 — not a string index.
    expect(numericAt(xml, "C3", "2")).toBe(true);
  });

  it("writes one sheet per entry, in order", async () => {
    const buf = await buildXlsx([
      { name: "First", table: table([[text("a"), num(1)]]) },
      { name: "Second", table: table([[text("b"), num(2)]]) },
    ]);
    expect(numericAt(sheetXml(buf, 1), "B2", "1")).toBe(true);
    expect(numericAt(sheetXml(buf, 2), "B2", "2")).toBe(true);
    // And the tabs are named, in order.
    const workbook = strFromU8(unzipSync(buf)["xl/workbook.xml"]);
    expect(workbook.indexOf('name="First"')).toBeGreaterThan(-1);
    expect(workbook.indexOf('name="First"')).toBeLessThan(workbook.indexOf('name="Second"'));
  });

  it("rejects an empty workbook rather than writing a file Excel cannot open", async () => {
    await expect(buildXlsx([])).rejects.toThrow(/at least one sheet/);
  });
});

describe("sheetName", () => {
  it.each([":", "*", "?", "/", "\\", "[", "]"])(
    "strips %s, which makes Excel refuse the whole file",
    (ch) => {
      expect(sheetName(`Lead${ch}s`)).not.toContain(ch);
    },
  );

  it("truncates at 31 characters", () => {
    expect(sheetName("x".repeat(60))).toHaveLength(31);
  });

  it("falls back rather than returning an empty name", () => {
    expect(sheetName("///")).toBe("Sheet");
    expect(sheetName("   ")).toBe("Sheet");
  });

  it("leaves an ordinary label alone", () => {
    expect(sheetName("Month on month")).toBe("Month on month");
  });
});
