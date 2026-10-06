import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeBrandColor, BRAND_MIN_CONTRAST } from "@/lib/branding";

/*
 * 🔴 `.client-card` washes a card in a colour the CLIENT chose, and a client
 * can choose 42,501 of them.
 *
 * Every other tinted surface in this product is painted from a fixed token that
 * a human tuned: `--tint-violet` is one colour, measured once. This one is not.
 * A client's `brandColor` goes through `normalizeBrandColor` on write, which
 * only guarantees `BRAND_MIN_CONTRAST` (3:1) against both surfaces — a NON-TEXT
 * floor — and then that colour is washed into the card that carries their name,
 * a meta line and a call to action. So the safety of this rule cannot be
 * established by looking at the six generated accents: it has to hold for the
 * whole band the writer will accept.
 *
 * This test brute-forces that band. It is the check that caught the first
 * attempt: a 7% wash measured 4.84:1 over the six shipped accents and looked
 * comfortable, and 4.72:1 over the full band — under the floor, in dark mode,
 * on the caption line nobody reads.
 *
 * ── Why the arithmetic here is exact, not an approximation ────────────
 *
 * `color-mix(in srgb, A P%, B)` is a channel-wise lerp in gamma-encoded sRGB:
 * no linearisation, no gamut mapping, no interpolation hue. That is what makes
 * a stylesheet value computable in Node at all, and it is why `mix` below is
 * four lines rather than a colour library.
 */

const CSS = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");

type Rgb = { r: number; g: number; b: number };

