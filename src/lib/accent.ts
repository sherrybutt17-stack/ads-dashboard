/**
 * A stable per-client accent, so a 40-client roster feels bespoke rather than
 * one theme repeated.
 *
 * Deliberately drawn from a COOL, blue-adjacent set: the funnel ramp, the
 * primary buttons, and the chart series are all blue, so an accent from the
 * same family differentiates a client's data-identity (their hero tile, mark,
 * and heatmap glow in their colour) without clashing with the fixed brand blue
 * of the actions. Derived deterministically from the client id — no schema
 * change, and a client keeps the same colour across sessions.
 */

export interface Accent {
  /** The accent hue itself. */
  color: string;
  /** Soft under-glow for the hero tile, as a full box-shadow value. */
  glow: string;
}

const ACCENTS: Accent[] = [
  { color: "#3987e5", glow: "0 12px 40px -10px rgba(57, 135, 229, 0.5)" }, // blue
  { color: "#6a74f0", glow: "0 12px 40px -10px rgba(106, 116, 240, 0.5)" }, // indigo
  { color: "#8b7cf0", glow: "0 12px 40px -10px rgba(139, 124, 240, 0.5)" }, // violet
  { color: "#2aa9b8", glow: "0 12px 40px -10px rgba(42, 169, 184, 0.5)" }, // teal
  { color: "#3f9fe0", glow: "0 12px 40px -10px rgba(63, 159, 224, 0.5)" }, // sky
  { color: "#5b8def", glow: "0 12px 40px -10px rgba(91, 141, 239, 0.5)" }, // azure
];

export function accentForClient(seed: string): Accent {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return ACCENTS[h % ACCENTS.length];
}
