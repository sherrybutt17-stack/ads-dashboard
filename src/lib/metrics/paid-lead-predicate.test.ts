import { describe, it, expect, vi } from "vitest";
import type { PaidLeadFilter } from "./queries";

// `queries.ts` imports the connection module at load, which demands a live
// DATABASE_URL. Nothing here touches the database — this is a pure function.
vi.mock("@/db", () => ({ db: {}, schema: {} }));

const { paidLeadPredicate } = await import("./queries");

/**
 * The guard clauses in `paidLeadPredicate`, which exist for blast radius.
 *
 * This function runs inside `getFunnelCounts`, so every dashboard render and
 * every health check passes through it. Its two failure modes are both silent
 * or fatal rather than merely inaccurate — a missing tag threw before it could
 * return, and an unrecognised mode returned `undefined`, which the caller reads
 * as "filter present" (`undefined !== null`) and so joins `contacts` while
 * pushing no predicate, dropping every transition whose contact is null.
 */
describe("paidLeadPredicate guards", () => {
  const sqlish = (v: unknown) => JSON.stringify(v ?? null);

  it("does not throw when the tag is missing", () => {
    // Types say this cannot happen and the column is NOT NULL. A partially
    // built Client still reaches here, and a 500 on the main dashboard is a
    // worse answer than an empty tag.
    expect(() =>
      paidLeadPredicate({ mode: "either" } as unknown as PaidLeadFilter),
    ).not.toThrow();
    expect(() =>
      paidLeadPredicate({ mode: "tagged", tag: null } as unknown as PaidLeadFilter),
    ).not.toThrow();
  });

  it("🔴 returns null — not undefined — for an unrecognised mode", () => {
    // The distinction the caller depends on: `undefined !== null` would make it
    // join contacts with no predicate and silently drop contactless rows.
    const r = paidLeadPredicate({
      mode: "something-new",
      tag: "x",
    } as unknown as PaidLeadFilter);
    expect(r).toBeNull();
    expect(r).not.toBeUndefined();
  });

  it("returns null for 'all', which is the documented no-filter mode", () => {
    expect(paidLeadPredicate({ mode: "all", tag: "x" })).toBeNull();
  });

  it("still builds a predicate for each real mode", () => {
    for (const mode of ["attributed", "tagged", "either"] as const) {
      const r = paidLeadPredicate({ mode, tag: "metaadsleads" });
      expect(r, mode).not.toBeNull();
      expect(sqlish(r), mode).not.toBe("null");
    }
  });

  it("normalises the tag rather than trusting how it was typed", () => {
    // Tags are entered by hand in the setup wizard; "  MetaAdsLeads " and
    // "metaadsleads" must not be two different clients' worth of leads.
    const a = paidLeadPredicate({ mode: "tagged", tag: "  MetaAdsLeads " });
    const b = paidLeadPredicate({ mode: "tagged", tag: "metaadsleads" });
    expect(sqlish(a)).toBe(sqlish(b));
  });
});
