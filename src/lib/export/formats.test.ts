import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS,
  formatMeta,
  isExportFormat,
  type ExportFormat,
} from "./formats";
import { exportFilename } from "./csv";

describe("isExportFormat", () => {
  it.each(["csv", "xlsx", "pdf"])("accepts %s", (v) => {
    expect(isExportFormat(v)).toBe(true);
  });

  it.each(["", "CSV", "xls", "json", "../etc/passwd"])(
    "rejects %s",
    (v) => {
      expect(isExportFormat(v)).toBe(false);
    },
  );
});

describe("EXPORT_FORMATS", () => {
  it("has a row for every member of the union", () => {
    /*
     * `satisfies Record<ExportFormat, true>` makes this list EXHAUSTIVE at
     * compile time: adding a member to the union without adding it here fails
     * the typecheck, and the runtime comparison then catches a union member
     * with no registry row. (The previous version compared the registry with a
     * hand-typed list of the same three strings — it could not fail.)
     */
    const every = { csv: true, xlsx: true, pdf: true } satisfies Record<ExportFormat, true>;
    expect(EXPORT_FORMATS.map((f) => f.id).sort()).toEqual(Object.keys(every).sort());
  });

  it("gives every format a distinct extension and a real media type", () => {
    const exts = EXPORT_FORMATS.map((f) => f.ext);
    expect(new Set(exts).size).toBe(exts.length);
    for (const f of EXPORT_FORMATS) {
      expect(f.mime).toMatch(/^[a-z]+\/[a-zA-Z0-9.+-]+/);
      expect(f.ext).toMatch(/^[a-z0-9]+$/);
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
    }
  });

  it("marks only PDF as metered", () => {
    // The second rate limit in the route keys off this: a PDF costs money at a
    // third party, a CSV is a string concatenation.
    expect(EXPORT_FORMATS.filter((f) => f.metered).map((f) => f.id)).toEqual([
      "pdf",
    ]);
  });

  it("formatMeta round-trips every id", () => {
    for (const f of EXPORT_FORMATS) {
      expect(formatMeta(f.id)).toBe(f);
    }
  });
});

describe("exportFilename extension", () => {
  it("defaults to csv, so pre-format callers are untouched", () => {
    expect(exportFilename("acme", "daily", "2026-07-01", "2026-07-31")).toBe(
      "acme-daily-2026-07-01_2026-07-31.csv",
    );
  });

  it.each(["xlsx", "pdf"])("uses the %s extension when given", (ext) => {
    expect(
      exportFilename("acme", "daily", "2026-07-01", "2026-07-31", ext),
    ).toBe(`acme-daily-2026-07-01_2026-07-31.${ext}`);
  });

  it("slugifies the extension like every other segment", () => {
    // It arrives from a registry rather than a request, but a filename builder
    // that trusts one input and not the others is one waiting to be handed the
    // wrong one — this string lands in a Content-Disposition header.
    expect(
      exportFilename("acme", "daily", "2026-07-01", "2026-07-31", 'x"; rm -rf'),
    ).not.toMatch(/["; ]/);
  });
});
