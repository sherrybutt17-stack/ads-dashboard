/**
 * The four framings, as plain data.
 *
 * Split out of `summary.ts` because that module imports the Anthropic SDK at
 * module scope, and the framing selector is a `"use client"` component. Importing
 * the labels from `summary.ts` would drag the whole SDK — and, through the store,
 * the database client — into the browser bundle.
 *
 * The same reason `annotations.ts` is split from `queries.ts` and `pipe-state.ts`
 * from `pipe-status.ts`: constants that both sides need live where neither side's
 * dependencies do.
 */

export const FRAMINGS = ["summary", "wins", "issues", "recommendations"] as const;
export type Framing = (typeof FRAMINGS)[number];

export const FRAMING_LABEL: Record<Framing, string> = {
  summary: "Summary",
  wins: "Wins",
  issues: "Issues",
  recommendations: "Recommendations",
};

export const FRAMING_HINT: Record<Framing, string> = {
  summary: "A neutral account of what the period did.",
  wins: "What went well, without inflating it.",
  issues: "What needs attention, without alarming.",
  recommendations: "What to do next, and why.",
};
