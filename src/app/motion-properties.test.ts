import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 Entrance motion owns `translate`. Interaction motion owns `transform`.
 *
 * Three separate mechanisms in this stylesheet want to move an element, and
 * each one of them silently beats one of the others if they share a property:
 *
 * 1. `@keyframes rise`, the load entrance, runs with `animation-fill-mode:
 *    both` — so its final keyframe keeps applying FOREVER after the animation
 *    ends, and a filled animation outranks every ordinary declaration in the
 *    cascade. No specificity beats it. While `rise` animated `transform`, it
 *    pinned `transform: none` on every direct child of <main>, which meant any
 *    of them that wanted a hover transform got nothing, with no error and no
 *    visible cause. Three `.card` sections are direct children of <main> on the
 *    roll-up today.
 *
 * 2. The hover grow, which has to be `transform`: Tailwind 4 compiles
 *    `scale-*` / `translate-*` to the INDEPENDENT `scale` and `translate`
 *    properties, and globals.css is unlayered while utilities sit in
 *    `@layer utilities` — so a bare `scale:` on a component class here would
 *    beat every `hover:scale-*` in the tree. Same shape as the
 *    `.skeleton { border-radius }` bug.
 *
 * 3. Call sites, which own `scale` / `translate` through those utilities.
 *
 * Giving the first two one property each is what keeps all three working, and
 * it is invisible in review — the failure is a hover that quietly does nothing.
 * Hence this file.
 */

const CSS = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");

/**
 * Comments stripped.
 *
 * A rule's "selector" here is everything since the previous closing brace, and
 * the interaction-motion block is introduced by ~70 lines of prose that names
 * `transform`, `scale` and `translate` repeatedly. Left in, every assertion
 * below would match the explanation rather than the code — the precedent is
 * `lime-fill.test.ts`, which strips for the same reason.
 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The gated block's body: hover grow, one condition per hazard. */
const GATE = (() => {
  const open = "@media (hover: hover) and (prefers-reduced-motion: no-preference) {";
  const from = BARE.indexOf(open);
  expect(
    from,
    "the interaction-motion block is gone — a hover transform that is not " +
      "gated sticks on touch and jumps under reduced-motion",
  ).toBeGreaterThan(-1);

  // Brace-match rather than index a closing token: the block contains nested
  // rules, so the first "\n}" is a member's brace, not the block's.
  let depth = 0;
  let i = from + open.length - 1;
  for (; i < BARE.length; i++) {
    if (BARE[i] === "{") depth++;
    else if (BARE[i] === "}" && --depth === 0) break;
  }
  expect(i, "the interaction-motion block never closes").toBeLessThan(BARE.length);
  return BARE.slice(from, i + 1);
})();

/**
 * Classes that carry no transition of their own because they are never worn
 * alone — `.card-interactive` is a modifier on `.card`, and `.card` is what
 * holds the transition.
 *
 * Derived, not declared: the co-occurrence is read back out of the call sites,
 * so a component that starts using the modifier by itself fails this rather
 * than quietly losing its animation.
 */
const COMPANIONS: Record<string, string[]> = (() => {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const f = join(dir, entry);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.tsx$/.test(entry)) files.push(f);
    }
  })(join(process.cwd(), "src"));

  const MODIFIER = "card-interactive";
  const sets = files
    .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/className=\{?[`"]([^`"]*)[`"]/g)])
    .map((m) => m[1].split(/\s+/))
    .filter((tokens) => tokens.includes(MODIFIER));

  expect(sets.length, `nothing uses .${MODIFIER} any more`).toBeGreaterThan(0);

  // Only the classes present in EVERY use of the modifier can be relied on to
  // carry its transition.
  const shared = sets
    .map((t) => t.filter((c) => c !== MODIFIER))
    .reduce((a, b) => a.filter((c) => b.includes(c)));

  expect(
    shared,
    `.${MODIFIER} is now used without a companion class, so nothing guarantees ` +
      "it transitions transform and the grow will snap",
  ).not.toEqual([]);

  return { [MODIFIER]: shared };
})();

