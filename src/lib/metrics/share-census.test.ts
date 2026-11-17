import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * 🔴 Every read of the lead tables goes through the ledger relations, or is on
 * this list with the reason it may not.
 *
 * A client in a shared GoHighLevel sub-account (`src/lib/ghl/share.ts`) holds
 * a FULL copy of it: every person, every card, every stage move — its own and
 * the other business's. What makes its dashboard count only its own is a flag,
 * `share_counted`, that `FUNNEL_CONTACTS`, `FUNNEL_OPPORTUNITIES` and
 * `FUNNEL_TRANSITIONS` (`./ledger.ts`) apply. A query that reads `contacts`,
 * `opportunities` or `stage_transitions` directly by `client_id` would:
 *
 *   · count the whole sub-account for every client in the share, and
 *   · show one business's lead names, emails and phones to the other's logins.
 *
 * Nothing else catches it: it typechecks, it builds, and for every client that
 * doesn't share — all of them, until the first share — the numbers are right.
 *
 * So the files that read these tables are listed here, each with why, and a
 * new one fails until somebody decides. Joining a contact or card BY ITS OWN ID
 * from an already-filtered ledger row is safe — a member's copied moves point
 * at the member's own rows, which carry the same verdict — and is what
 * `queries.ts` does; its bare reads must all go through the relations.
 */

const SRC = join(process.cwd(), "src");

const READS =
  /(?:FROM|JOIN)\s+(?:contacts|opportunities|stage_transitions)\b|\.from\((?:contacts|opportunities|stageTransitions)\)|Join\((?:contacts|opportunities|stageTransitions)\b/;

const ALLOWED: Record<string, string> = {
  "lib/metrics/ledger.ts": "Defines the relations every other reader uses.",
  "lib/metrics/queries.ts":
    "Every bare read goes through FUNNEL_*; the rest join a contact or card by its own id from a ledger row (asserted below).",
  "lib/ghl/process.ts": "The webhook writer: upserts the holder's own rows.",
  "lib/ghl/history.ts": "The history import writer: upserts the holder's own rows.",
  "lib/tag-funnel/index.ts":
    "Projects tag leads per client; stand-ins carry their contact's share flags, so readers filter them.",
  "lib/tag-funnel/preview.ts":
    "Map-by-tag preview: reads one client's rows with the share filter applied in its own SQL.",
  "lib/alerts/send.ts":
    "One contact by GHL id, restricted to the counted, tag-placed copy in its own SQL; the hourly cap counts claimed alerts.",
  "lib/health.ts":
    "Funnel checks read the relations; the shared-sub-account check reads the holder's whole copy on purpose, to report the split.",
  "lib/ghl/share.ts": "The mirror and the split: they write the copies and flags the relations read.",
  "lib/ghl/share-actions.ts": "Preview, link, stop and purge: they read and write copies and flags directly, by design.",
  "lib/ghl/share-panel.ts": "Counts each share client's counted people for the panel, with the flag in its SQL.",
  "lib/ghl/share-sweep.ts": "The hourly repair of copies and flags.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__testdb__") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const readers = walk(SRC)
  .filter((f) => READS.test(readFileSync(f, "utf8")))
  .map((f) => relative(SRC, f).split(sep).join("/"));

describe("reads of the lead tables (shared sub-accounts)", () => {
  it("finds the readers it is checking", () => {
    // A broken walker would make the assertions below vacuous.
    expect(readers.length).toBeGreaterThan(5);
  });

  it("🔴 every file reading contacts, opportunities or stage_transitions is on the list", () => {
    const rogue = readers.filter((f) => !(f in ALLOWED));
    expect(
      rogue,
      `These read the lead tables directly. In a shared sub-account that counts the other ` +
        `business's leads and shows their names. Read through FUNNEL_CONTACTS / ` +
        `FUNNEL_OPPORTUNITIES / FUNNEL_TRANSITIONS (src/lib/metrics/ledger.ts), or add the ` +
        `file here with the reason it may not:\n  ${rogue.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has no stale entries", () => {
    const stale = Object.keys(ALLOWED).filter((f) => !readers.includes(f));
    expect(stale, `Listed but no longer reading the tables: ${stale.join(", ")}`).toEqual([]);
  });

  it("🔴 queries.ts reads every lead table through the relations, joining only by id", () => {
    const src = readFileSync(join(SRC, "lib", "metrics", "queries.ts"), "utf8");
    // No bare FROM of a lead table.
    expect(src.match(/FROM\s+(?:contacts|opportunities|stage_transitions)\b/g) ?? []).toEqual([]);
    // Every JOIN of one is by its own id from a row already filtered.
    const joins = [...src.matchAll(/JOIN\s+(contacts|opportunities|stage_transitions)\s+(\w+)\s+ON\s+([^\n`]+)/g)];
    expect(joins.length).toBeGreaterThan(10);
    const bad = joins
      .filter(([, table, alias, on]) => {
        const id = new RegExp(`^${alias}\\.id\\s*=\\s*\\w+\\.(?:contact_id|opportunity_id)\\b`);
        return table === "stage_transitions" || !id.test(on.trim());
      })
      .map(([m]) => m);
    expect(bad, `Joins that are not by the row's own id:\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});
