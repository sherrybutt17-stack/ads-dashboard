import { accentForClient, type Accent } from "./accent";

/**
 * Per-client branding — the client's own mark on their own report.
 *
 * The job to be done: a med-spa owner forwards the monthly report to their
 * business partner and it reads as *their* document, not their agency's.
 * Everything here follows from that one sentence.
 *
 * 🔴 **Resolved at render time, by reference, never snapshotted.** This is the
 * fix for the most-complained-about behaviour in this category, where changing a
 * theme applies only to reports created *afterwards* and every existing report
 * keeps the old logo forever. A stored copy of the brand at report-creation time
 * is a copy that goes stale; resolving on every render cannot.
 *
 * Two slots, two owners, and the split is by FIELD rather than by a precedence
 * rule — precedence rules are where "whose logo wins" becomes unanswerable:
 *
 *   client end-brand  → logo, display name, colour, contact line   (client-editable in W3)
 *   agency mark       → "Prepared by", login page, client list      (agency only, always)
 */

export interface ClientBranding {
  /** Overrides the client's name on their dashboard and report. */
  displayName: string | null;
  /** A single hex, already normalised into the safe band. Null = use the default. */
  brandColor: string | null;
  /** One line under the agency mark on a report — "Questions? hello@…". */
  reportContactLine: string | null;
  /** True when a wordmark image has been uploaded for this client. */
  hasLogo: boolean;
  /**
   * Bumped on every logo write. Belongs in the asset URL.
   *
   * The logo route is cached immutably — it is an image on every page load — so
   * without a version in the URL a replaced logo keeps serving the old bytes
   * from cache for the full TTL, and the client reasonably concludes their
   * upload silently failed.
   */
  logoVersion: number;
  /**
   * Whether the brand colour reaches the dashboard, or only the report.
   *
   * Agency-controlled. A client's brand red on a dashboard whose status colours
   * are red/amber/green is a legibility problem, not a preference, so this is
   * not the client's switch to flip.
   */
  appliesToDashboard: boolean;
  /**
   * Whether the CLIENT may edit their own branding — W3's per-client switch.
   *
   * 🔴 Defaults to **false**, and that default is the security posture, not a
   * preference. This is the field the client's own write endpoint checks before
   * it will parse a body, so a client whose branding row does not exist yet, or
   * whose row could not be read, must land on "no" rather than on "yes". Every
   * failure path in `getClientBranding` returns `NO_BRANDING`, so a database
   * problem cannot open the door.
   */
  clientEditable: boolean;
}

export const NO_BRANDING: ClientBranding = {
  displayName: null,
  brandColor: null,
  reportContactLine: null,
  hasLogo: false,
  logoVersion: 0,
  appliesToDashboard: true,
  // Fail closed. See the field's comment.
  clientEditable: false,
};

/*
 * `AgencyMarkMode` lives on the schema's own enum rather than being restated
 * here — two hand-kept copies of the same union is how one of them silently
 * drifts when a fourth mode is added.
 */

/* ------------------------------------------------------------------ *
 * Colour normalisation
 * ------------------------------------------------------------------ */

/**
 * A client's brand colour, forced into a band that works on BOTH surfaces.
 *
 * The design this replaces used a `.brand-scope` CSS class. That is dead on
 * arrival here: the dashboard sets `--accent` as an **inline style** on the very
 * same wrapper element, and an inline style beats every selector regardless of
 * specificity. So the colour has to arrive as a value, not as a rule — one hex,
 * substituted into the same inline style the accent already uses.
 *
 * Why a band rather than the literal hex: `--accent` is painted on both the
 * light and the dark theme, and a colour chosen against white is frequently
 * illegible on `#0a0b0f` (navy, maroon) while one chosen against black washes
 * out on white (pale yellow, mint). Clamping lightness into the middle keeps a
 * recognisable hue on both without asking the client for two colours — which
 * they would not have.
 *
 * Returns null for anything unparseable, so the caller falls back to the
 * generated accent rather than emitting `background: undefined`.
 */
