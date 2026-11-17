import { describe, it, expect } from "vitest";
import {
  decideSplit,
  seenAt,
  validateShareRules,
  wouldCountLeads,
  type ShareRules,
  type SplitEvidence,
} from "./share-rule";

const V = "vision"; // holds the connection, takes untagged leads
const A = "aesthetic";
const t = (iso: string) => new Date(iso);

const RULES: ShareRules = {
  tags: new Map([
    [V, ["lasik"]],
    [A, ["aesthetic", "botox"]],
  ]),
  untagged: V,
  keepRemoved: true,
};

function ev(over: Omit<Partial<SplitEvidence>, "history"> & { history?: Record<string, string> } = {}): SplitEvidence {
  const { history, ...rest } = over;
  return {
    tags: [],
    fetchedAt: t("2026-11-10T10:00:00Z"),
    createdAt: t("2026-11-01T09:00:00Z"),
    owner: null,
    ...rest,
    history: new Map(Object.entries(history ?? {}).map(([k, v]) => [k, t(v)])),
  };
}

describe("decideSplit — R1: one client's tag", () => {
  it("counts for the client whose tag it has", () => {
    expect(decideSplit(ev({ tags: ["meta", "aesthetic"] }), RULES)).toEqual({ clientId: A, reason: "tag" });
    expect(decideSplit(ev({ tags: ["lasik"] }), RULES)).toEqual({ clientId: V, reason: "tag" });
  });

  it("treats two tags of the SAME client as one client", () => {
    expect(decideSplit(ev({ tags: ["aesthetic", "botox"] }), RULES)).toEqual({ clientId: A, reason: "tag" });
  });

  it("moves a corrected lead: 'lasik' removed, 'aesthetic' added", () => {
    const e = ev({
      tags: ["aesthetic"],
      owner: V,
      history: { lasik: "2026-11-01T09:00:05Z", aesthetic: "2026-11-05T12:00:00Z" },
    });
    expect(decideSplit(e, RULES)).toEqual({ clientId: A, reason: "tag" });
  });
});

describe("decideSplit — R2: two clients' tags", () => {
  it("keeps the client it already counts for while that client's tag is still on", () => {
    const e = ev({
      tags: ["lasik", "aesthetic"],
      owner: V,
      history: { lasik: "2026-11-01T09:00:05Z", aesthetic: "2026-11-09T12:00:00Z" },
    });
    expect(decideSplit(e, RULES)).toEqual({ clientId: V, reason: "first_tag" });
  });

  it("keeps the owner even when the owner's tag was seen LATER (no flipping on stale dates)", () => {
    // Moved to Vision by a correction; Aesthetic's old tag is re-added by a re-submitted form.
    const e = ev({
      tags: ["lasik", "aesthetic"],
      owner: V,
      history: { aesthetic: "2026-11-01T09:00:05Z", lasik: "2026-11-06T12:00:00Z" },
    });
    expect(decideSplit(e, RULES)).toEqual({ clientId: V, reason: "first_tag" });
  });

  it("gives a lead with no owner yet to the client whose tag was seen first", () => {
    const e = ev({
      tags: ["lasik", "aesthetic"],
      history: { aesthetic: "2026-11-01T09:00:05Z", lasik: "2026-11-01T09:03:00Z" },
    });
    expect(decideSplit(e, RULES)).toEqual({ clientId: A, reason: "first_tag" });
  });

  it("sends tags seen at the same moment to the no-tag choice", () => {
    const e = ev({ tags: ["lasik", "aesthetic"], history: { lasik: "2026-11-01T09:00:00Z", aesthetic: "2026-11-01T09:00:00Z" } });
    expect(decideSplit(e, RULES)).toEqual({ clientId: V, reason: "both_tags" });
    expect(decideSplit(e, { ...RULES, untagged: null })).toEqual({ clientId: null, reason: "both_tags" });
  });

  it("ignores an owner placed without a tag (no_tag) and orders by sightings", () => {
    const e = ev({
      tags: ["lasik", "aesthetic"],
      owner: null, // a no_tag copy is never passed as owner
      history: { lasik: "2026-11-02T09:00:00Z", aesthetic: "2026-11-03T09:00:00Z" },
    });
    expect(decideSplit(e, RULES)).toEqual({ clientId: V, reason: "first_tag" });
  });
});

