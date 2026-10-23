import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import ts from "typescript";

/*
 * 🔴 A space after a tag or `{value}` is dropped when the text that follows it
 * runs over several lines AND contains an HTML entity.
 *
 * Next's compiler trims the leading whitespace of such a JSX text node, so
 *
 *     <strong>CRM data.</strong> From the client&rsquo;s own GoHighLevel
 *     account: …
 *
 * renders "CRM data.From the client's own GoHighLevel account". The same text
 * on one line, or with a literal ’ in place of `&rsquo;`, keeps its space —
 * which is why it read fine in review and shipped anyway: on the privacy policy
 * Google's verification team reads, on the About page, and in the app
 * ("budget pacingwarnings", "about 14days").
 *
 * The fix is an explicit `{" "}` after the tag or expression, which survives
 * every case. A space BEFORE a tag is not affected.
 */

const SRC = join(process.cwd(), "src");
const ENTITY = /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/;

function tsxFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Text nodes the compiler will strip the leading space from. */
function atRisk(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const raw = n.getFullText();
      const siblings = (n.parent as ts.JsxElement | ts.JsxFragment).children;
      const hasPrevious = siblings.indexOf(n) > 0;
      if (hasPrevious && /^[ \t]+\S/.test(raw) && raw.includes("\n") && ENTITY.test(raw)) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
        found.push(`${relative(SRC, file)}:${line + 1} ${JSON.stringify(raw.trim().slice(0, 40))}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("JSX text after a tag keeps its space", () => {
  it("is the compiler's behaviour, not a style preference", async () => {
    // If this starts failing, Next fixed it and the guard below can go.
    const swc = createRequire(import.meta.url)("next/dist/build/swc");
    await swc.loadBindings();
    const compile = async (text: string) =>
      (
        await swc.transform(
          `export const A = () => <p>\n  <strong>B.</strong> ${text}\n  own staff\n</p>;`,
          {
            filename: "a.tsx",
            jsc: {
              parser: { syntax: "typescript", tsx: true },
              transform: { react: { runtime: "automatic" } },
            },
          },
        )
      ).code as string;
    expect(await compile("From the client")).toContain('" From the client own staff"');
    expect(await compile("From the client&rsquo;s")).toContain('"From the client’s own staff"');
  }, 30_000);

  it("finds the components it is checking", () => {
    expect(tsxFiles().length).toBeGreaterThan(50);
  });

  it("🔴 never leaves a space for the compiler to drop", () => {
    const offenders = tsxFiles().flatMap(atRisk);
    expect(offenders, 'put {" "} after the tag or expression instead').toEqual([]);
  });
});