export function normalizeBrandColor(input: string | null | undefined): string | null {
  const rgb = parseHex(input);
  if (!rgb) return null;

  const { h, s, l } = rgbToHsl(rgb);

  /*
   * A near-grey brand (s < 0.12) keeps its saturation. Pushing it up to hit a
   * target would invent a colour the client never chose — a charcoal brand
   * would come back teal.
   */
  const saturation = s < 0.12 ? s : clamp(s, 0.35, 0.85);

  /*
   * 🔴 Search on MEASURED CONTRAST, not on HSL lightness.
   *
   * Clamping lightness into a band is the obvious approach and it is wrong,
   * which a test caught: HSL lightness is not perceptual luminance, and the two
   * diverge most exactly where it matters. Pale yellow `#fdf6b2` sits at the top
   * of any reasonable lightness band and still measures **1.29:1 on white** —
   * invisible. Blue at the identical lightness measures fine. A band tuned to
   * pass yellow would then crush every blue into mud.
   *
   * So this scans lightness and scores each candidate on the thing that actually
   * matters: the WORSE of its two contrasts, against white and against the dark
   * surface. It takes the candidate closest to the client's own lightness that
   * clears the target — nudging the colour as little as the constraint allows —
   * and if the hue cannot clear it at any lightness, the best available rather
   * than a failure.
   */
  let best: { hex: string; score: number } | null = null;
  let chosen: { hex: string; distance: number } | null = null;

  for (let candidate = 0.12; candidate <= 0.9; candidate += 0.01) {
    const hex = hslToHex({ h, s: saturation, l: candidate });
    const onLight = contrastRatio(hex, SURFACE_LIGHT) ?? 0;
    const onDark = contrastRatio(hex, SURFACE_DARK) ?? 0;
    const score = Math.min(onLight, onDark);

    if (!best || score > best.score) best = { hex, score };

    if (score >= BRAND_MIN_CONTRAST) {
      const distance = Math.abs(candidate - l);
      if (!chosen || distance < chosen.distance) chosen = { hex, distance };
    }
  }

  return chosen?.hex ?? best?.hex ?? null;
}

/**
 * The contrast a brand colour must clear on BOTH surfaces.
 *
 * 3:1 is WCAG 2.1's threshold for large text and non-text UI components, which
 * is exactly how the accent is used — a mark, a tile glow, a bar, never body
 * copy. The theoretical ceiling for "worst of light and dark" is about 4.4:1
 * (achieved at relative luminance ≈ 0.19), so 3:1 leaves room for most hues
 * while still rejecting the genuinely illegible.
 */
export const BRAND_MIN_CONTRAST = 3;

/** True when the input is a hex colour we can work with at all. */
export function isValidHexColor(input: string | null | undefined): boolean {
  return parseHex(input) !== null;
}

/**
 * The accent to render for a client: their brand colour, or the generated one.
 *
 * Unconfigured falls back to `accentForClient`, pixel-identical to today — so
 * shipping this changes nothing for any client who has not set a colour.
 */
export function accentFor(clientId: string, branding: ClientBranding): Accent {
  if (!branding.brandColor || !branding.appliesToDashboard) {
    return accentForClient(clientId);
  }
  const rgb = parseHex(branding.brandColor);
  if (!rgb) return accentForClient(clientId);
  return {
    color: branding.brandColor,
    // Matched to the generated accents' glow shape so a branded client's hero
    // tile sits at the same visual weight as an unbranded one.
    glow: `0 12px 40px -10px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`,
  };
}

/* ------------------------------------------------------------------ *
 * Colour maths — small, local, and tested rather than a dependency
 * ------------------------------------------------------------------ */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(input: string | null | undefined): Rgb | null {
  if (typeof input !== "string") return null;
  const s = input.trim().replace(/^#/, "");
  // 3-digit shorthand is common in brand guidelines; expand rather than reject.
  const full =
    s.length === 3
      ? s
          .split("")
          .map((c) => c + c)
          .join("")
      : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hslToHex({ h, s, l }: { h: number; s: number; l: number }): string {
  if (s === 0) {
    const v = Math.round(l * 255);
    return `#${[v, v, v].map(toHex).join("")}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToRgb(p, q, h + 1 / 3);
  const g = hueToRgb(p, q, h);
  const b = hueToRgb(p, q, h - 1 / 3);
  return `#${[r, g, b].map((v) => toHex(Math.round(v * 255))).join("")}`;
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function toHex(v: number): string {
  return v.toString(16).padStart(2, "0");
}

/* ------------------------------------------------------------------ *
 * Contrast — measured, not eyeballed
 * ------------------------------------------------------------------ */

/** Relative luminance per WCAG 2.1. */
export function luminance({ r, g, b }: Rgb): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrastRatio(a: string, b: string): number | null {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return null;
  const la = luminance(ra);
  const lb = luminance(rb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The two page backgrounds a brand colour has to survive. */
export const SURFACE_LIGHT = "#ffffff";
export const SURFACE_DARK = "#0a0b0f";
