import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 A dialog must not move focus on every render — only when it opens.
 *
 * `Modal` runs an effect that focuses the first field in the panel. If that
 * effect also depends on `onClose` or `busy`, it re-runs on every render of the
 * PARENT, because every call site passes `onClose` as an inline arrow:
 *
 *     <Modal open={open} onClose={() => setOpen(false)} …>
 *
 * A new arrow each render means a changed dependency each render, and a parent
 * re-renders on every keystroke into any field whose state it holds. The
 * observed symptom was precise and bewildering: type ONE character into any
 * field in the Share dialog, and focus jumped to the first tab button. You had
 * to click back into the input for every single letter.
 *
 * Nothing throws, nothing logs, and it is invisible in a screenshot. Hence a
 * test — asserted on the source rather than behaviourally, because this repo
 * has no DOM test environment (`vitest.config.ts` sets `environment: "node"`)
 * and standing one up for one assertion would cost more than it returns.
 *
 * The durable shape is two effects: focus + scroll lock keyed on `[open,
 * mounted]`, and the key handler — which genuinely needs the current `onClose`
 * and `busy` — keyed on all four. Re-subscribing a listener every render is
 * free. Re-running the focus move is not.
 */

const MODAL = join(process.cwd(), "src/components/Modal.tsx");

/**
 * Every `useEffect(callback, deps)` in a file, as its callback body and its
 * dependency array.
 *
 * The deps are the call's SECOND TOP-LEVEL ARGUMENT, found by walking the call
 * with depth tracking and splitting on commas at depth 1 — not "the last `[`
 * in the text". The earlier heuristic could take an array literal from inside
 * the callback as the deps, and it could not say WHICH effect moved focus, so
 * putting the focus call back into the key-handler effect still passed.
 */
function effects(src: string): Array<{ body: string; deps: string[] | null }> {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const out: Array<{ body: string; deps: string[] | null }> = [];
  const re = /\buseEffect\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    const commas: number[] = [];
    let close = -1;
    for (let i = open; i < code.length; i++) {
      const ch = code[i];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) {
        depth--;
        if (depth === 0) { close = i; break; }
      } else if (ch === "," && depth === 1) commas.push(i);
    }
    if (close === -1) continue;
    const firstArgEnd = commas[0] ?? close;
    const body = code.slice(open + 1, firstArgEnd);
    let deps: string[] | null = null;
    if (commas.length) {
      const raw = code.slice(commas[0] + 1, commas[1] ?? close).trim();
      if (raw.startsWith("[") && raw.endsWith("]")) {
        deps = raw.slice(1, -1).split(",").map((d) => d.trim()).filter(Boolean);
      }
    }
    out.push({ body, deps });
  }
  return out;
}

describe("Modal focus management", () => {
  const src = readFileSync(MODAL, "utf8");
  const all = effects(src);
  // The effect that places initial focus: it looks up the first focusable.
  const placing = all.filter((e) => /querySelector<HTMLElement>\(FOCUSABLE\)/.test(e.body));
  // The DIALOG's key handler (the file also holds `useDismissOnEscape`, whose
  // effect adds a keydown listener too — it is identified by the panel ref).
  const keys = all.filter(
    (e) => /addEventListener\(\s*["']keydown["']/.test(e.body) && /panelRef/.test(e.body),
  );

  it("🔴 places initial focus in exactly one effect, keyed ONLY on [open, mounted]", () => {
    expect(placing, "exactly one effect should look up the first focusable").toHaveLength(1);
    expect(
      [...(placing[0].deps ?? ["<no deps array — runs every render>"])].sort(),
      "the focus-placing effect must not depend on onClose/busy: callers pass an " +
        "inline onClose, so any such dependency re-runs it on every keystroke " +
        "in the parent and throws focus to the first field",
    ).toEqual(["mounted", "open"]);
  });

  it("🔴 the key-handler effect never PLACES initial focus", () => {
    /*
     * The key handler must see the current onClose and busy, so it re-runs on
     * every render. It may move focus in response to Tab (the wrap), but the
     * first-field lookup must not live here.
     */
    expect(keys).toHaveLength(1);
    expect(keys[0].body).not.toMatch(/querySelector<HTMLElement>\(FOCUSABLE\)/);
    expect(keys[0].deps).toEqual(expect.arrayContaining(["onClose", "busy"]));
  });

  it("returns focus to the opener when it closes, from the once-per-open effect", () => {
    // Focus return belongs to the effect that captured the opener — if it
    // lived in the per-render effect, every keystroke would bounce focus to
    // the Share button.
    expect(placing[0].body).toContain("opener?.isConnected");
    expect(placing[0].body).toMatch(/opener\.focus\(\)/);
  });
});

/*
 * The call sites, for context rather than enforcement.
 *
 * Every one of these passes an inline `onClose`, which is idiomatic React and
 * should stay allowed — the fix belongs in `Modal`, not in a rule that every
 * caller must remember to `useCallback`.
 */
describe("Modal call sites", () => {
  function tsxFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) tsxFiles(full, acc);
      else if (entry.endsWith(".tsx")) acc.push(full);
    }
    return acc;
  }

  it("still has callers passing an inline onClose, which must remain safe", () => {
    const callers = tsxFiles(join(process.cwd(), "src")).filter((f) => {
      const s = readFileSync(f, "utf8");
      return /<Modal\b/.test(s) && /onClose=\{\(\)\s*=>/.test(s);
    });
    // If this ever reaches zero the guarantee above stopped being exercised,
    // which is worth knowing — not because inline callbacks are required.
    expect(callers.length).toBeGreaterThan(0);
  });
});
