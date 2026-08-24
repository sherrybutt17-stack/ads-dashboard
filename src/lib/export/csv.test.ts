import { describe, it, expect } from "vitest";
import {
  buildCsv,
  escapeText,
  exportFilename,
  money,
  num,
  percent,
  renderCell,
  text,
} from "./csv";

const lines = (csv: string) => csv.replace(/^﻿/, "").split("\r\n");
const body = (csv: string) => lines(csv).slice(1);

describe("escapeText", () => {
  it("quotes every value, so commas and quotes cannot split a row", () => {
    expect(escapeText("Summer Sale")).toBe('"Summer Sale"');
    expect(escapeText("Doe, Jane")).toBe('"Doe, Jane"');
    expect(escapeText('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("keeps an embedded newline inside the quoted field", () => {
    // RFC 4180 allows this; a naive writer would emit a second row here.
    expect(escapeText("line one\nline two")).toBe('"line one\nline two"');
  });

  describe("🔴 formula injection", () => {
    /*
     * The one genuinely dangerous thing about this feature. Campaign and lead
     * names come from GHL and from Ads Manager, so the values are attacker-
     * influenceable and the file is opened on a client's own machine.
     */
    it.each(["=", "+", "-", "@", "\t", "\r"])(
      "defuses a value starting with %j",
      (ch) => {
        expect(escapeText(`${ch}HYPERLINK("http://evil")`)).toContain(
          `"'${ch}HYPERLINK`,
        );
      },
    );

    it("leaves a dangerous character alone anywhere but the first position", () => {
      // `Q4 = growth` is not a formula and must not grow an apostrophe.
      expect(escapeText("Q4 = growth")).toBe('"Q4 = growth"');
      expect(escapeText("a-b-c")).toBe('"a-b-c"');
    });

    it("still defuses when the payload is also comma-bearing", () => {
      const out = escapeText("=SUM(A1,A2)");
      expect(out.startsWith(`"'=`)).toBe(true);
    });
  });
});

describe("renderCell", () => {
  it("🔴 renders null as an EMPTY cell, not zero and not a dash", () => {
    /*
     * Zero would assert a fact we do not have — the exact `$0.00 CP-LEAD`
     * failure in the spreadsheet this product replaces. A dash would be text
     * and would poison the column's type for every AVERAGE below it.
     */
    expect(renderCell(money(null))).toBe("");
    expect(renderCell(num(null))).toBe("");
    expect(renderCell(percent(null))).toBe("");
    expect(renderCell(text(null))).toBe("");
  });

  it("renders an empty string as an empty cell too", () => {
    expect(renderCell(text(""))).toBe("");
  });

  it("drops non-finite numbers rather than writing Infinity or NaN", () => {
    expect(renderCell(num(Infinity))).toBe("");
    expect(renderCell(num(NaN, 2))).toBe("");
  });

  it("writes money at two decimals with no symbol or separators", () => {
    expect(renderCell(money(1234.5))).toBe("1234.50");
    expect(renderCell(money(0))).toBe("0.00");
  });

  it("writes counts as integers", () => {
    expect(renderCell(num(65))).toBe("65");
  });

  it("scales a ratio to the percentage the header names", () => {
    // `bookPct` is stored 0.285 and shown as 28.50% — the export must agree.
    expect(renderCell(percent(0.285))).toBe("28.50");
    expect(renderCell(percent(0))).toBe("0.00");
  });

  it("🔴 does NOT defuse a negative number", () => {
    /*
     * The whole reason cells carry a kind. Run the text guard over this and the
     * value exports as text, every SUM silently drops it, and the client's own
     * spreadsheet disagrees with the dashboard.
     */
    expect(renderCell(money(-12.4))).toBe("-12.40");
    expect(renderCell(num(-3))).toBe("-3");
    expect(renderCell(percent(-0.5))).toBe("-50.00");
  });
});

describe("buildCsv", () => {
  const table = {
    headers: ["Date", "Spend", "Leads"],
    rows: [
      [text("2026-07-01"), money(12.5), num(3)],
      [text("2026-07-02"), money(null), num(0)],
    ],
  };

  it("leads with a UTF-8 BOM so Excel reads the encoding", () => {
    // Without it, `Nicolás` arrives as `NicolÃ¡s` on Windows.
    expect(buildCsv(table).charCodeAt(0)).toBe(0xfeff);
  });

  it("ends every line CRLF, per RFC 4180", () => {
    const csv = buildCsv(table);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("writes the header row, escaped", () => {
    expect(lines(buildCsv(table))[0]).toBe('"Date","Spend","Leads"');
  });

  it("writes one line per row in order", () => {
    const rows = body(buildCsv(table)).filter(Boolean);
    expect(rows).toEqual(['"2026-07-01",12.50,3', '"2026-07-02",,0']);
  });

  it("pads a short row to the header width rather than emitting a ragged line", () => {
    const csv = buildCsv({
      headers: ["A", "B", "C"],
      rows: [[text("only")]],
    });
    expect(body(csv)[0]).toBe('"only",,');
  });

  it("does not truncate an over-long row", () => {
    /*
     * A ragged row is a caller bug. Padding merely looks odd; truncating would
     * silently discard data, and this file is not the place that gets to decide
     * data may be dropped.
     */
    const csv = buildCsv({ headers: ["A"], rows: [[text("x"), text("y")]] });
    expect(body(csv)[0]).toBe('"x","y"');
  });

  it("handles a table with no rows at all", () => {
    const csv = buildCsv({ headers: ["A", "B"], rows: [] });
    expect(lines(csv).filter(Boolean)).toEqual(['"A","B"']);
  });
});

describe("exportFilename", () => {
  it("names the client, the dataset and the range", () => {
    expect(exportFilename("parfaire", "daily", "2026-07-01", "2026-07-31")).toBe(
      "parfaire-daily-2026-07-01_2026-07-31.csv",
    );
  });

  it("🔴 cannot break out of the Content-Disposition header", () => {
    /*
     * This string goes into a response header inside double quotes. A slug
     * carrying a quote would close it and a newline would end the header
     * outright, so everything but [a-z0-9-] is collapsed before it gets there.
     */
    const name = exportFilename('a"b\r\nX-Evil: 1', "leads", "2026-01-01", "2026-01-02");
    expect(name).not.toMatch(/["\r\n]/);
    expect(name).toBe("a-b-x-evil-1-leads-2026-01-01_2026-01-02.csv");
  });

  it("survives a slug with nothing usable in it", () => {
    expect(exportFilename("！！！", "daily", "a", "b")).toBe(
      "export-daily-a_b.csv",
    );
  });

  it("bounds each segment so the filename cannot grow without limit", () => {
    const name = exportFilename("x".repeat(500), "daily", "2026-01-01", "2026-01-02");
    expect(name.length).toBeLessThan(120);
  });
});