describe("motion property split", () => {
  it("animates the entrance on translate, never on transform", () => {
    const m = BARE.match(/@keyframes rise\s*\{[\s\S]*?\n\}/);
    expect(m, "@keyframes rise is gone").not.toBeNull();
    const rise = m![0];

    expect(
      /\btransform\s*:/.test(rise),
      "`rise` is filled with `both`, so whatever its last keyframe sets is " +
        "pinned on every direct child of <main> for the life of the page. On " +
        "`transform` that silently kills every hover grow underneath it.",
    ).toBe(false);
    expect(/\btranslate\s*:/.test(rise), "`rise` no longer moves anything").toBe(true);
  });

  it("puts every hover transform inside the gate", () => {
    /*
     * Found by what they DO — a `:hover` rule setting a transform — rather
     * than by listing the class names, so a new component that grows on hover
     * without the gate fails this the day it is written.
     */
    const stray: string[] = [];
    for (const m of BARE.matchAll(/([^{}]*:hover[^{}]*)\{([^{}]*)\}/g)) {
      if (!/\btransform\s*:/.test(m[2])) continue;
      const sel = m[1].trim().replace(/\s+/g, " ");
      if (!GATE.includes(m[0])) stray.push(sel);
    }
    expect(
      stray,
      "a hover transform outside the gate sticks on touch (a tap leaves " +
        ":hover on) and becomes an instant jump under reduced-motion, since " +
        "the global killswitch kills `transition` but not `transform`:\n" +
        stray.join("\n"),
    ).toEqual([]);

    // Anti-rot: the loop above passes trivially if the regex stops matching.
    expect(
      [...GATE.matchAll(/:hover[^{}]*\{[^{}]*transform\s*:/g)].length,
      "nothing grows on hover any more",
    ).toBeGreaterThanOrEqual(5);
  });

  it("never sets the Tailwind-owned properties on a component class", () => {
    /*
     * `scale:` / `translate:` / `rotate:` as bare properties. Inside
     * `@keyframes` they are correct and expected — that is mechanism 1 above —
     * so keyframe bodies are excluded and everything else is not.
     */
    const outside = BARE.replace(/@keyframes[\s\S]*?\n\}/g, "");
    const offenders = [...outside.matchAll(/(?:^|[;{\s])(scale|translate|rotate)\s*:/gm)].map(
      (m) => m[1],
    );
    expect(
      offenders,
      "globals.css is unlayered and Tailwind's utilities are in " +
        "@layer utilities, so a bare `" + offenders[0] + ":` here outranks " +
        "every `" + offenders[0] + "-*` call site in the tree",
    ).toEqual([]);
  });

  it("transitions the property it animates, on every class that grows", () => {
    /*
     * A grow with no `transform` in the transition still grows — it just
     * snaps, which looks like a bug rather than like no animation. The
     * transition lives on the base class, the transform on its `:hover`, so
     * they are only correct together and only ever edited apart.
     */
    const classes = new Set<string>();
    for (const m of GATE.matchAll(/\.([a-z-]+)[^{},]*:hover/g)) classes.add(m[1]);
    expect(classes.size, "no classes parsed out of the gate").toBeGreaterThanOrEqual(5);

    const missing: string[] = [];
    for (const cls of classes) {
      /*
       * 🔴 EVERY rule the class appears in, not the first one.
       *
       * `.btn-lime` opens two blocks: the geometry it shares with
       * `.btn-accent`, which sets no transition at all, and its own paint
       * block, which sets the one being looked for. A first-match read lands
       * on the geometry and reports a button that transitions perfectly well
       * as broken. `lime-fill.test.ts` hit this exact pair and says so.
       */
      const own = [
        ...BARE.matchAll(new RegExp(`([^{}]*\\b${cls}\\b[^{}]*)\\{([^{}]*)\\}`, "g")),
      ];
      const carriers = [cls, ...(COMPANIONS[cls] ?? [])];
      const hit = carriers.some((c) =>
        [...BARE.matchAll(new RegExp(`([^{}]*\\b${c}\\b[^{}]*)\\{([^{}]*)\\}`, "g"))].some(
          (m) => !m[1].includes(":") && /transition:[^;]*\btransform\b/.test(m[2]),
        ),
      );
      if (own.length === 0 && !COMPANIONS[cls]) {
        missing.push(`.${cls} — no rule anywhere in the stylesheet`);
      } else if (!hit) {
        missing.push(
          `.${cls} — grows on hover but neither it nor ${
            (COMPANIONS[cls] ?? []).map((c) => "." + c).join("/") || "anything"
          } transitions transform, so the grow snaps`,
        );
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("times every transform inside the house motion band", () => {
    /*
     * 180–240ms, from the design brief this app was built to. The band is not
     * decoration: below it a grow stops reading as movement and starts reading
     * as a jump, which is the thing the whole block exists to avoid.
     *
     * This exists because `.btn-accent` sat at 0.1s and nothing noticed. The
     * check above it only asks whether `transform` is NAMED in the transition,
     * and 0.1s names it perfectly well — a button that snapped to size passed
     * every other assertion in this file.
     */
    const out: string[] = [];
    for (const m of BARE.matchAll(/([^{}]*)\{([^{}]*transition:[^;]*;)/g)) {
      const d = m[2].match(/transform (\d*\.?\d+)s/);
      if (!d) continue;
      const ms = Number(d[1]) * 1000;
      if (ms < 180 || ms > 240) {
        out.push(`${m[1].trim().replace(/\s+/g, " ")} — transform ${ms}ms`);
      }
    }
    expect(
      out,
      "the house band is 180–240ms; outside it the grow reads as a snap:\n" +
        out.join("\n"),
    ).toEqual([]);

    // Anti-rot: passes trivially if the transition regex stops matching.
    expect(
      [...BARE.matchAll(/transition:[^;]*transform \d/g)].length,
      "no transform transitions parsed at all",
    ).toBeGreaterThanOrEqual(8);
  });

  it("keeps the grow small enough to stay inside its own gutter", () => {
    /*
     * The grid gaps are 12px and nothing here raises a z-index, so a card that
     * grows past its gutter slides UNDER its neighbour rather than over it.
     * The tightest case is the 337px roll-up card: 1.05 would put 8.4px a side
     * into a 6px half-gutter. It is also the point where a non-integer scale
     * starts visibly softening text.
     */
    const factors = [...GATE.matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(factors.length, "nothing scales in the gate").toBeGreaterThanOrEqual(4);
    const tooBig = factors.filter((f) => f > 1.05);
    expect(
      tooBig,
      `scale ${tooBig[0]} overlaps the 12px grid gap and softens the text ` +
        "under it; the cards are sized to grow into their gutter, not past it",
    ).toEqual([]);
  });

  it("leaves table rows unscaled", () => {
    /*
     * A scaled <tr> carries its cells with it and they stop lining up with the
     * header and with every other row — the grow reads as the table breaking.
     * `.row-hover` is on the rows in CampaignStageTable and PipelineExplorer.
     */
    const rowRules = [...GATE.matchAll(/([^{}]*\.row-hover[^{}]*)\{([^{}]*)\}/g)];
    for (const r of rowRules) {
      expect(
        /scale\(/.test(r[2]),
        `.row-hover must not scale — it is on <tr>: ${r[1].trim()}`,
      ).toBe(false);
    }
  });

  it("keeps the gate ahead of @media print, and print last", () => {
    /*
     * Position is what makes the gate win at equal specificity, which is why
     * there is no `!important` in it. And print stays last for its own reason,
     * recorded on that block.
     */
    /*
     * On the COMMENT-STRIPPED text. The gate's own explanation says "ahead of
     * @media print", and searching the raw file finds that sentence — 2.5kB
     * before the block it describes — and reports the file as out of order.
     * `section-hue.test.ts` still has the un-stripped version of this bug.
     */
    const gateAt = BARE.indexOf("@media (hover: hover)");
    const printAt = BARE.indexOf("@media print");
    expect(gateAt).toBeGreaterThan(-1);
    expect(printAt).toBeGreaterThan(gateAt);
    expect(
      BARE.slice(printAt).includes("@media (hover"),
      "@media print must stay last in the file",
    ).toBe(false);
  });
});