function parse(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** `color-mix(in srgb, a p%, b)`, exactly as the browser computes it. */
function mix(a: Rgb, p: number, b: Rgb): Rgb {
  const f = (x: number, y: number) => Math.round(x * p + y * (1 - p));
  return { r: f(a.r, b.r), g: f(a.g, b.g), b: f(a.b, b.b) };
}

function luminance({ r, g, b }: Rgb): number {
  const ch = [r, g, b]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The rule as shipped, read out of the stylesheet rather than restated here.
 *
 * A test that hardcoded 6% and 85% would keep passing after someone widened the
 * wash in globals.css, which is the one edit it exists to stop.
 */
const RULE = (() => {
  const from = CSS.indexOf(".client-card {");
  expect(from, "globals.css no longer declares .client-card").toBeGreaterThan(-1);
  const body = CSS.slice(from, CSS.indexOf("\n}", from));

  const wash = body.match(
    /background:\s*color-mix\(in srgb, var\(--accent\) (\d+)%, var\(--card-bg\)\)/,
  );
  const spine = body.match(
    /border-left:\s*\d+px solid color-mix\(in srgb, var\(--accent\) (\d+)%, var\(--text-primary\)\)/,
  );
  expect(wash, ".client-card no longer washes --accent into --card-bg").not.toBeNull();
  expect(spine, ".client-card's spine is no longer mixed toward --text-primary").not.toBeNull();

  return { wash: Number(wash![1]) / 100, spine: Number(spine![1]) / 100 };
})();

/**
 * The token values each theme paints this card with.
 *
 * Hardcoded on purpose, and cross-checked against the stylesheet below: the
 * point of this file is that the MEASUREMENT is reproducible, and a test that
 * parsed both sides of the comparison out of the same file could be satisfied
 * by any pair of values that happened to agree.
 */
const THEMES = [
  {
    name: "light",
    cardBg: "#ffffff",
    /* What the group headings sit on — the app frame, not a card. */
    surfaceApp: "#f5f5f9",
    tokens: {
      "--text-primary": "#16161d",
      "--text-secondary": "#5c5c68",
      "--text-muted": "#666673",
      "--status-critical": "#a92626",
      "--status-good": "#137a13",
      "--status-warning": "#8a5f00",
    } as Record<string, string>,
  },
  {
    name: "dark",
    cardBg: "#1c1c26",
    surfaceApp: "#15151d",
    tokens: {
      "--text-primary": "#f2f2f7",
      "--text-secondary": "#b4b4c2",
      "--text-muted": "#8e8e9e",
      "--status-critical": "#ff6b6b",
      "--status-good": "#0ca30c",
      "--status-warning": "#fab219",
    } as Record<string, string>,
  },
] as const;

const COMPONENT = readFileSync(
  join(process.cwd(), "src", "components", "ClientCards.tsx"),
  "utf8",
);

/**
 * The card's own source, from `function Card(` to the end of the file.
 *
 * Sliced rather than read whole because the group headings above it sit on
 * `--surface-app`, not on a washed card, and measuring their `--text-muted`
 * blurb against the card's ground would fail for a card that never carries it.
 */
const CARD_SRC = (() => {
  const from = COMPONENT.indexOf("function Card(");
  expect(from, "ClientCards.tsx no longer defines `function Card(`").toBeGreaterThan(-1);
  return COMPONENT.slice(from);
})();

/**
 * 🔴 Every ink the card actually paints, READ BACK OUT OF THE COMPONENT.
 *
 * This is the point of the file. The wash depth is a budget spent on a specific
 * set of inks, and the way it breaks is not someone editing the percentage — it
 * is someone adding a third line to the card in `--text-muted`, which is a
 * change no reviewer would question and which silently puts the faintest token
 * in the house on a 14% ground. A hardcoded list here would keep passing.
 *
 * So the list is derived, and an ink this file has no measured value for is a
 * failure rather than a skip.
 */
const CARD_INKS: string[] = [
  ...new Set([
    ...[...CARD_SRC.matchAll(/(?<![A-Za-z])color:\s*"var\((--[a-z-]+)\)"/g)].map(
      (m) => m[1],
    ),
    ...[...CARD_SRC.matchAll(/\btext-\[var\((--[a-z-]+)\)\]/g)].map((m) => m[1]),
  ]),
];

/** The hue each group heading wears, likewise read back out of the component. */
const SECTION_HUES: string[] = [
  ...new Set([...COMPONENT.matchAll(/hue:\s*"(--[a-z-]+)"/g)].map((m) => m[1])),
];

/**
 * Above AA, matching `--tint-*`.
 *
 * The margin is the point: a value sitting at exactly 4.50 passes today and
 * fails the moment a text token is nudged one step, and text tokens get nudged.
 */
const INK_FLOOR = 4.75;

/**
 * The spine and the monogram are MARKS — a 3px bar and a filled tile — so they
 * are held to the non-text floor, and to nothing less. Nothing on this card may
 * set type in the accent; `.accent-text` lands at the same value the spine does
 * and would be under AA on the washed ground.
 */
const MARK_FLOOR = BRAND_MIN_CONTRAST;

/**
 * Every colour `normalizeBrandColor` can emit.
 *
 * Not a sample. The writer is the only gate on what reaches `--accent`, so the
 * band it accepts is exactly the band this rule has to survive — and the two
 * failures this file was written after were both invisible at six colours.
 */
const BAND: string[] = (() => {
  const out: string[] = [];
  const step = 5;
  for (let r = 0; r <= 255; r += step) {
    for (let g = 0; g <= 255; g += step) {
      for (let b = 0; b <= 255; b += step) {
        const hex =
          "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
        if (normalizeBrandColor(hex) === hex.toLowerCase()) out.push(hex);
      }
    }
  }
  return out;
})();

describe(".client-card", () => {
  it("sweeps a band wide enough to be worth sweeping", () => {
    /*
     * Anti-rot. Every assertion below iterates BAND, so a `normalizeBrandColor`
     * that started rejecting everything — or a hex-format drift that made the
     * round-trip never match — would empty it and make this whole file pass
     * while measuring nothing at all.
     */
    expect(
      BAND.length,
      "normalizeBrandColor accepted almost nothing — the round-trip comparison " +
        "has drifted (case? shorthand expansion?) and this file is now vacuous",
    ).toBeGreaterThan(1000);
  });

  it("agrees with the stylesheet about what the inks and card are", () => {
    /*
     * The other half of the anti-rot. THEMES is hardcoded so the measurement is
     * reproducible; this is what stops it from being hardcoded WRONG — or from
     * going stale the day someone retunes a text token and this file keeps
     * cheerfully certifying a card nobody has measured since.
     */
    const lightFrom = CSS.indexOf(":root {");
    const light = CSS.slice(lightFrom, CSS.indexOf("\n}", lightFrom));
    const darkFrom = CSS.indexOf(':root[data-theme="dark"] {');
    const dark = CSS.slice(darkFrom, CSS.indexOf("\n}", darkFrom));

    for (const [scope, body] of [
      [THEMES[0], light],
      [THEMES[1], dark],
    ] as const) {
      for (const [name, hex] of Object.entries(scope.tokens)) {
        expect(
          body,
          `${scope.name}: ${name} is no longer ${hex} in globals.css — ` +
            "retune this file's THEMES and re-derive the percentages",
        ).toContain(`${name}: ${hex};`);
      }
      expect(body).toContain(`--card-bg: ${scope.cardBg};`);
    }
  });

  it("paints the card in inks this file has actually measured", () => {
    /*
     * Anti-rot, and the rule the wash depth depends on. `--text-muted` is
     * excluded by NAME rather than by measurement because the failure it causes
     * is not a slightly-low ratio — it is a 14% wash that has to drop to 6%,
     * which is the difference between a coloured card and a white one.
     */
    expect(
      CARD_INKS.length,
      "no inks parsed out of `function Card(` — the scan has drifted and " +
        "every measurement below is now vacuous",
    ).toBeGreaterThanOrEqual(3);

    const unknown = CARD_INKS.filter((i) => !(i in THEMES[0].tokens));
    expect(
      unknown,
      "the card paints an ink this file has no measured value for, so it is " +
        "shipping unmeasured. Add it to THEMES and re-derive the wash:\n" +
        unknown.join("\n"),
    ).toEqual([]);

    expect(
      CARD_INKS,
      "--text-muted is the faintest token in the house and it alone caps the " +
        "wash at 6%. If this card genuinely needs it, globals.css has to drop " +
        "from 14% and the card goes back to reading white.",
    ).not.toContain("--text-muted");
  });

  it("holds every ink above the floor on the washed card, for any brand colour", () => {
    let worst = { ratio: Infinity, where: "" };

    for (const theme of THEMES) {
      const cardBg = parse(theme.cardBg);
      for (const hex of BAND) {
        const ground = mix(parse(hex), RULE.wash, cardBg);
        for (const name of CARD_INKS) {
          const r = contrast(parse(theme.tokens[name]), ground);
          if (r < worst.ratio) {
            worst = { ratio: r, where: `${theme.name} ${name} on ${hex}` };
          }
        }
      }
    }

    expect(
      worst.ratio,
      `a ${Math.round(RULE.wash * 100)}% wash puts ${worst.where} at ` +
        `${worst.ratio.toFixed(2)}:1, under ${INK_FLOOR}. 15% is the last step ` +
        "that clears it with this ink set; 16% measures 4.73.",
    ).toBeGreaterThanOrEqual(INK_FLOOR);
  });

  it("holds each group's hue above the floor as heading text", () => {
    /*
     * The section hue is used as BOTH the rule and the heading text, which the
     * section-hue rule in globals.css warns against for `--series-N`: a mark
     * tuned to 3:1 is too light to set type in. The status tokens are claimed to
     * be different. This is that claim, measured, against the frame the headings
     * actually sit on rather than against a card.
     */
    expect(SECTION_HUES.length, "no group hues parsed").toBe(3);

    const failures: string[] = [];
    for (const theme of THEMES) {
      for (const hue of SECTION_HUES) {
        const value = theme.tokens[hue];
        expect(value, `${hue} has no measured value in THEMES`).toBeTruthy();
        const r = contrast(parse(value), parse(theme.surfaceApp));
        if (r < INK_FLOOR) {
          failures.push(
            `${theme.name}: ${hue} as heading text is ${r.toFixed(2)}:1 (need ${INK_FLOOR})`,
          );
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("keeps the spine visible on the card it sits on, for any brand colour", () => {
    /*
     * 🔴 The trap this measures: the spine and the card are THE SAME COLOUR, so
     * a spine painted in plain `var(--accent)` eats its own contrast — 2.77:1 at
     * every wash percentage, under the non-text floor, in both themes. Mixing
     * toward `--text-primary` moves it away from the wash in whichever direction
     * the theme runs: darker in light, lighter in dark.
     */
    let worst = { ratio: Infinity, where: "" };

    for (const theme of THEMES) {
      const cardBg = parse(theme.cardBg);
      const textPrimary = parse(theme.tokens["--text-primary"]);
      for (const hex of BAND) {
        const accent = parse(hex);
        const ground = mix(accent, RULE.wash, cardBg);
        const spine = mix(accent, RULE.spine, textPrimary);
        const r = contrast(spine, ground);
        if (r < worst.ratio) {
          worst = { ratio: r, where: `${theme.name} ${hex}` };
        }
      }
    }

    expect(
      worst.ratio,
      `the spine on ${worst.where} is ${worst.ratio.toFixed(2)}:1 against the ` +
        "card it sits on, under the 3:1 non-text floor — it is the same colour " +
        "as the ground and has to be pushed away from it",
    ).toBeGreaterThanOrEqual(MARK_FLOOR);
  });

  it("uses one constant for the spine and .accent-fill, not two", () => {
    /*
     * `.accent-fill` solved this exact problem first — push the accent toward
     * `--text-primary` until it separates from whatever is behind it — and the
     * monogram tile on this card IS an `.accent-fill`. Two independently tuned
     * percentages would drift the moment one of them was adjusted, and the card
     * would wear two slightly different versions of the same colour.
     */
    const from = CSS.indexOf(".accent-fill {");
    expect(from).toBeGreaterThan(-1);
    const body = CSS.slice(from, CSS.indexOf("\n}", from));
    const m = body.match(
      /background:\s*color-mix\(in srgb, var\(--accent\) (\d+)%, var\(--text-primary\)\)/,
    );
    expect(m, ".accent-fill no longer mixes toward --text-primary").not.toBeNull();
    expect(
      Number(m![1]) / 100,
      "the spine and .accent-fill have drifted apart — they are the same " +
        "recipe for the same problem and should move together",
    ).toBe(RULE.spine);
  });
});
