import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AD_PLATFORMS, isAdPlatform, parseAdPlatform } from "./platforms";

describe("parseAdPlatform", () => {
  it("accepts every platform in the list", () => {
    // Asserted over AD_PLATFORMS rather than three literals, so adding a
    // platform re-checks the parser instead of silently skipping it.
    for (const p of AD_PLATFORMS) expect(parseAdPlatform(p), p).toBe(p);
  });

  it("🔴 does not collapse tiktok into meta", () => {
    /*
     * The bug this module exists for. Seven call sites each wrote
     * `x === "google" ? "google" : "meta"`, which was correct with two platforms
     * and became a silent mislabel with three: `?platform=tiktok` rendered
     * META's spend, leads and cost per lead under a TikTok heading.
     *
     * Worse than an empty tab — an empty tab prompts a question, a plausible
     * wrong number gets reported to a client as TikTok performance.
     */
    expect(parseAdPlatform("tiktok")).toBe("tiktok");
    expect(parseAdPlatform("tiktok")).not.toBe("meta");
  });

  it("falls back to meta for anything that is not a platform", () => {
    // Safe to point straight at a query string: absent, misspelled or hostile
    // input renders the Meta dashboard rather than throwing.
    for (const bad of [undefined, null, "", "META", "facebook", "../x", 7, {}, []]) {
      expect(parseAdPlatform(bad), String(bad)).toBe("meta");
    }
  });

  it("isAdPlatform narrows without throwing on non-strings", () => {
    expect(isAdPlatform("google")).toBe(true);
    expect(isAdPlatform(undefined)).toBe(false);
    expect(isAdPlatform(123)).toBe(false);
  });
});

describe("🔴 no call site re-implements the coercion", () => {
  /*
   * The original bug was not that the ternary was wrong — it was that it existed
   * seven times, so fixing five of them left two. A grep is the only thing that
   * notices the eighth.
   */
  const SRC = resolve(__dirname, "..");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules") continue;
        walk(full, out);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  it("nothing hand-rolls a platform ternary", () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith("platforms.ts") && !f.endsWith("platforms.test.ts"))
      .filter((f) => /===\s*"google"\s*\?\s*"google"\s*:\s*"meta"/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(`${SRC}/`, ""));

    expect(
      offenders,
      offenders.length
        ? `These coerce the platform by hand and will drop any platform added ` +
            `after Google:\n  ${offenders.join("\n  ")}\nUse parseAdPlatform().`
        : "",
    ).toEqual([]);
  });
});
