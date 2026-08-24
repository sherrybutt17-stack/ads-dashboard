import type { AllowedFigure, FigureKind } from "./brief";

/**
 * Every number in the generated prose, checked against the numbers the metrics
 * engine actually produced.
 *
 * 🔴 **This is the load-bearing part of the AI summary.** A weekly summary is
 * the artefact most likely to be forwarded to a client unread, and a language
 * model writing about advertising performance will produce a confident,
 * plausible, entirely invented figure — "cost per lead improved to $38" for an
 * account whose cost per lead is $61. No prompt reliably prevents that. The only
 * durable defence is to check afterwards, with arithmetic.
 *
 * Pure, so the rule can be tested exhaustively without a model call.
 *
 * ---
 *
 * FOUR RULES, EACH LEARNED FROM A WAY THIS GOES WRONG
 *
 * **1 · A currency or percent marker NARROWS what a token may match; its
 * absence does not.** "$2,847" may only match a money figure. "12%" may only
 * match a percentage. A bare "12" may match anything, because prose legitimately
 * writes "12 leads" and "spend was 2847". Without the narrowing, a model could
 * write "conversion was 12%" for an account whose conversion is 40% and pass,
 * because 12 happened to be the lead count.
 *
 * **2 · Rounding is allowed; re-scaling is not.** A person writing "$2,847"
 * for $2,847.32 is being readable. A model writing "about $2,800" has changed
 * the number by $47, and a client who reconciles against Ads Manager finds a
 * discrepancy. A token matches if it equals the figure rounded to 0, 1 or 2
 * decimal places, or sits within 0.5% of it — nothing looser.
 *
 * **3 · Dates are not figures.** "Aug 10", "2026", "Jul 14 – Aug 12" carry
 * numbers that describe time, not performance, and checking them against spend
 * would flag every correct summary ever written.
 *
 * **4 · Flag, never silently pass.** The result is a list, not a boolean
 * verdict imposed on the operator. A human editing the draft may legitimately
 * add a figure this system has never heard of — hours worked, a competitor's
 * price. What must never happen is a number reaching a client with nobody
 * having seen it.
 */

export interface FigureIssue {
  /** As written in the prose, e.g. "$3,120". */
  token: string;
  value: number;
  kind: FigureKind | "any";
  /** The closest figure we DO hold, when there is a near miss worth naming. */
  nearest: { value: number; label: string } | null;
}

export interface VerifyResult {
  ok: boolean;
  /** Numbers in the text that trace to nothing the engine produced. */
  issues: FigureIssue[];
  /** How many numeric tokens were examined. Zero means nothing was checked. */
  checked: number;
}

/** Within half a percent, or equal at 0/1/2 decimal places. */
export function figureMatches(written: number, actual: number): boolean {
  if (!Number.isFinite(written) || !Number.isFinite(actual)) return false;
  if (written === actual) return true;

  // Rounding, the way a person writes a number they are reading off a screen.
  for (const dp of [0, 1, 2]) {
    const f = 10 ** dp;
    if (Math.round(actual * f) / f === written) return true;
  }

  /*
   * A relative tolerance as well, so a figure written to more precision than we
   * rounded still passes. Deliberately tight: 0.5% of $2,847 is $14, which
   * admits "$2,850" and rejects "$2,800". The second is the one that turns into
   * a question in a client meeting.
   */
  if (actual === 0) return Math.abs(written) < 0.005;
  return Math.abs(written - actual) / Math.abs(actual) <= 0.005;
}

/**
 * Spans that describe time rather than performance, blanked before scanning.
 *
 * Blanked rather than deleted only so a removed span can never fuse the digits
 * on either side of it into one token that was never written. It costs nothing
 * and rules out a whole class of surprise; it is not load-bearing beyond that.
 */
/*
 * ⚠️ Order is load-bearing: longest, most specific pattern first.
 *
 * The bare-year rule matches inside an ISO date, so listing it earlier blanks
 * `2026` out of `2026-08-10` and leaves `-08-10` behind — which then scans as
 * the figures −8 and 10 and flags a correct sentence. Caught by the test, and
 * the kind of thing that would otherwise read as "the validator is flaky".
 */
