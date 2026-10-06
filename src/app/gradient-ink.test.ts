import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 A gradient that carries white text must hold white at EVERY stop.
 *
 * Both violet gradients shipped failing this and neither looked wrong:
 *
 *  - --g-primary's light stop was #7a6cf6 (white 3.96:1). Because it is the
 *    top-left corner of a 135deg sweep, the easy argument is "no glyph reaches
 *    it". Rasterising the real gradient at real button sizes and reading only
 *    the pixels inside each label's box showed the argument was wrong anyway:
 *    "Save mapping" 4.37:1, "Verify & add" 4.43, "Add client" 4.48, while a
 *    wider button read 4.68 — the defect moved with the button's geometry.
 *  - --g-hero's light stop was #7468ee (white 4.24:1) before any decoration,
 *    and the auth panel lays a blurred white light over it.
 *
 * Per-stop is the only check that does not depend on geometry, padding or
 * label length, so it is the one worth enforcing. It is deliberately stricter
 * than what any single glyph sees; a stop that fails it is a stop to darken.
 */

const CSS = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
const AUTH = readFileSync(
  join(process.cwd(), "src", "components", "AuthShell.tsx"),
  "utf8",
);

type Rgb = { r: number; g: number; b: number };
const parse = (hex: string): Rgb => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

function luminance({ r, g, b }: Rgb): number {
  const ch = [r, g, b]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** White laid over a colour at alpha `a` — the decorative lights on the panel. */
const whiteOver = (bg: Rgb, a: number): Rgb => ({
  r: 255 * a + bg.r * (1 - a),
  g: 255 * a + bg.g * (1 - a),
  b: 255 * a + bg.b * (1 - a),
});

/** The stops of one gradient token, as declared. */
function stops(token: string): Rgb[] {
  const m = CSS.match(new RegExp(`${token}:\\s*linear-gradient\\(([^;]*)\\);`));
  expect(m, `globals.css no longer declares ${token} as a linear-gradient`).toBeTruthy();
  const hexes = [...m![1].matchAll(/#[0-9a-fA-F]{6}/g)].map((h) => h[0]);
  expect(hexes.length, `${token} parsed no stops`).toBeGreaterThanOrEqual(2);
  return hexes.map(parse);
}

/** Every decorative white overlay the auth panel paints over --g-hero. */
function panelOverlays(): number[] {
  const found = [...AUTH.matchAll(/background:\s*"rgba\(255,\s*255,\s*255,\s*([\d.]+)\)"/g)].map(
    (m) => Number(m[1]),
  );
  expect(found.length, "AuthShell no longer paints white overlays").toBeGreaterThan(0);
  return found;
}

const FLOOR = 4.5;

describe("white ink on gradient tokens", () => {
  for (const token of ["--g-primary", "--g-hero"]) {
    it(`🔴 white clears ${FLOOR}:1 on every stop of ${token}`, () => {
      const bad = stops(token)
        .map((s) => ({ s, r: contrast(WHITE, s) }))
        .filter((x) => x.r < FLOOR)
        .map(
          (x) =>
            `rgb(${Math.round(x.s.r)},${Math.round(x.s.g)},${Math.round(x.s.b)}) = ${x.r.toFixed(2)}:1`,
        );
      expect(bad, `${token} has stops white cannot sit on:\n  ${bad.join("\n  ")}`).toEqual([]);
    });
  }

  /*
   * The two tokens above are guarded because they are the two that exist today.
   * This one is guarded because of how .card-glass went wrong: it spelled its
   * own stops instead of taking the token, so when --g-primary was darkened it
   * kept the old #7a6cf6 — and being unused, nothing caught it. A re-spelled
   * gradient under white ink is the shape of that bug, wherever it appears.
   */
  it("🔴 no rule spells its own gradient under white ink", () => {
    const bad: string[] = [];
    for (const m of CSS.matchAll(/(^|\n)(\.[a-z][\w-]*(?:\s+\.[\w-]+)*)\s*\{([^}]*)\}/g)) {
      const [name, body] = [m[2], m[3]];
      if (!/color:\s*#(?:fff|ffffff)\b/i.test(body)) continue;
      const grad = body.match(/linear-gradient\(([^;]*)\)/);
      if (!grad) continue;
      for (const hex of grad[1].matchAll(/#[0-9a-fA-F]{6}/g)) {
        const r = contrast(WHITE, parse(hex[0]));
        if (r < FLOOR) bad.push(`${name} stop ${hex[0]} = ${r.toFixed(2)}:1`);
      }
      // An rgba stop is worst over a light backdrop: the ground lightens toward
      // the white sitting on it. .card-glass read 3.50:1 that way at alpha 0.92
      // while its opaque value was 3.96 — the translucency made it worse, not
      // softer, which is why that card is no longer translucent.
      for (const c of grad[1].matchAll(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/g)) {
        const base = { r: Number(c[1]), g: Number(c[2]), b: Number(c[3]) };
        const a = Number(c[4]);
        const over = { r: base.r * a + 255 * (1 - a), g: base.g * a + 255 * (1 - a), b: base.b * a + 255 * (1 - a) };
        const r = contrast(WHITE, over);
        if (r < FLOOR) bad.push(`${name} stop ${c[0]} over a light backdrop = ${r.toFixed(2)}:1`);
      }
    }
    expect(
      bad,
      "Take var(--g-primary)/var(--g-hero) instead of re-spelling stops:\n  " + bad.join("\n  "),
    ).toEqual([]);
  });

  it("🔴 --g-hero still clears under the auth panel's own decoration", () => {
    // The panel is not just the gradient: two blurred white lights sit over it,
    // and the strongest of them is what drags the ground. Checking the bare
    // stops alone passed this panel at 4.87:1 while the composite was 3.36:1.
    const strongest = Math.max(...panelOverlays());
    const bad = stops("--g-hero")
      .map((s) => ({ s, r: contrast(WHITE, whiteOver(s, strongest)) }))
      .filter((x) => x.r < FLOOR)
      .map((x) => `stop under ${strongest} white = ${x.r.toFixed(2)}:1`);
    expect(
      bad,
      `--g-hero fails once AuthShell's own ${strongest}-alpha light is over it:\n  ${bad.join("\n  ")}`,
    ).toEqual([]);
  });
});