describe("decideSplit — R3: tag removed", () => {
  it("keeps the lead with its client after a workflow removes the tag", () => {
    const e = ev({ tags: ["booked"], owner: A, history: { aesthetic: "2026-11-02T09:00:00Z" } });
    expect(decideSplit(e, RULES)).toEqual({ clientId: A, reason: "kept" });
  });

  it("a correction followed by a workflow removal stays with the corrected client", () => {
    // lasik (first) → aesthetic added + lasik removed (moves to A) → aesthetic removed later.
    const e = ev({
      tags: [],
      owner: A,
      history: { lasik: "2026-11-01T09:00:05Z", aesthetic: "2026-11-05T12:00:00Z" },
    });
    expect(decideSplit(e, RULES)).toEqual({ clientId: A, reason: "kept" });
  });

  it("a reassigned lead whose old tag returns, then everything is removed, stays with its owner", () => {
    // Owner V (moved there by a correction); history says aesthetic first, lasik later.
    const e = ev({
      tags: [],
      owner: V,
      history: { aesthetic: "2026-11-01T09:00:05Z", lasik: "2026-11-06T12:00:00Z" },
    });
    expect(decideSplit(e, RULES)).toEqual({ clientId: V, reason: "kept" });
  });

  it("without an owner, goes to the client whose tag was seen last", () => {
    const e = ev({ tags: [], history: { lasik: "2026-11-01T09:00:00Z", aesthetic: "2026-11-04T09:00:00Z" } });
    expect(decideSplit(e, RULES)).toEqual({ clientId: A, reason: "kept" });
  });

  it("two tags then both removed, seen at once, with no owner → the no-tag choice", () => {
    const e = ev({ tags: [], history: { lasik: "2026-11-01T09:00:00Z", aesthetic: "2026-11-01T09:00:00Z" } });
    expect(decideSplit(e, RULES)).toEqual({ clientId: V, reason: "both_tags" });
  });

  it("a read that came back without tags keeps a two-tag lead with its owner", () => {
    const e = ev({ tags: [], owner: A, history: { lasik: "2026-11-01T09:00:00Z", aesthetic: "2026-11-02T09:00:00Z" } });
    expect(decideSplit(e, RULES)).toEqual({ clientId: A, reason: "kept" });
  });

  it("with the keep switch off, a removed tag sends the lead to the no-tag choice", () => {
    const off = { ...RULES, keepRemoved: false };
    const e = ev({ tags: [], owner: A, history: { aesthetic: "2026-11-02T09:00:00Z" } });
    expect(decideSplit(e, off)).toEqual({ clientId: V, reason: "no_tag" });
    expect(decideSplit(e, { ...off, untagged: null })).toEqual({ clientId: null, reason: "no_tag" });
  });

  it("keeps an owner whose tag left the rules only via the latest-tag fallback", () => {
    // A's tag 'aesthetic' was taken out of the rules; only 'botox' remains A's.
    const rules: ShareRules = { ...RULES, tags: new Map([[V, ["lasik"]], [A, ["botox"]]]) };
    const e = ev({ tags: [], owner: A, history: { lasik: "2026-11-03T09:00:00Z" } });
    expect(decideSplit(e, rules)).toEqual({ clientId: V, reason: "kept" });
  });
});

describe("decideSplit — R4: no client's tag", () => {
  it("never tagged → the no-tag choice", () => {
    expect(decideSplit(ev({ tags: ["meta"] }), RULES)).toEqual({ clientId: V, reason: "no_tag" });
    expect(decideSplit(ev({ tags: ["meta"] }), { ...RULES, untagged: null })).toEqual({ clientId: null, reason: "no_tag" });
  });

  it("never read, with no history → 'unread', counted for the no-tag choice", () => {
    expect(decideSplit(ev({ tags: null, fetchedAt: null }), RULES)).toEqual({ clientId: V, reason: "unread" });
  });

  it("never read, but the webhook log saw its tag → that tag decides", () => {
    const e = ev({ tags: null, fetchedAt: null, history: { aesthetic: "2026-11-01T09:00:10Z" } });
    expect(decideSplit(e, RULES)).toEqual({ clientId: A, reason: "tag" });
  });

  it("ignores tags that are not split tags", () => {
    const e = ev({ tags: ["booked", "meta"], history: { booked: "2026-11-01T09:00:00Z" } });
    expect(decideSplit(e, RULES)).toEqual({ clientId: V, reason: "no_tag" });
  });
});