const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  // "Aug 10", "Aug 10–12", "10 Aug", "Jul 14 – Aug 12"
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s*\d{1,2}(\s*[–—-]\s*\d{1,2})?\b/gi,
  /\b\d{1,2}\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/gi,
  // Clock times, which appear in speed-to-lead prose.
  /\b\d{1,2}:\d{2}\s*(am|pm)?\b/gi,
  /\b(19|20)\d{2}\b/g,
];

/** Markdown list numbering — "1." at the start of a line is not a datum. */
const LIST_MARKER = /^([ \t]*)\d+[.)](\s)/gm;

function blankNonFigures(text: string): string {
  let out = text.replace(LIST_MARKER, (_m, indent: string, space: string) => `${indent} ${space}`);
  for (const re of DATE_PATTERNS) {
    out = out.replace(re, (m) => " ".repeat(m.length));
  }
  return out;
}

/**
 * A number with whatever marker surrounds it.
 *
 * The leading symbol and trailing `%`/`×` are captured because they are what
 * decide which kind of figure the token may match.
 */
const FIGURE = /([$£€]\s?)?(-?\d[\d,]*(?:\.\d+)?)\s*(%|×|x\b)?/g;

export function verifyFigures(
  text: string,
  allowed: readonly AllowedFigure[],
): VerifyResult {
  const scannable = blankNonFigures(text);
  const issues: FigureIssue[] = [];
  let checked = 0;

  for (const m of scannable.matchAll(FIGURE)) {
    const [, currency, digits, suffix] = m;
    const value = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    checked++;

    /*
     * Rule 1 — the marker narrows. A bare number is `any` and may match a
     * figure of any kind, because "12 leads" and "spend was 2847" are both
     * ordinary English.
     */
    const kind: FigureKind | "any" = currency
      ? "money"
      : suffix === "%"
        ? "percent"
        : suffix
          ? "multiple"
          : "any";

    const candidates = kind === "any" ? allowed : allowed.filter((a) => a.kind === kind);
    if (candidates.some((a) => figureMatches(value, a.value))) continue;

    issues.push({
      token: m[0].trim(),
      value,
      kind,
      nearest: nearestOf(value, candidates),
    });
  }

  return { ok: issues.length === 0, issues, checked };
}

/**
 * The closest figure of the same kind, when one is close enough to be worth
 * naming in the flag.
 *
 * Exists because "we do not recognise 3,120" is much less useful to an operator
 * than "we do not recognise 3,120; the closest figure we hold is 3,102 (ad
 * spend)". The first reads as a false alarm; the second shows the transcription
 * error it usually is.
 */
function nearestOf(
  value: number,
  candidates: readonly AllowedFigure[],
): { value: number; label: string } | null {
  let best: AllowedFigure | null = null;
  let bestGap = Infinity;
  for (const a of candidates) {
    const gap = Math.abs(a.value - value);
    if (gap < bestGap) {
      bestGap = gap;
      best = a;
    }
  }
  if (!best) return null;
  // Only worth naming if it is plausibly the same number mistyped.
  const scale = Math.max(Math.abs(best.value), Math.abs(value), 1);
  return bestGap / scale <= 0.25 ? { value: best.value, label: best.label } : null;
}

/**
 * A sentence a person can act on, for the flag shown above the draft.
 *
 * Written for the operator rather than the developer: it names what was
 * written, what we hold, and what to do — because the reader of this message is
 * about to decide whether to send the text to a client.
 */
export function describeIssues(result: VerifyResult): string | null {
  if (result.ok) return null;
  const parts = result.issues.slice(0, 5).map((i) =>
    i.nearest
      ? `${i.token} (closest figure we hold is ${i.nearest.value} — ${i.nearest.label})`
      : i.token,
  );
  const more = result.issues.length > 5 ? ` and ${result.issues.length - 5} more` : "";
  return `${result.issues.length} figure${result.issues.length === 1 ? "" : "s"} in this draft ${
    result.issues.length === 1 ? "does" : "do"
  } not match anything the dashboard computed: ${parts.join("; ")}${more}. Check each before sending.`;
}
