/**
 * An agency's own formula metrics — "Cost per booked call = Ad spend ÷
 * Appointments" — as data, never as code.
 *
 * ── Why tokens, and no `eval` ─────────────────────────────────────────
 *
 * A formula is typed by agency staff and run on every board that shows it,
 * including share links anyone can open. Stored as text and evaluated, it
 * would be a way to run code on the server. So a formula is a list of tokens
 * the builder produces by clicking — a stat, a number, an operator, a bracket
 * — and this file parses and evaluates those with its own small grammar.
 * Nothing here ever turns a string into code (`formula.test.ts` checks the
 * source for `eval` and `Function`).
 *
 * ── Why every value is a ratio of sums ────────────────────────────────
 *
 * Operands are evaluated on the bag being drawn — a day, a campaign, a card,
 * or a table's summed total — never averaged over rows. "Ad spend ÷
 * Appointments" for a month is the month's spend over the month's
 * appointments, exactly as the built-in cost per appointment is.
 *
 * Pure, and free of the catalogue (stat ids are plain strings here), so the
 * settings page can parse and preview a formula in the browser.
 */

export type FormulaOp = "+" | "-" | "*" | "/";

export type FormulaToken =
  | { t: "stat"; id: string }
  | { t: "num"; v: number }
  | { t: "op"; v: FormulaOp }
  | { t: "(" }
  | { t: ")" };

export type FormulaNode =
  | { k: "stat"; id: string }
  | { k: "num"; v: number }
  | { k: "bin"; op: FormulaOp; a: FormulaNode; b: FormulaNode };

/** Bounds that keep a formula readable on one line and cheap to evaluate on every row. */
export const FORMULA_LIMITS = {
  tokens: 50,
  operands: 12,
  depth: 6,
  /** Largest number a formula may contain, either sign. */
  number: 1e9,
} as const;

export type ParseResult =
  | { ok: true; node: FormulaNode; stats: string[] }
  | { ok: false; error: string; /** The token the problem is at, for the builder to point to. */ at?: number };

const OP_TEXT: Record<FormulaOp, string> = { "+": "+", "-": "−", "*": "×", "/": "÷" };

/**
 * Tokens → a tree, by recursive descent:
 *
 *     expr    := term   (("+" | "-") term)*
 *     term    := factor (("*" | "/") factor)*
 *     factor  := stat | number | "(" expr ")"
 *
 * so × and ÷ bind tighter than + and −, and left to right within each.
 * Every refusal is a sentence the builder can show as it is.
 */
