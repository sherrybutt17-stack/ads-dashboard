import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  AD_PLATFORMS,
  defaultAdPlatform,
  isAdPlatform,
  linkCarriesPlatform,
  newestAdSync,
  offeredAdPlatforms,
  parseAdPlatform,
  resolveAdPlatform,
  type AdPlatform,
  type ConnectedPlatforms,
} from "./platforms";

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

/** `src/`, which the source checks below walk. */
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

describe("🔴 no call site re-implements the coercion", () => {
  /*
   * The original bug was not that the ternary was wrong — it was that it existed
   * seven times, so fixing five of them left two. A grep is the only thing that
   * notices the eighth.
   */
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

/**
 * A file's code with its comments taken out, so a sentence ABOUT a call — "this
 * used to be `parseAdPlatform(sp.platform)`" — is not read as the call. Block
 * comments (JSX's included) and whole-line `//` ones, as `client-bundle.test.ts`
 * strips them; a `//` mid-line, as in a URL, is left alone.
 */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** A path from `src/`, as the lists below spell it. */
const fromSrc = (file: string) => relative(SRC, file).split(sep).join("/");

describe("🔴 a page opened without ?platform= opens on the client's platform", () => {
  /*
   * `parseAdPlatform` answers Meta to anything that is not a platform —
   * including nothing at all, which is what a page opened without `?platform=`
   * is handed. That was every client's right answer until one ran TikTok alone;
   * then the Overview, the report and meeting mode all opened on Meta's "not
   * connected" view over the client's only live data.
   *
   * Nothing at runtime notices a page going back to it. Every resolver test in
   * this file keeps passing — the page simply stops calling the resolver — so
   * these read the pages themselves.
   */

  /**
   * The files where `parseAdPlatform` is the right call, and why: each is handed
   * a platform somebody already chose, so Meta is only ever its answer to junk.
   *
   * 🔴 Adding a line here is the decision. A page a person opens without naming
   * a platform belongs on `resolvePagePlatform` (or `resolveAdPlatform`, given
   * the client's accounts) — see the note at the top of `platforms.ts`.
   */
  const EXPLICIT_PLATFORM: Record<string, string> = {
    "app/r/[token]/page.tsx": "A share link: the platform was stored on the link when it was made.",
    "app/render/[token]/page.tsx": "The PDF renderer: the platform is a claim in the signed render token.",
    "app/api/clients/[id]/budgets/route.ts": "Budget settings, whose panel always sends the platform it edits.",
    "app/api/clients/[id]/reports/route.ts": "Report schedules, whose panel always sends the platform it edits.",
    "lib/share.ts": "Minting a share link, from the platform the sender was viewing.",
  };

  // Read only where the name appears at all, so the walk stays cheap.
  const users = walk(SRC)
    .filter((f) => fromSrc(f) !== "lib/platforms.ts" && !/\.test\.tsx?$/.test(f))
    .filter((f) => readFileSync(f, "utf8").includes("parseAdPlatform"))
    // Any use, not only a call: an aliased import or `.map(parseAdPlatform)`
    // opens on Meta just the same.
    .filter((f) => /\bparseAdPlatform\b/.test(code(f)))
    .map(fromSrc)
    .sort();

  it("🔴 parseAdPlatform is used only where the platform was chosen explicitly", () => {
    const rogue = users.filter((f) => !(f in EXPLICIT_PLATFORM));
    expect(
      rogue,
      `These use parseAdPlatform, which opens Meta whenever no platform is named — ` +
        `for a client without Meta, its "not connected" view. A page a person opens ` +
        `without choosing belongs on resolvePagePlatform (or resolveAdPlatform with ` +
        `the client's accounts). If the file is only ever handed a platform somebody ` +
        `chose, add it to EXPLICIT_PLATFORM with the reason:\n  ${rogue.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has no stale entries for files that no longer use it", () => {
    // A leftover exemption pre-approves the next change to that file.
    const stale = Object.keys(EXPLICIT_PLATFORM).filter((f) => !users.includes(f));
    expect(stale, `Listed in EXPLICIT_PLATFORM but no longer using parseAdPlatform: ${stale.join(", ")}`).toEqual(
      [],
    );
  });

  /** Whether a page's code — comments aside — matches. */
  const pageHas = (page: string, re: RegExp) => re.test(code(join(SRC, page)));

  it("🔴 the Overview resolves, offers and links by the client's own platforms", () => {
    const OVERVIEW = "app/c/[slug]/page.tsx";
    // Which platform renders: the client's own when the URL names none.
    expect(
      pageHas(OVERVIEW, /\b(?:resolveAdPlatform|resolvePagePlatform)\(/),
      "the Overview must resolve its platform with resolveAdPlatform or resolvePagePlatform",
    ).toBe(true);
    // Which the toggle offers: no Facebook tab for a client without Meta.
    expect(
      pageHas(OVERVIEW, /\bofferedAdPlatforms\(/),
      "the Overview's platform toggle must come from offeredAdPlatforms",
    ).toBe(true);
    // Which links name their platform: every view but Meta on a client opening on
    // Meta. Both places the page builds them — the report and meeting-mode links,
    // and `hrefWith` for the toggle and tabs — one of which alone would pass a
    // presence check.
    const overview = code(join(SRC, OVERVIEW));
    expect(
      (overview.match(/\blinkCarriesPlatform\(/g) ?? []).length,
      "both of the Overview's link builders must name their platform through linkCarriesPlatform",
    ).toBe(2);
    // …measured against where THIS client lands, not against Meta.
    expect(overview, "opensOn is the client's own default").toMatch(
      /\bopensOn\s*=\s*defaultAdPlatform\(\s*connected\s*\)/,
    );
    /*
     * And no comparison with "meta" at all, either way round, but the one line
     * that labels Meta "Facebook". The test it replaces looked only for `!==`,
     * and HEAD's rule written as `=== "meta" ? "" : …` got past it: for a client
     * without Meta, a Facebook button built on it prints a bare URL, a bare URL
     * opens the client's own platform, and the button reloads the page it was
     * meant to leave.
     */
    const offending = overview
      .split("\n")
      .filter((line) => /[!=]==?\s*["'`]meta["'`]|["'`]meta["'`]\s*[!=]==?/.test(line))
      .filter((line) => !/===\s*["'`]meta["'`]\s*\?\s*["'`]Facebook["'`]/.test(line))
      .map((line) => line.trim());
    expect(offending, "decide whether a link names its platform with linkCarriesPlatform").toEqual([]);
  });

  it("🔴 the report and meeting mode resolve theirs by the same rule", () => {
    for (const page of ["app/c/[slug]/report/page.tsx", "app/c/[slug]/present/page.tsx"]) {
      expect(pageHas(page, /\bresolvePagePlatform\(/), `${page} must resolve its platform with resolvePagePlatform`).toBe(
        true,
      );
    }
  });
});

/** A client with accounts on exactly these platforms. */
const has = (...platforms: AdPlatform[]): ConnectedPlatforms => ({
  meta: platforms.includes("meta"),
  google: platforms.includes("google"),
  tiktok: platforms.includes("tiktok"),
});

/** Every combination of connected platforms, the empty one included. */
const EVERY_CLIENT: ConnectedPlatforms[] = Array.from({ length: 2 ** AD_PLATFORMS.length }, (_, mask) =>
  has(...AD_PLATFORMS.filter((_, i) => mask & (1 << i))),
);

describe("the platform a client's pages open on", () => {
  it("🔴 a client running TikTok alone opens on TikTok, not on Meta's empty view", () => {
    /*
     * The report this exists for: the owner "cannot see TikTok stats". The
     * sync was healthy; the Overview opened on Meta's "not connected" view for
     * a client with no Meta account, with its TikTok data behind a toggle.
     */
    expect(defaultAdPlatform(has("tiktok"))).toBe("tiktok");
    expect(resolveAdPlatform(undefined, has("tiktok"))).toBe("tiktok");
  });

  it("a Google-only client opens on Google, and Google leads TikTok", () => {
    expect(defaultAdPlatform(has("google"))).toBe("google");
    expect(defaultAdPlatform(has("google", "tiktok"))).toBe("google");
  });

  it("a client with nothing connected opens on Meta, whose empty state is the setup prompt", () => {
    expect(defaultAdPlatform(has())).toBe("meta");
  });

  it("🔴 any client with Meta behaves exactly as before, for every input", () => {
    /*
     * Meta is first in the order, so the new default must be invisible to every
     * client that has it: whatever the URL says, the page opens where
     * `parseAdPlatform` — the old rule — would have opened it.
     */
    const inputs = [undefined, null, "", "meta", "google", "tiktok", "META", "facebook", "../x", 7, {}];
    for (const connected of EVERY_CLIENT.filter((c) => c.meta)) {
      for (const input of inputs) {
        expect(resolveAdPlatform(input, connected), `${JSON.stringify(connected)} ${String(input)}`).toBe(
          parseAdPlatform(input),
        );
      }
    }
  });

  it("🔴 an explicit ?platform= wins, even for a platform with no account", () => {
    // Every link already printed carries the view it was made on, and must keep
    // opening it — including a Facebook link to a client that has since gone
    // TikTok-only, which renders Meta's honest empty view.
    for (const connected of EVERY_CLIENT) {
      for (const p of AD_PLATFORMS) expect(resolveAdPlatform(p, connected)).toBe(p);
    }
  });

  it("junk in the URL falls back to the client's own platform, not to Meta", () => {
    for (const bad of [undefined, null, "", "META", "facebook", "../x", 7]) {
      expect(resolveAdPlatform(bad, has("tiktok")), String(bad)).toBe("tiktok");
    }
  });
});

describe("the platforms a view offers", () => {
  it("🔴 a TikTok-only client is offered TikTok alone — no dead Facebook tab", () => {
    expect(offeredAdPlatforms("tiktok", has("tiktok"))).toEqual(["tiktok"]);
  });

  it("keeps the platform on screen, so a link to it still has a way back", () => {
    // `?platform=meta` on a TikTok-only client: Meta is shown, and offered, so
    // the toggle has a lit button and a TikTok button to return by.
    expect(offeredAdPlatforms("meta", has("tiktok"))).toEqual(["meta", "tiktok"]);
    expect(offeredAdPlatforms("tiktok", has("meta"))).toEqual(["meta", "tiktok"]);
  });

  it("offers Meta to a client with nothing connected, and only Meta", () => {
    expect(offeredAdPlatforms("meta", has())).toEqual(["meta"]);
    expect(offeredAdPlatforms("google", has())).toEqual(["meta", "google"]);
  });

  it("lists every connected platform, in the house order", () => {
    expect(offeredAdPlatforms("meta", has("meta"))).toEqual(["meta"]);
    expect(offeredAdPlatforms("google", has("meta", "google"))).toEqual(["meta", "google"]);
    expect(offeredAdPlatforms("meta", has("meta", "google", "tiktok"))).toEqual(AD_PLATFORMS);
    expect(offeredAdPlatforms("google", has("google"))).toEqual(["google"]);
  });

  it("always includes the platform being viewed and every connected one", () => {
    for (const connected of EVERY_CLIENT) {
      for (const viewing of AD_PLATFORMS) {
        const offered = offeredAdPlatforms(viewing, connected);
        expect(offered).toContain(viewing);
        for (const p of AD_PLATFORMS) if (connected[p]) expect(offered).toContain(p);
      }
    }
  });
});

describe("which links name their platform", () => {
  it("leaves Meta off for a client that opens on Meta — the links it always had", () => {
    expect(linkCarriesPlatform("meta", "meta")).toBe(false);
    expect(linkCarriesPlatform("google", "meta")).toBe(true);
    expect(linkCarriesPlatform("tiktok", "meta")).toBe(true);
  });

  it("🔴 names even a non-Meta client's own default, so a kept link survives a new account", () => {
    // A bare report link for a TikTok-only client would open Meta the month
    // Meta is connected. Named, it keeps opening TikTok.
    expect(linkCarriesPlatform("tiktok", "tiktok")).toBe(true);
    expect(linkCarriesPlatform("meta", "tiktok")).toBe(true);
  });

  it("🔴 every link lands on the view it was made from", () => {
    /*
     * The property the Overview's toggle, tabs, report and deck links depend
     * on, for every client shape: the page at the other end resolves the link's
     * parameter — or its absence — back to the platform that printed it. A
     * Facebook button that dropped `platform=meta` for a TikTok-only client
     * would reload TikTok instead of leaving it.
     */
    for (const connected of EVERY_CLIENT) {
      const opensOn = defaultAdPlatform(connected);
      for (const p of AD_PLATFORMS) {
        const param = linkCarriesPlatform(p, opensOn) ? p : undefined;
        expect(resolveAdPlatform(param, connected), `${JSON.stringify(connected)} → ${p}`).toBe(p);
      }
    }
  });
});

describe("newestAdSync", () => {
  const HOUR_AGO = new Date("2026-10-24T11:00:00Z");
  const DAYS_AGO = new Date("2026-10-21T11:00:00Z");

  it("🔴 dates a TikTok-only client by TikTok, not by Meta's empty column", () => {
    // `clients.last_synced_at` is NULL for a client Meta never synced, and
    // reading it alone said "Not synced yet" over a sync an hour old.
    expect(
      newestAdSync({ metaConnected: false, metaSyncedAt: null, accountSyncs: [HOUR_AGO] }),
    ).toEqual(HOUR_AGO);
  });

  it("🔴 ignores Meta's column once Meta has no account — it outlives a removed one", () => {
    expect(
      newestAdSync({ metaConnected: false, metaSyncedAt: HOUR_AGO, accountSyncs: [DAYS_AGO] }),
    ).toEqual(DAYS_AGO);
  });

  it("takes the newest of the platforms a client has", () => {
    expect(
      newestAdSync({ metaConnected: true, metaSyncedAt: DAYS_AGO, accountSyncs: [null, HOUR_AGO] }),
    ).toEqual(HOUR_AGO);
    expect(
      newestAdSync({ metaConnected: true, metaSyncedAt: HOUR_AGO, accountSyncs: [DAYS_AGO] }),
    ).toEqual(HOUR_AGO);
  });

  it("is null when nothing connected has ever synced", () => {
    expect(newestAdSync({ metaConnected: true, metaSyncedAt: null, accountSyncs: [null] })).toBeNull();
    expect(newestAdSync({ metaConnected: false, metaSyncedAt: null, accountSyncs: [] })).toBeNull();
  });
});