describe("seenAt — dating a tag we did not watch arrive", () => {
  const split = new Set(["lasik", "aesthetic", "botox"]);

  it("uses the history row when there is one", () => {
    const e = ev({ history: { lasik: "2026-11-02T00:00:00Z" } });
    expect(seenAt("lasik", e, split)).toBe(t("2026-11-02T00:00:00Z").getTime());
  });

  it("dates a current tag with no row to the last read, never its creation", () => {
    const e = ev({ fetchedAt: t("2026-11-10T10:00:00Z") });
    expect(seenAt("aesthetic", e, split)).toBe(t("2026-11-10T10:00:00Z").getTime());
  });

  it("never dates it ahead of a split tag we saw arrive", () => {
    // Watched 'lasik' arrive on 1 Mar; 'aesthetic' found later by a repair must sort after it.
    const e = ev({ fetchedAt: t("2026-03-01T08:00:00Z"), history: { lasik: "2026-03-01T09:00:05Z" } });
    expect(seenAt("aesthetic", e, split)).toBe(t("2026-03-01T09:00:05Z").getTime() + 1);
    // …so with no owner, 'lasik' (seen first) wins R2 instead of the repaired tag.
    expect(decideSplit({ ...e, tags: ["lasik", "aesthetic"] }, RULES)).toEqual({ clientId: V, reason: "first_tag" });
  });

  it("falls back to creation for a contact never read", () => {
    const e = ev({ fetchedAt: null, createdAt: t("2026-01-01T00:00:00Z") });
    expect(seenAt("botox", e, split)).toBe(t("2026-01-01T00:00:00Z").getTime());
  });
});

describe("validateShareRules", () => {
  const share = {
    clients: new Map([
      [V, "Aloha LASER Vision"],
      [A, "Aloha Laser Aesthetic"],
    ]),
    knownTags: new Set(["lasik", "aesthetic", "botox", "meta"]),
  };

  it("normalises tags and keeps each client's own", () => {
    const r = validateShareRules(
      { clients: [{ clientId: A, tags: [" Aesthetic ", "aesthetic", "BOTOX"] }], untagged: V, keepRemoved: true },
      share,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rules.tags.get(A)).toEqual(["aesthetic", "botox"]);
      expect(r.rules.tags.get(V)).toEqual([]);
    }
  });

  it("refuses a tag given to two clients, naming who has it", () => {
    const r = validateShareRules(
      {
        clients: [
          { clientId: A, tags: ["aesthetic"] },
          { clientId: V, tags: ["aesthetic"] },
        ],
        untagged: V,
        keepRemoved: true,
      },
      share,
    );
    expect(r).toEqual({
      ok: false,
      error: "The tag “aesthetic” already belongs to Aloha Laser Aesthetic. A tag can belong to one client only.",
    });
  });

  it("refuses a tag no contact carries, and a stranger as the no-tag choice", () => {
    expect(validateShareRules({ clients: [{ clientId: A, tags: ["aesthetics"] }], untagged: V, keepRemoved: true }, share).ok).toBe(false);
    expect(validateShareRules({ clients: [], untagged: "someone-else", keepRemoved: true }, share).ok).toBe(false);
    expect(validateShareRules({ clients: [{ clientId: "x", tags: [] }], untagged: null, keepRemoved: true }, share).ok).toBe(false);
  });

  it("knows whether a client would count any leads", () => {
    const r = validateShareRules({ clients: [{ clientId: A, tags: ["aesthetic"] }], untagged: V, keepRemoved: true }, share);
    expect(r.ok && wouldCountLeads(r.rules, A)).toBe(true);
    expect(r.ok && wouldCountLeads(r.rules, V)).toBe(true);
    const none = validateShareRules({ clients: [], untagged: V, keepRemoved: true }, share);
    expect(none.ok && wouldCountLeads(none.rules, A)).toBe(false);
  });
});
