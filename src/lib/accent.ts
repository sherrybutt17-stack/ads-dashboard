/**
 * A stable per-client accent, so a 40-client roster feels bespoke rather than
 * one theme repeated.
 *
 * ── Why this set is violet-adjacent ───────────────────────────────────
 *
 * It used to be blue-adjacent, and the reason given was sound at the time: the
 * primary buttons and the logo mark were blue, so a blue accent differentiated
 * a client's data-identity without fighting the chrome. The redesign moved the
 * chrome to violet, which turned the same argument inside out — a blue "30D"
 * pill beside a violet nav rail reads as two competing accents rather than one
 * house colour and one client colour. These are re-hued into the violet family
 * so a client's colour reads as a variation on the product, not an argument
 * with it. The charts stay blue, and that is fine: a chart series is a
 * different job from an accent and is already labelled.
 *
 * ── The constraint every value here satisfies ─────────────────────────
 *
 * `--accent` is delivered as an INLINE STYLE (see `normalizeBrandColor`'s note
 * on why), so one hex has to survive both themes. Each value below was solved
 * for the best WORST-OF-BOTH contrast at its hue — measured against `#ffffff`
 * and the dark card `#1c1c26`, the same two surfaces `normalizeBrandColor`
 * bands a client's own colour against — landing every one at roughly 4.1:1 on
 * each. That clears the 3:1 `BRAND_MIN_CONTRAST` floor these are used against
 * comfortably.
 *
 * ⚠️ It does NOT clear 4.5:1, and four call sites still paint `--accent` as
 * text. That is the pre-existing tension this file has always had — the
 * theoretical ceiling for "worst of light and dark" is about 4.4:1, so no
 * single hex can be AA body text on white AND legible on near-black. Those four
 * are large or semibold labels rather than body copy. If one ever becomes real
 * running text, the fix is a light/dark PAIR, not a darker hex here.
 *
 * Derived deterministically from the client id — no schema change, and a client
 * keeps the same colour across sessions.
 */

export interface Accent {
  /** The accent hue itself. */
  color: string;
  /** Soft under-glow for the hero tile, as a full box-shadow value. */
  glow: string;
}

const ACCENTS: Accent[] = [
  { color: "#8268e8", glow: "0 12px 40px -10px rgba(130, 104, 232, 0.5)" }, // violet
  { color: "#6a6ff0", glow: "0 12px 40px -10px rgba(106, 111, 240, 0.5)" }, // indigo
  { color: "#9e5ede", glow: "0 12px 40px -10px rgba(158, 94, 222, 0.5)" }, // grape
  { color: "#aa5cc4", glow: "0 12px 40px -10px rgba(170, 92, 196, 0.5)" }, // plum
  { color: "#537dc6", glow: "0 12px 40px -10px rgba(83, 125, 198, 0.5)" }, // azure
  { color: "#328895", glow: "0 12px 40px -10px rgba(50, 136, 149, 0.5)" }, // teal
];

export function accentForClient(seed: string): Accent {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return ACCENTS[h % ACCENTS.length];
}
