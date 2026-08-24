import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 Every custom property referenced WITHOUT a fallback must be declared.
 *
 * This exists because six of them were not, silently, across nine call sites —
 * and an undefined custom property is the quietest possible UI bug. CSS does not
 * warn: the declaration is simply invalid at computed-value time. What that
 * looks like depends on the property, which is why none of it was caught:
 *
 *   --accent-ink   `color` INHERITS, so white button labels became near-black
 *                  text on a blue button — readable enough to look deliberate.
 *   --brand        `background` falls to transparent, so a `text-white` button
 *                  rendered as white text on the page. Invisible.
 *   --surface-0    present mode's page background AND the colour-mix that builds
 *                  its modal scrim — an invalid colour-mix invalidates the whole
 *                  declaration, so the scrim did not render at all.
 *   --seq-200      a bar's fill, so the bar drew with no fill — a chart silently
 *                  not showing its data.
 *   --shadow-sm    an active-state lift that simply never appeared.
 *   --status-warn  amber warnings inheriting body colour, so a caution read as
 *                  ordinary prose. The declared name was --status-warning.
 *
 * None throw, none fail a build, and none look broken enough in a screenshot to
 * investigate. A test is the only thing that catches this class.
 *
 * `var(--x, fallback)` is deliberately NOT flagged — a fallback is the supported
 * way to reference a property injected at runtime, and five of the six --brand
 * sites use it correctly. Only the bare reference is a defect.
 */

const SRC = join(__dirname, "..");
const GLOBALS = join(__dirname, "globals.css");

/**
 * Declared somewhere other than the stylesheet.
 *
 * `--font-geist-*` are injected on <html> by next/font; `--accent`/`--accent-glow`
 * are written onto a style object per client so each dashboard carries its own
 * accent (see `lib/accent.ts`).
 */
const RUNTIME_DECLARED = new Set([
  "--font-geist-sans",
  "--font-geist-mono",
  "--accent",
  "--accent-glow",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    // This file quotes property names in prose; scanning it would flag itself.
    else if (/\.(tsx?|css)$/.test(entry) && entry !== "css-vars.test.ts") out.push(p);
  }
  return out;
}

const globals = readFileSync(GLOBALS, "utf8");
const files = walk(SRC);

/** Names declared anywhere in globals.css, in any theme scope. */
const declared = new Set(
  [...globals.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]),
);

/** Names declared inline in a style object, e.g. `"--accent": accent.color`. */
const inlineDeclared = new Set<string>();
for (const f of files) {
  for (const m of readFileSync(f, "utf8").matchAll(/["'](--[a-zA-Z0-9-]+)["']\s*:/g)) {
    inlineDeclared.add(m[1]);
  }
}

interface Ref {
  name: string;
  file: string;
  line: number;
}

/** Bare `var(--x)` references only — `var(--x, fallback)` is safe by design. */
const bareRefs: Ref[] = [];
let totalRefs = 0;
for (const f of files) {
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((text, i) => {
      for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
        totalRefs++;
        if (m[2] === ")") {
          bareRefs.push({ name: m[1], file: f.slice(SRC.length + 1), line: i + 1 });
        }
      }
    });
}

describe("CSS custom properties", () => {
  it("finds the stylesheet and a realistic number of references", () => {
    // Anti-rot: a broken walker or regex would make every assertion below
    // vacuously true, which is worse than having no test.
    expect(declared.size).toBeGreaterThan(30);
    expect(totalRefs).toBeGreaterThan(100);
    expect(bareRefs.length).toBeGreaterThan(50);
  });

  it("🔴 every bare var() reference resolves to a declared property", () => {
    const known = new Set([...declared, ...inlineDeclared, ...RUNTIME_DECLARED]);
    const missing = bareRefs.filter((r) => !known.has(r.name));

    expect(
      missing,
      missing.length === 0
        ? ""
        : `Undefined CSS custom properties. Either declare them in ` +
            `src/app/globals.css (in EVERY theme scope), correct the name, or — ` +
            `if the value is injected at runtime — give the reference an ` +
            `explicit fallback, e.g. var(--brand, var(--series-1)):\n` +
            missing.map((r) => `  ${r.name}  ←  ${r.file}:${r.line}`).join("\n"),
    ).toEqual([]);
  });

  it("🔴 the two dark scopes do not drift apart", () => {
    /*
     * Dark is declared TWICE — once under `prefers-color-scheme` for the OS
     * setting, once under `[data-theme="dark"]` for the in-app toggle — and the
     * two are maintained by hand. A property added to one and forgotten in the
     * other produces a bug visible only to users whose OS theme and app toggle
     * disagree, which is nobody testing it.
     *
     * This asserts they hold the same KEYS. It deliberately does not assert the
     * same values: print legitimately re-tunes the palette for paper, and the
     * two dark scopes could in principle differ too.
     */
    const mediaStart = globals.indexOf("@media (prefers-color-scheme: dark)");
    const toggleStart = globals.indexOf(':root[data-theme="dark"]');
    /*
     * The toggle block ends at `@theme inline`, Tailwind v4's token-mapping
     * block. Slicing to @media print instead would sweep its `--color-*`
     * aliases into the comparison and report drift that is not there.
     */
    const toggleEnd = globals.indexOf("@theme inline", toggleStart);
    const printStart = globals.indexOf("@media print");
    expect(mediaStart).toBeGreaterThan(0);
    expect(toggleStart).toBeGreaterThan(mediaStart);
    expect(toggleEnd).toBeGreaterThan(toggleStart);
    expect(printStart).toBeGreaterThan(toggleEnd);

    const keysIn = (text: string) =>
      new Set([...text.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]));

    const media = keysIn(globals.slice(mediaStart, toggleStart));
    const toggle = keysIn(globals.slice(toggleStart, toggleEnd));
    expect(media.size).toBeGreaterThan(20);

    const onlyMedia = [...media].filter((k) => !toggle.has(k));
    const onlyToggle = [...toggle].filter((k) => !media.has(k));

    expect(
      [...onlyMedia, ...onlyToggle],
      [
        onlyMedia.length
          ? `Only in the prefers-color-scheme block: ${onlyMedia.join(", ")}`
          : "",
        onlyToggle.length
          ? `Only in [data-theme="dark"]: ${onlyToggle.join(", ")}`
          : "",
        "Dark is declared twice and both copies must agree, or the bug appears",
        "only when the OS theme and the in-app toggle disagree.",
      ]
        .filter(Boolean)
        .join("\n"),
    ).toEqual([]);
  });
});
