import { describe, it, expect } from "vitest";
import {
  DUPLICATE_WINDOW_DAYS,
  adjustedCostPerLead,
  buildDuplicates,
  normalizeEmail,
  normalizePhone,
  type DuplicateLead,
} from "./duplicates";

let seq = 0;
function lead(over: Partial<DuplicateLead> = {}): DuplicateLead {
  seq++;
  return {
    id: `l${seq}`,
    name: `Person ${seq}`,
    phone: null,
    email: null,
    createdAt: "2026-07-01T12:00:00.000Z",
    campaignName: null,
    ...over,
  };
}

const daysAfter = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * 86_400_000).toISOString();

describe("normalizePhone", () => {
  it("collapses formatting to one comparable key", () => {
    const forms = ["+1 (555) 010-0100", "555-010-0100", "15550100100", "555.010.0100"];
    const keys = new Set(forms.map(normalizePhone));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("5550100100");
  });

  it("drops a leading 1 only when it makes an 11-digit number", () => {
    // A genuine 10-digit number beginning with 1 must keep every digit.
    expect(normalizePhone("1234567890")).toBe("1234567890");
    expect(normalizePhone("11234567890")).toBe("1234567890");
  });

  it("🔴 rejects a run of one repeated digit", () => {
    /*
     * `0000000000` and `1111111111` are placeholders that appear in real CRM
     * data. Left in, they form the largest and most confident "duplicate" group
     * in the book, and it is entirely spurious.
     */
    expect(normalizePhone("0000000000")).toBeNull();
    expect(normalizePhone("(111) 111-1111")).toBeNull();
    expect(normalizePhone("999-999-9999")).toBeNull();
  });

  it("rejects anything too short to be a number", () => {
    expect(normalizePhone("1234")).toBeNull();
    expect(normalizePhone("ext. 402")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it("leaves a non-NANP number alone rather than guessing at it", () => {
    // 12 digits: not the one case this normaliser claims to handle.
    expect(normalizePhone("+44 20 7946 0958")).toBe("442079460958");
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Jane@Example.COM ")).toBe("jane@example.com");
  });

  it("🔴 does not fold plus-addressing", () => {
    /*
     * `jane+spa@x.com` usually reaches the same mailbox as `jane@x.com`, and
     * "usually" is not good enough for output whose suggested action is merging
     * two people. A miss is the safe error here; a false claim is not.
     */
    expect(normalizeEmail("jane+spa@example.com")).not.toBe(
      normalizeEmail("jane@example.com"),
    );
  });

  it("🔴 does not fold Gmail dots", () => {
    // Correct for Gmail, wrong for every other provider, and nothing here knows
    // which is behind a custom domain.
    expect(normalizeEmail("j.a.n.e@example.com")).not.toBe(
      normalizeEmail("jane@example.com"),
    );
  });

  it("rejects the free text that lands in this column", () => {
    for (const bad of ["", "n/a", "none", "jane@", "@example.com", "jane example.com"]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("buildDuplicates", () => {
  it("groups two arrivals sharing a phone number", () => {
    const r = buildDuplicates(
      [
        lead({ phone: "555-010-0100" }),
        lead({ phone: "+1 (555) 010-0100", createdAt: "2026-07-03T09:00:00.000Z" }),
      ],
      { totalLeads: 2 },
    );
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].match).toBe("phone");
    expect(r.groups[0].kind).toBe("duplicate");
    expect(r.redundantLeads).toBe(1);
  });

  it("orders a group oldest first", () => {
    const later = lead({ phone: "5550100100", createdAt: "2026-07-09T00:00:00.000Z" });
    const earlier = lead({ phone: "5550100100", createdAt: "2026-07-02T00:00:00.000Z" });
    const r = buildDuplicates([later, earlier], { totalLeads: 2 });
    expect(r.groups[0].leads.map((l) => l.id)).toEqual([earlier.id, later.id]);
  });

  it("leaves a lead that matches nothing out of the report", () => {
    const r = buildDuplicates(
      [lead({ phone: "5550100100" }), lead({ phone: "5550100200" })],
      { totalLeads: 2 },
    );
    expect(r.groups).toEqual([]);
    expect(r.redundantLeads).toBe(0);
  });

  it("counts every extra arrival, not just the second", () => {
    const three = [1, 2, 3].map((d) =>
      lead({ phone: "5550100100", createdAt: `2026-07-0${d}T00:00:00.000Z` }),
    );
    const r = buildDuplicates(three, { totalLeads: 3 });
    expect(r.groups[0].leads).toHaveLength(3);
    expect(r.redundantLeads).toBe(2);
  });

  describe("🔴 a returning customer is not a duplicate", () => {
    const base = "2026-01-05T00:00:00.000Z";

    it(`splits at ${DUPLICATE_WINDOW_DAYS} days`, () => {
      const near = buildDuplicates(
        [
          lead({ phone: "5550100100", createdAt: base }),
          lead({ phone: "5550100100", createdAt: daysAfter(base, DUPLICATE_WINDOW_DAYS) }),
        ],
        { totalLeads: 2 },
      );
      expect(near.groups[0].kind).toBe("duplicate");

      const far = buildDuplicates(
        [
          lead({ phone: "5550100100", createdAt: base }),
          lead({
            phone: "5550100100",
            createdAt: daysAfter(base, DUPLICATE_WINDOW_DAYS + 1),
          }),
        ],
        { totalLeads: 2 },
      );
      expect(far.groups[0].kind).toBe("returning");
    });

    it("does not count a return against cost per lead", () => {
      const r = buildDuplicates(
        [
          lead({ phone: "5550100100", createdAt: base }),
          lead({ phone: "5550100100", createdAt: daysAfter(base, 300) }),
        ],
        { totalLeads: 2 },
      );
      expect(r.redundantLeads).toBe(0);
      expect(r.returningGroups).toBe(1);
    });

    it("still reports the return rather than dropping it", () => {
      // "This campaign brings back previous customers" is worth knowing and
      // nothing else in the product surfaces it.
      const r = buildDuplicates(
        [
          lead({ phone: "5550100100", createdAt: base }),
          lead({ phone: "5550100100", createdAt: daysAfter(base, 300) }),
        ],
        { totalLeads: 2 },
      );
      expect(r.groups).toHaveLength(1);
      expect(r.groups[0].spanDays).toBeCloseTo(300, 0);
    });

    it("files an unparseable timestamp as a duplicate, not as a return", () => {
      // The safe direction: a duplicate gets looked at, a "returning customer"
      // gets filed under good news and never revisited.
      const r = buildDuplicates(
        [
          lead({ phone: "5550100100", createdAt: "not a date" }),
          lead({ phone: "5550100100", createdAt: base }),
        ],
        { totalLeads: 2 },
      );
      expect(r.groups[0].kind).toBe("duplicate");
    });
  });

  describe("🔴 coverage", () => {
    it("reports how many leads could be checked at all", () => {
      /*
       * The live shape: 1,411 of 1,605 contacts carry neither field, because
       * the historical import never populated them. Reporting a duplicate count
       * without this denominator states a fact about 12% of the book as though
       * it were a fact about the book.
       */
      const leads = [
        lead({ phone: "5550100100" }),
        lead({ phone: "5550100100", createdAt: "2026-07-02T00:00:00.000Z" }),
        ...Array.from({ length: 20 }, () => lead()),
      ];
      const r = buildDuplicates(leads, { totalLeads: 22 });
      expect(r.totalLeads).toBe(22);
      expect(r.checkableLeads).toBe(2);
    });

    it("counts a lead with only an email as checkable", () => {
      const r = buildDuplicates([lead({ email: "jane@example.com" })], {
        totalLeads: 1,
      });
      expect(r.checkableLeads).toBe(1);
    });

    it("does not count a lead whose phone is a placeholder", () => {
      const r = buildDuplicates([lead({ phone: "0000000000" })], { totalLeads: 1 });
      expect(r.checkableLeads).toBe(0);
    });
  });

  it("🔴 files a lead under one key, so a pair matching twice reports once", () => {
    /*
     * Filing under both phone and email would surface the same pair as two
     * separate rows, and they would read as two separate problems.
     */
    const r = buildDuplicates(
      [
        lead({ phone: "5550100100", email: "jane@example.com" }),
        lead({
          phone: "5550100100",
          email: "jane@example.com",
          createdAt: "2026-07-02T00:00:00.000Z",
        }),
      ],
      { totalLeads: 2 },
    );
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].match).toBe("phone");
  });

  it("matches on email when there is no phone", () => {
    const r = buildDuplicates(
      [
        lead({ email: "Jane@Example.com" }),
        lead({ email: "jane@example.com", createdAt: "2026-07-02T00:00:00.000Z" }),
      ],
      { totalLeads: 2 },
    );
    expect(r.groups[0].match).toBe("email");
  });

  it("🔴 does not match one lead's phone against another's email key", () => {
    // The keys are namespaced. Without the prefix a phone of `5550100100` and
    // an email that normalised to the same string would collide.
    const r = buildDuplicates(
      [lead({ phone: "5550100100" }), lead({ email: "5550100100@example.com" })],
      { totalLeads: 2 },
    );
    expect(r.groups).toEqual([]);
  });

  it("puts duplicates above returns, largest first", () => {
    const base = "2026-01-05T00:00:00.000Z";
    const r = buildDuplicates(
      [
        // A returning pair.
        lead({ phone: "5550100999", createdAt: base }),
        lead({ phone: "5550100999", createdAt: daysAfter(base, 200) }),
        // A duplicate pair…
        lead({ phone: "5550100111", createdAt: base }),
        lead({ phone: "5550100111", createdAt: daysAfter(base, 1) }),
        // …and a bigger one.
        lead({ phone: "5550100222", createdAt: base }),
        lead({ phone: "5550100222", createdAt: daysAfter(base, 1) }),
        lead({ phone: "5550100222", createdAt: daysAfter(base, 2) }),
      ],
      { totalLeads: 7 },
    );
    expect(r.groups.map((g) => g.kind)).toEqual([
      "duplicate",
      "duplicate",
      "returning",
    ]);
    expect(r.groups[0].leads).toHaveLength(3);
  });

  it("handles an empty book", () => {
    const r = buildDuplicates([], { totalLeads: 0 });
    expect(r).toMatchObject({
      groups: [],
      checkableLeads: 0,
      redundantLeads: 0,
      returningGroups: 0,
    });
  });
});

describe("adjustedCostPerLead", () => {
  it("divides spend by the unique leads", () => {
    expect(adjustedCostPerLead(1000, 100, 20)).toBeCloseTo(12.5, 6);
  });

  it("is null when there is nothing to correct", () => {
    // Two identical figures side by side invite a hunt for a difference that
    // is not there.
    expect(adjustedCostPerLead(1000, 100, 0)).toBeNull();
  });

  it("is null rather than infinite when every lead was a duplicate", () => {
    expect(adjustedCostPerLead(1000, 5, 5)).toBeNull();
    expect(adjustedCostPerLead(1000, 5, 9)).toBeNull();
  });

  it("is null with no spend, rather than reporting a free lead", () => {
    expect(adjustedCostPerLead(0, 100, 20)).toBeNull();
  });
});
