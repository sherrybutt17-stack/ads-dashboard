import { describe, it, expect } from "vitest";
import {
  BRAND_MIN_CONTRAST,
  NO_BRANDING,
  accentFor,
  contrastRatio,
  isValidHexColor,
  normalizeBrandColor,
  parseHex,
  SURFACE_DARK,
  SURFACE_LIGHT,
} from "./branding";
import { accentForClient } from "./accent";

describe("parsing", () => {
  it("accepts the forms a brand guideline actually uses", () => {
    expect(parseHex("#3987e5")).toEqual({ r: 0x39, g: 0x87, b: 0xe5 });
    expect(parseHex("3987E5")).toEqual({ r: 0x39, g: 0x87, b: 0xe5 });
    // 3-digit shorthand is common; rejecting it would look like a bug to anyone
    // pasting from a style guide.
    expect(parseHex("#f00")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseHex("  #3987e5  ")).toEqual({ r: 0x39, g: 0x87, b: 0xe5 });
  });

  it("rejects everything else rather than half-parsing it", () => {
    for (const bad of ["", "#12345", "rgb(1,2,3)", "blue", null, undefined, "#zzzzzz"]) {
      expect(parseHex(bad)).toBeNull();
      expect(isValidHexColor(bad)).toBe(false);
    }
  });
});

describe("normalizeBrandColor — the both-surfaces band", () => {
  /*
   * The reason the band exists. `--accent` is painted on BOTH themes, and a
   * colour chosen against white is routinely illegible on #0a0b0f while one
   * chosen against black washes out on white. The client has one brand colour,
   * not two, so the value is clamped rather than the problem being handed back
   * to them.
   */
  it("lifts a very dark brand out of the unreadable-on-dark range", () => {
    const navy = normalizeBrandColor("#0a1e3c")!;
    expect(navy).not.toBeNull();
    expect(contrastRatio(navy, SURFACE_DARK)!).toBeGreaterThan(
      contrastRatio("#0a1e3c", SURFACE_DARK)!,
    );
  });

  it("darkens a very light brand so it survives on white", () => {
    const paleYellow = normalizeBrandColor("#fdf6b2")!;
    expect(contrastRatio(paleYellow, SURFACE_LIGHT)!).toBeGreaterThan(
      contrastRatio("#fdf6b2", SURFACE_LIGHT)!,
    );
  });

  it("keeps every normalised colour legible on BOTH surfaces at once", () => {
    // The whole point: one hex, two themes, no client asked for a second colour.
    const brands = [
      "#0a1e3c", // navy
      "#fdf6b2", // pale yellow
      "#7b1113", // maroon
      "#00ff00", // neon green
      "#ff00ff", // magenta
      "#123456",
      "#e5c07b",
    ];
    for (const b of brands) {
      const c = normalizeBrandColor(b)!;
      expect(c, `${b} failed to normalise`).not.toBeNull();
      // 3:1 is the WCAG threshold for large text and UI components, which is
      // what an accent is used for here — a mark, a tile glow, a bar.
      expect(contrastRatio(c, SURFACE_LIGHT)!, `${b} on light`).toBeGreaterThanOrEqual(
        BRAND_MIN_CONTRAST,
      );
      expect(contrastRatio(c, SURFACE_DARK)!, `${b} on dark`).toBeGreaterThanOrEqual(
        BRAND_MIN_CONTRAST,
      );
    }
  });

  it("preserves the hue — a red brand stays red", () => {
    // Clamping lightness and saturation must not rotate the hue, or the client
    // gets back a colour that is simply not theirs.
    const red = parseHex(normalizeBrandColor("#7b1113")!)!;
    expect(red.r).toBeGreaterThan(red.g);
    expect(red.r).toBeGreaterThan(red.b);

    const green = parseHex(normalizeBrandColor("#0b3d0b")!)!;
    expect(green.g).toBeGreaterThan(green.r);
    expect(green.g).toBeGreaterThan(green.b);
  });

  /*
   * A charcoal or near-grey brand must NOT be saturated up to hit a target —
   * that hands back a teal to a client whose brand is grey.
   */
  it("leaves a near-grey brand grey", () => {
    const grey = parseHex(normalizeBrandColor("#3a3a3c")!)!;
    const spread = Math.max(grey.r, grey.g, grey.b) - Math.min(grey.r, grey.g, grey.b);
    expect(spread).toBeLessThan(20);
  });

  it("returns null for junk so the caller can fall back", () => {
    expect(normalizeBrandColor("not a colour")).toBeNull();
    expect(normalizeBrandColor(null)).toBeNull();
  });
});

describe("accentFor", () => {
  it("is pixel-identical to today when nothing is configured", () => {
    // Shipping branding must change nothing for a client who has not set one.
    const id = "11111111-1111-1111-1111-111111111111";
    expect(accentFor(id, NO_BRANDING)).toEqual(accentForClient(id));
  });

  it("uses the brand colour once set", () => {
    const a = accentFor("abc", { ...NO_BRANDING, brandColor: "#2aa9b8" });
    expect(a.color).toBe("#2aa9b8");
    expect(a.glow).toContain("42, 169, 184");
  });

  it("ignores the brand colour on the dashboard when the agency scoped it to reports", () => {
    const id = "abc";
    const a = accentFor(id, {
      ...NO_BRANDING,
      brandColor: "#2aa9b8",
      appliesToDashboard: false,
    });
    expect(a).toEqual(accentForClient(id));
  });

  it("falls back rather than emitting an unusable value for a bad stored colour", () => {
    const id = "abc";
    expect(accentFor(id, { ...NO_BRANDING, brandColor: "chartreuse" })).toEqual(
      accentForClient(id),
    );
  });
});
