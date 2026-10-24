import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Creative cards, read as source: the details a later edit could quietly undo.
 */

const CARDS = readFileSync(join(__dirname, "BoardCreatives.tsx"), "utf8");
const DOC = readFileSync(join(__dirname, "..", "..", "lib", "board", "document.ts"), "utf8");

describe("creative cards", () => {
  it("🔴 open Facebook's preview in a new tab without handing it our page", () => {
    expect(CARDS).toMatch(/target="_blank"/);
    expect(CARDS).toMatch(/rel="noopener noreferrer"/);
  });

  it("load their pictures eagerly in a document, where a lazy one may never be drawn", () => {
    expect(CARDS).toMatch(/eager=\{printed\}/);
  });

  it("carry no series colours — they are cards, not a chart", () => {
    expect(CARDS).not.toMatch(/--series-/);
  });

  it("🔴 get their pictures inline in every document, which has no session for the thumb route", () => {
    expect(DOC).toMatch(/await inlineCreativeThumbs\(client, widgets, data\)/);
  });
});
