import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 Section wayfinding is only wayfinding if it is applied to ALL of them.
 *
 * Each dashboard section owns a hue: a 3px rule before its heading and the
 * heading itself, so a reader scrolling twenty-nine sections can tell where
 * they are without reading. The hue travels as inherited custom properties
 * (`--section-band`, `--section-ink`) set on a wrapper in c/[slug]/page.tsx, so
 * no section component knows it has a colour — it just has to READ the token.
 *
 * Which means a heading that forgets to read it is not an error anywhere. The
 * rule still paints, because the rule comes from CSS; only the text stays the
 * default ink. What ships is a section with an amber bar next to a near-black
 * heading, next to sections where both are amber. It reads as a rendering
 * glitch, and three of them shipped exactly that way: BudgetPacing,
 * BudgetSettings and SpeedToLead set their colour through a Tailwind class
 * (`text-[var(--text-primary)]`) or a muted eyebrow token rather than the
 * inline `style` the conversion sweep had grepped for. A sweep finds what it
 * greps for. This finds what it misses.
 */

const SRC = join(__dirname, "..", "..");

/**
 * Headings that legitimately do NOT take the section ink, each with the reason.
 *
 * Keep this list short and specific. An entry here is a heading that would be
 * WRONG in the section hue, not one nobody got around to.
 */
const EXEMPT: Record<string, string> = {
  "app/page.tsx:No clients yet":
    "Sits inside `card-hero`, a dark hero card whose copy is deliberately " +
    "white-on-dark. Section ink is tuned against --surface-1 and --surface-2, " +
    "so a light-theme value here would be dark ink on a dark ground.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(entry)) out.push(p);
  }
  return out;
}

/** Every `<h2 ...>` opening tag in the tree, with the text that follows it. */
function headings(): { file: string; line: number; tag: string; label: string }[] {
  const out: { file: string; line: number; tag: string; label: string }[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/<h2\b/g)) {
      // Scan to the tag's own `>`, stepping over any `{...}` JSX expression —
      // a className with a ternary contains `>` inside braces.
      let depth = 0;
      let i = m.index!;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        else if (src[i] === ">" && depth === 0) break;
      }
      const tag = src.slice(m.index!, i + 1);
      const label = (src.slice(i + 1, i + 200).match(/[A-Za-z][A-Za-z ']{3,}/) ?? [""])[0].trim();
      out.push({
        file: file.slice(SRC.length + 1),
        line: src.slice(0, m.index).split("\n").length,
        tag,
        label,
      });
    }
  }
  return out;
}

const REGISTRY_FILE = readFileSync(join(__dirname, "registry.ts"), "utf8");

/**
 * 🔴 Scoped to the SECTIONS array, not the whole file.
 *
 * The scans below match `id:` and `hue:` at four spaces of indentation, which
 * is a fact about how the sections are formatted rather than about what they
 * are. `SECTION_GROUPS` sits above them in the same file and also has `id:`
 * fields — and whether one of its entries lands at four spaces depends on
 * nothing but whether its blurb was long enough for the formatter to wrap the
 * object. Adding a tab with a wordy blurb was enough to make this file report
 * three extra "sections" with no hue, which is a failure that names the wrong
 * defect and sends the next reader into the hue table.
 */
const SECTIONS_AT = REGISTRY_FILE.indexOf("export const SECTIONS");
if (SECTIONS_AT < 0) {
  // Thrown, not expected: this runs at module scope, where `expect` is not in a
  // test and a silent slice from -1 would scan the file backwards.
  throw new Error("registry.ts no longer declares SECTIONS");
}
const REGISTRY = REGISTRY_FILE.slice(SECTIONS_AT);
const PAGE = readFileSync(join(SRC, "app", "c", "[slug]", "page.tsx"), "utf8");

/**
 * The `tabSections.map(...)` call that RENDERS the sections, as source text.
 *
 * Chosen by what it contains rather than by position. `tabSections.map` is also
 * called higher up to build a Set of visible ids, and anchoring on the first —
 * or on a bare `indexOf` — measured that one instead: a wrapper moved outside
 * the render map still sat after the id-Set call, so the check passed on
 * exactly the regression it exists to catch.
 */
