import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The routes that put a board in front of someone without a session: the PDF
 * renderer and a share link's reader.
 *
 * Their safety is all ordering and branching — which check comes first, which
 * branch is tested before which — and none of it is visible to a type check.
 * So it is asserted against the source, the way the board's own routes are
 * (`board-routes.test.ts`).
 */

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

const PDF = source("src", "app", "api", "c", "[slug]", "board", "pdf", "route.ts");
const RENDER = source("src", "app", "render", "[token]", "page.tsx");
const SHARED = source("src", "app", "r", "[token]", "page.tsx");
const SHARE_ROUTE = source("src", "app", "api", "clients", "[id]", "share", "route.ts");

function inOrder(text: string, needles: string[]) {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at + 1);
    expect(i, `"${n}" missing or out of order`).toBeGreaterThan(at);
    at = i;
  }
}

describe("board PDF route", () => {
  it("🔴 checks the tenant, then the capability, then the budget, before any work", () => {
    inOrder(PDF, [
      "clientAccessGuard(slug)",
      "getClientForSession(",
      "isPdfConfigured()",
      "rateLimit(`pdf:${client.id}`",
      "mintRenderToken(",
      "renderPdf(",
    ]);
  });

  it("answers 501 when no renderer is configured", () => {
    expect(PDF).toMatch(/if \(!isPdfConfigured\(\)\) \{[\s\S]*?status: 501/);
  });

  it("asks Meta for reach before the renderer arrives, never after", () => {
    inOrder(PDF, ["needsReach(board.widgets)", "ensurePeriodReach(client, window)", "mintRenderToken("]);
  });

  it("🔴 signs the board into the token, and renders landscape", () => {
    expect(PDF).toContain('dataset: "board"');
    expect(PDF).toContain("landscape: true");
  });

  it("is never cached", () => {
    expect(PDF).toContain('"Cache-Control": "no-store, must-revalidate"');
  });
});

describe("the render page", () => {
  it("🔴 takes the board branch before the dataset check would 404 it", () => {
    inOrder(RENDER, ['if (dataset === "board")', "isDatasetId(dataset)"]);
  });

  it("🔴 never calls Meta: document mode reads reach from the cache", () => {
    // The window argument has its own parentheses, so scan a bounded span.
    expect(RENDER).toMatch(/loadBoardDocument\([\s\S]{0,120}?"document"/);
  });
});

describe("a shared board", () => {
  it("🔴 is recognised before the report reading would take it for the standard report", () => {
    inOrder(SHARED, ["const board = boardForLink(link);", "const view = viewForLink(link);"]);
  });

  it("🔴 renders the frozen snapshot, in document mode", () => {
    expect(SHARED).toMatch(/loadBoardDocument\([\s\S]*?"document",\s*\{ snapshot: board\.widgets \}/);
  });

  it("🔴 freezes the STORED board, never widgets from the request", () => {
    expect(SHARE_ROUTE).toMatch(/board = \(await getBoard\(client\.id, context\.starter\)\)\.widgets/);
    expect(SHARE_ROUTE).not.toMatch(/body[^\n]*\.widgets|widgets: rawWidgets|\bwidgets\b[^\n]*= body/);
  });

  it("lists a board link as a board, ahead of the report reading", () => {
    inOrder(SHARE_ROUTE, ["const board = boardForLink(link);", "const view = viewForLink(link);"]);
  });
});