export function parseFormula(tokens: readonly FormulaToken[]): ParseResult {
  if (tokens.length === 0) return { ok: false, error: "The formula is empty." };
  if (tokens.length > FORMULA_LIMITS.tokens) {
    return { ok: false, error: `A formula can have at most ${FORMULA_LIMITS.tokens} parts.` };
  }
  let operands = 0;
  let depth = 0;
  for (const [i, tok] of tokens.entries()) {
    if (tok.t === "stat" || tok.t === "num") operands++;
    if (tok.t === "num" && (!Number.isFinite(tok.v) || Math.abs(tok.v) > FORMULA_LIMITS.number)) {
      return { ok: false, error: "Numbers must be between −1,000,000,000 and 1,000,000,000.", at: i };
    }
    if (tok.t === "(") {
      depth++;
      if (depth > FORMULA_LIMITS.depth) {
        return { ok: false, error: `Brackets can go at most ${FORMULA_LIMITS.depth} deep.`, at: i };
      }
    }
    if (tok.t === ")") depth = Math.max(0, depth - 1);
  }
  if (operands > FORMULA_LIMITS.operands) {
    return { ok: false, error: `A formula can use at most ${FORMULA_LIMITS.operands} stats and numbers.` };
  }

  let pos = 0;
  const stats = new Set<string>();

  class Refusal {
    constructor(
      readonly error: string,
      readonly at?: number,
    ) {}
  }

  const describe = (tok: FormulaToken | undefined): string =>
    !tok ? "the end" : tok.t === "op" ? `“${OP_TEXT[tok.v]}”` : tok.t === "(" || tok.t === ")" ? `“${tok.t}”` : "a value";

  function factor(): FormulaNode {
    const tok = tokens[pos];
    if (!tok) throw new Refusal("The formula ends where a stat or number should be.", Math.max(0, pos - 1));
    if (tok.t === "stat") {
      pos++;
      stats.add(tok.id);
      return { k: "stat", id: tok.id };
    }
    if (tok.t === "num") {
      pos++;
      return { k: "num", v: tok.v };
    }
    if (tok.t === "(") {
      const open = pos;
      pos++;
      if (tokens[pos]?.t === ")") throw new Refusal("These brackets have nothing in them.", open);
      const inner = expr();
      if (tokens[pos]?.t !== ")") throw new Refusal("This bracket is never closed.", open);
      pos++;
      return inner;
    }
    if (tok.t === ")") throw new Refusal("This bracket closes nothing — or something is missing before it.", pos);
    throw new Refusal(`A stat or number is missing before ${describe(tok)}.`, pos);
  }

  function term(): FormulaNode {
    let node = factor();
    for (let tok = tokens[pos]; tok?.t === "op" && (tok.v === "*" || tok.v === "/"); tok = tokens[pos]) {
      pos++;
      node = { k: "bin", op: tok.v, a: node, b: factor() };
    }
    return node;
  }

  function expr(): FormulaNode {
    let node = term();
    for (let tok = tokens[pos]; tok?.t === "op" && (tok.v === "+" || tok.v === "-"); tok = tokens[pos]) {
      pos++;
      node = { k: "bin", op: tok.v, a: node, b: term() };
    }
    return node;
  }

  try {
    const node = expr();
    if (pos < tokens.length) {
      const tok = tokens[pos];
      throw new Refusal(
        tok.t === ")"
          ? "This bracket closes nothing."
          : `An operator (+ − × ÷) is missing before ${describe(tok)}.`,
        pos,
      );
    }
    return { ok: true, node, stats: [...stats] };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.error, at: err.at };
    throw err;
  }
}

/**
 * A parsed formula's value, given each stat's value on the same row. A stat
 * with no honest value, a division by zero or a result that is not a finite
 * number make the whole formula null — shown as a dash, never as 0.
 */
export function evaluateFormula(node: FormulaNode, value: (id: string) => number | null): number | null {
  switch (node.k) {
    case "num":
      return node.v;
    case "stat": {
      const v = value(node.id);
      return v === null || !Number.isFinite(v) ? null : v;
    }
    case "bin": {
      const a = evaluateFormula(node.a, value);
      if (a === null) return null;
      const b = evaluateFormula(node.b, value);
      if (b === null) return null;
      let r: number;
      switch (node.op) {
        case "+":
          r = a + b;
          break;
        case "-":
          r = a - b;
          break;
        case "*":
          r = a * b;
          break;
        case "/":
          if (b === 0) return null;
          r = a / b;
          break;
      }
      return Number.isFinite(r) ? r : null;
    }
  }
}

/** The formula as a reader sees it: "Ad spend ÷ (Appointments + Showed)". */
export function formulaText(tokens: readonly FormulaToken[], label: (id: string) => string): string {
  const parts: string[] = [];
  for (const tok of tokens) {
    switch (tok.t) {
      case "stat":
        parts.push(label(tok.id));
        break;
      case "num":
        parts.push(tok.v.toLocaleString("en-US", { maximumFractionDigits: 6 }));
        break;
      case "op":
        parts.push(OP_TEXT[tok.v]);
        break;
      case "(":
        parts.push("(");
        break;
      case ")":
        parts.push(")");
        break;
    }
  }
  // No space inside brackets: "(Appointments + Showed)".
  return parts.join(" ").replace(/\( /g, "(").replace(/ \)/g, ")");
}

/** The stats a formula reads, each once, in the order they appear. */
export function formulaStats(tokens: readonly FormulaToken[]): string[] {
  return [...new Set(tokens.flatMap((t) => (t.t === "stat" ? [t.id] : [])))];
}