function renderMap(): string {
  for (const m of PAGE.matchAll(/tabSections\.map\(/g)) {
    const open = PAGE.indexOf("(", m.index! + "tabSections.map".length - 1);
    let depth = 0;
    for (let i = open; i < PAGE.length; i++) {
      if (PAGE[i] === "(") depth++;
      else if (PAGE[i] === ")" && --depth === 0) {
        const body = PAGE.slice(open, i + 1);
        if (body.includes("renderSection")) return body;
        break;
      }
    }
  }
  throw new Error("no tabSections.map call renders the sections");
}

describe("section hues", () => {
  it("finds the registry, the wrapper and a realistic number of headings", () => {
    // Anti-rot: a broken walker makes every assertion below vacuous.
    const h = headings();
    expect(h.length).toBeGreaterThan(30);
    expect(REGISTRY.length).toBeGreaterThan(1000);
    expect(PAGE).toContain("section-band");
  });

  it("🔴 every section heading reads the section ink", () => {
    const bare = headings()
      .filter((h) => !h.tag.includes("--section-ink"))
      .filter((h) => !(`${h.file}:${h.label}` in EXEMPT));

    expect(
      bare,
      "these <h2>s paint in a fixed ink, so their section's rule is coloured " +
        "and their heading is not. Read `var(--section-ink, <the ink it uses " +
        "today>)` — the fallback keeps every non-section heading identical:\n" +
        bare.map((h) => `  ${h.file}:${h.line}  ${h.label}`).join("\n"),
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption that no longer matches anything is a comment pretending to
    // be a rule, and the next person reads it as one.
    const live = new Set(headings().map((h) => `${h.file}:${h.label}`));
    const stale = Object.keys(EXEMPT).filter((k) => !live.has(k));
    expect(stale, `no such heading any more: ${stale.join(", ")}`).toEqual([]);
  });

  it("🔴 assigns a hue to every section", () => {
    /*
     * `SectionDef.hue` is required, so tsc catches a section added without one
     * — but only while the field stays required. This also holds the COUNT, so
     * a `hue?:` made optional in a hurry does not quietly strand sections at no
     * colour at all.
     */
    const ids = [...REGISTRY.matchAll(/^\s{4}id:\s*"([a-z_]+)"/gm)].map((m) => m[1]);
    const hues = [...REGISTRY.matchAll(/^\s{4}hue:\s*(\d)/gm)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(20);
    expect(hues.length, `${ids.length} sections but ${hues.length} hues`).toBe(ids.length);
  });

  it("🔴 never assigns red to a section", () => {
    /*
     * `--series-8` is red, and red is a status colour here. A red section
     * heading reads as "this section is broken" on a section that is fine, and
     * it reads that way most strongly on the sections most likely to carry a
     * genuine alarm.
     */
    const hues = [...REGISTRY.matchAll(/^\s{4}hue:\s*(\d)/gm)].map((m) => Number(m[1]));
    expect(hues.filter((h) => h === 8), "red is reserved for status").toEqual([]);
    expect(new Set(hues).size, "the palette collapsed to one or two hues").toBeGreaterThan(4);
  });

  it("🔴 wraps each section individually, not the whole list", () => {
    /*
     * The entrance stagger in globals.css targets `main > *:nth-child(n)`. One
     * wrapper around the map would collapse every section onto a single delay;
     * one wrapper PER section keeps the child indices 1:1 and the stagger
     * intact. Both spellings deliver the hue, so nothing about the colour
     * breaks if this regresses — only the animation, silently.
     */
    const map = renderMap();
    // Matched on the full attribute, not the bare word: `"--section-band"` is
    // the custom PROPERTY and appears a few lines below inside the style
    // object, so a looser match finds that one wherever the wrapper sits.
    expect(PAGE, "the per-section wrapper is gone").toContain('className="section-band"');
    expect(
      map.includes('className="section-band"'),
      "`.section-band` is not inside the render map, so it wraps the whole " +
        "list rather than each section — that flattens the entrance stagger",
    ).toBe(true);
    expect(map).toMatch(/key=\{s\.id\}/);
    expect(map).toMatch(/"--section-band":\s*`var\(--series-\$\{s\.hue\}\)`/);
    expect(map).toMatch(/"--section-ink":\s*`var\(--series-\$\{s\.hue\}-ink\)`/);
  });
});
