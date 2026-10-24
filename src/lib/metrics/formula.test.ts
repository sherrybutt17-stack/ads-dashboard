import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORMULA_LIMITS,
  evaluateFormula,
  formulaStats,
  formulaText,
  parseFormula,
  type FormulaToken,
} from "./formula";

/**
 * Formula metrics: the grammar, the arithmetic rules, and the promise that a
 * formula is never run as code.
 */

const s = (id: string): FormulaToken => ({ t: "stat", id });
const n = (v: number): FormulaToken => ({ t: "num", v });
const op = (v: "+" | "-" | "*" | "/"): FormulaToken => ({ t: "op", v });
const open: FormulaToken = { t: "(" };
const close: FormulaToken = { t: ")" };

const values: Record<string, number | null> = { spend: 600, appointments: 4, showed: 2, leads: 0, reach: null };
const run = (tokens: FormulaToken[]) => {
  const p = parseFormula(tokens);
  if (!p.ok) throw new Error(p.error);
  return evaluateFormula(p.node, (id) => values[id] ?? null);
};

describe("parseFormula", () => {
  it("binds × and ÷ tighter than + and −, left to right", () => {
    // 600 − 4 × 2 = 592, not 1,192.
    expect(run([s("spend"), op("-"), s("appointments"), op("*"), s("showed")])).toBe(592);
    // 600 ÷ 4 ÷ 2 = 75, not 300.
    expect(run([s("spend"), op("/"), s("appointments"), op("/"), s("showed")])).toBe(75);
  });

  it("lets brackets change the order", () => {
    // 600 ÷ (4 + 2) = 100.
    expect(run([s("spend"), op("/"), open, s("appointments"), op("+"), s("showed"), close])).toBe(100);
  });

  it("lists the stats a formula reads, each once", () => {
    const p = parseFormula([s("spend"), op("/"), open, s("appointments"), op("+"), s("appointments"), close]);
    expect(p.ok && p.stats).toEqual(["spend", "appointments"]);
    expect(formulaStats([s("a"), op("+"), s("b"), op("+"), s("a")])).toEqual(["a", "b"]);
  });

  it.each([
    [[], /empty/],
    [[s("spend"), op("+")], /ends where a stat or number should be/],
    [[op("+"), s("spend")], /missing before “\+”/],
    [[s("spend"), s("leads")], /operator .* is missing/],
    [[open, s("spend")], /never closed/],
    [[s("spend"), close], /closes nothing/],
    [[open, close], /nothing in them/],
    [[s("spend"), op("/"), close], /closes nothing/],
  ] as Array<[FormulaToken[], RegExp]>)("refuses a malformed formula in words: %j", (tokens, error) => {
    const p = parseFormula(tokens);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toMatch(error);
  });

  it("points at the part that is wrong", () => {
    const p = parseFormula([s("spend"), op("/"), open, s("leads")]);
    expect(p.ok === false && p.at).toBe(2);
  });

  it("keeps a formula within its limits", () => {
    const long = Array.from({ length: FORMULA_LIMITS.tokens + 1 }, (_, i) => (i % 2 ? op("+") : n(1)));
    expect(parseFormula(long)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 50 parts/) });

    const many = Array.from({ length: FORMULA_LIMITS.operands + 1 }, () => n(1)).flatMap((t, i) => (i ? [op("+"), t] : [t]));
    expect(parseFormula(many)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 12 stats and numbers/) });

    const deep = [...Array(FORMULA_LIMITS.depth + 1).fill(open), n(1), ...Array(FORMULA_LIMITS.depth + 1).fill(close)];
    expect(parseFormula(deep)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 6 deep/) });

    expect(parseFormula([n(2e9)])).toMatchObject({ ok: false, error: expect.stringMatching(/between/) });
    expect(parseFormula([n(Number.NaN)])).toMatchObject({ ok: false });
    expect(parseFormula([n(Number.POSITIVE_INFINITY)])).toMatchObject({ ok: false });
  });
});

describe("evaluateFormula", () => {
  it("🔴 gives no value for a division by zero — a dash, never Infinity or 0", () => {
    expect(run([s("spend"), op("/"), s("leads")])).toBeNull();
    expect(run([n(1), op("/"), open, s("appointments"), op("-"), n(4), close])).toBeNull();
  });

  it("gives no value when a stat it reads has none", () => {
    expect(run([s("reach"), op("+"), n(1)])).toBeNull();
    expect(run([s("unknown_stat"), op("*"), n(2)])).toBeNull();
  });

  it("does plain arithmetic with numbers", () => {
    expect(run([s("appointments"), op("/"), s("showed"), op("*"), n(100)])).toBe(200);
    expect(run([n(-3), op("+"), n(0.5)])).toBe(-2.5);
  });
});

describe("formulaText", () => {
  it("reads the way the builder shows it", () => {
    const label = (id: string) => ({ spend: "Ad spend", appointments: "Appointments", showed: "Showed" })[id] ?? id;
    expect(formulaText([s("spend"), op("/"), open, s("appointments"), op("+"), s("showed"), close], label)).toBe(
      "Ad spend ÷ (Appointments + Showed)",
    );
    expect(formulaText([s("spend"), op("*"), n(1000), op("-"), n(2.5)], label)).toBe("Ad spend × 1,000 − 2.5");
  });
});

describe("🔴 a formula is never code", () => {
  it("has no eval or Function constructor anywhere in the formula engine", () => {
    const src = readFileSync(join(__dirname, "formula.ts"), "utf8")
      // The header explains why eval is absent; only code counts.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/\bnew\s+Function\b|\bFunction\s*\(/);
  });
});
