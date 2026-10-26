import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Creative cards, read as source: the details a later edit could quietly undo.
 */

const CARDS = readFileSync(join(__dirname, "BoardCreatives.tsx"), "utf8");
const TILE = readFileSync(join(__dirname, "BoardWidget.tsx"), "utf8");
const PICKER = readFileSync(join(__dirname, "WidgetPicker.tsx"), "utf8");
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
    // TikTok's are stored, not linked: read from our rows, never fetched.
    expect(DOC).toContain("inlineTiktokPictures(client.id, tiktok)");
  });

  it("🔴 name each stat in its own platform's words — TikTok's \"Clicks\", not Meta's \"Link clicks\"", () => {
    expect(CARDS).toContain("reg.shortLabel(m, platform)");
    expect(CARDS).not.toMatch(/reg\.(shortLabel|label)\(m, "meta"\)/);
    expect(TILE).toContain("<BoardCreatives data={live} slug={slug} platform={query.platform}");
  });

  it("🔴 are built for the source chosen in the picker, not always Meta", () => {
    expect(PICKER).toMatch(/kind: "creatives",\s*platform: d\.platform,/);
    expect(PICKER).toContain("statDims(def, platform).includes(by)");
    expect(PICKER).not.toMatch(/reg\.(polarity|label)\([^)]*, "meta"\)/);
  });
});
