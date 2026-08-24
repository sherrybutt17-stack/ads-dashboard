import { describe, it, expect } from "vitest";
import {
  resolveLayout,
  resolveLayoutFull,
  SECTIONS,
  LAYOUT_SCHEMA_VERSION,
} from "./registry";
import {
  ClientLayoutSchema,
  StaffLayoutSchema,
  authorizeLayoutWrite,
  defaultAudience,
  parseAudience,
} from "./layout-write";
import type { SessionPayload } from "@/lib/session";

/**
 * Stored dashboard layouts.
 *
 * `resolveLayout` is the only function in this codebase that is required to be
 * TOTAL — it must never throw, for any input, ever. It stands between a jsonb
 * column and the page: if it can be made to fail, a display preference takes
 * down a dashboard full of real numbers. So the first block below throws
 * genuinely hostile values at it rather than testing the happy path twice.
 *
 * The second concern is the `locked` escape hatch, structurally identical to
 * W3's `clientEditable`: the flag that governs the write lives on the row being
 * written, so a naive implementation lets a frozen-out client send
 * `{"sections":[…],"locked":false}` and thaw themselves.
 */

const ids = (layout: ReturnType<typeof resolveLayout>) => layout.map((s) => s.id);
const REQUIRED = SECTIONS.filter((s) => s.required).map((s) => s.id);

describe("resolveLayout is total", () => {
  const hostile: unknown[] = [
    null,
    undefined,
    0,
    "",
    "not a layout",
    [],
    {},
    { sections: null },
    { sections: "nope" },
    { sections: [] },
    { sections: [null, undefined, 0, "x"] },
    { sections: [{}, { id: 1 }, { visible: true }] },
    { sections: [{ id: "kpis" }] }, // no `visible`
    { schemaVersion: "one", sections: [{ id: "kpis", visible: true }] },
    { schemaVersion: -3, sections: [{ id: "kpis", visible: true }] },
    [{ id: "kpis", visible: true }], // the pre-persistence bare-array shape
  ];

  for (const [i, input] of hostile.entries()) {
    it(`survives hostile input #${i}: ${JSON.stringify(input)?.slice(0, 48)}`, () => {
      const out = resolveLayout(input as never);
      expect(Array.isArray(out)).toBe(true);
      // Never an EMPTY page, either — a dashboard with no sections at all is a
      // failure that looks like a design choice.
      expect(out.length).toBeGreaterThan(0);
      for (const req of REQUIRED) expect(ids(out)).toContain(req);
    });
  }
});

describe("the six resolution rules", () => {
  it("1 — a stored id that is no longer in the registry is dropped", () => {
    const out = resolveLayout({
      sections: [
        { id: "kpis", visible: true },
        { id: "a_section_we_deleted", visible: true },
        { id: "funnel", visible: true },
      ],
    });
    expect(ids(out)).not.toContain("a_section_we_deleted");
    expect(ids(out)).toContain("funnel");
  });

  it("2 — a NEW registry section is inserted, VISIBLE, and flagged", () => {
    /*
     * The most important rule here. A dashboard that silently omits a newly
     * shipped capability is precisely the `SHOWN = 0` failure this project
     * exists to replace — so an unknown-to-the-layout section defaults to
     * shown, and is marked so the settings UI can say why it appeared.
     */
    const saved = [
      { id: "lead_filter_note", visible: true },
      { id: "kpis", visible: true },
    ];
    const full = resolveLayoutFull({ sections: saved });

    const fresh = full.filter((s) => s.isNew);
    expect(fresh.length).toBeGreaterThan(0);
    for (const s of fresh) {
      expect(s.visible).toBe(s.def.defaultVisible);
      expect(s.visible).toBe(true);
    }
    // …and the two that WERE saved are not flagged as new.
    expect(full.find((s) => s.def.id === "kpis")?.isNew).toBe(false);
  });

  it("2b — a new section lands at its DEFAULT position, not at the bottom", () => {
    // Stored positions are indices; ordering new arrivals on the raw
    // `defaultOrder` scale would push every one of them past every stored
    // section, which is how a new section ends up silently at the foot of the
    // page where nobody scrolls.
    const out = ids(
      resolveLayout({
        sections: [
          { id: "lead_filter_note", visible: true },
          { id: "kpis", visible: true },
          { id: "report_tables", visible: true },
        ],
      }),
    );
    expect(out.indexOf("funnel")).toBeGreaterThan(out.indexOf("kpis"));
    expect(out.indexOf("funnel")).toBeLessThan(out.indexOf("report_tables"));
  });

  it("3 — required sections stay visible however they were stored", () => {
    const out = ids(
      resolveLayout({
        sections: SECTIONS.map((s) => ({ id: s.id, visible: false })),
      }),
    );
    for (const req of REQUIRED) expect(out).toContain(req);
    // …and everything optional really is gone.
    expect(out.length).toBe(REQUIRED.length);
  });

  it("4 — a schema version AHEAD of this code falls back to defaults", () => {
    /*
     * Written by a newer deploy, during a rollout or after a rollback. We have
     * never seen the shape, so any interpretation is a guess — and a wrong
     * guess renders a dashboard missing sections. Defaults are the only honest
     * reading, and the row is left intact for the newer deploy.
     */
    /*
     * Counting sections proves nothing here — honouring the row yields the same
     * COUNT, since every unlisted section is inserted visible. A mutation test
     * caught exactly that.
     *
     * `report_tables` is the probe because it is LAST by default: if the stored
     * row is honoured it jumps to the front, and if it is ignored it stays at
     * the back. Order and `isNew` then both discriminate.
     */
    const stored = { sections: [{ id: "report_tables", visible: true }] };
    // Computed for the audience being resolved: without `staff: true` the
    // registry these calls see excludes staff-only sections entirely.
    const defaultOrder = [...SECTIONS]
      .filter((s) => !s.staffOnly)
      .sort((a, b) => a.defaultOrder - b.defaultOrder)
      .map((s) => s.id);

    const future = resolveLayoutFull({
      ...stored,
      schemaVersion: LAYOUT_SCHEMA_VERSION + 1,
    });
    expect(future.map((s) => s.def.id)).toEqual(defaultOrder);
    expect(future.some((s) => s.isNew)).toBe(false);

    // The control: the identical row at the CURRENT version IS honoured, so the
    // assertions above cannot be passing for an unrelated reason.
    const honoured = resolveLayoutFull({
      ...stored,
      schemaVersion: LAYOUT_SCHEMA_VERSION,
    });
    expect(honoured.map((s) => s.def.id)).not.toEqual(defaultOrder);
    expect(honoured.map((s) => s.def.id).indexOf("report_tables")).toBeLessThan(
      honoured.length - 1,
    );
    expect(honoured.some((s) => s.isNew)).toBe(true);
  });

  it("5 — duplicate ids collapse to the FIRST, not the last", () => {
    // Asserted in both directions. "The first wins" and "both are dropped"
    // would look identical from one example alone.
    const firstHidden = resolveLayoutFull({
      sections: [
        { id: "funnel", visible: false },
        { id: "funnel", visible: true },
      ],
    }).filter((s) => s.def.id === "funnel");
    expect(firstHidden).toHaveLength(1);
    expect(firstHidden[0].visible).toBe(false);

    const firstShown = resolveLayoutFull({
      sections: [
        { id: "funnel", visible: true },
        { id: "funnel", visible: false },
      ],
    }).filter((s) => s.def.id === "funnel");
    expect(firstShown).toHaveLength(1);
    expect(firstShown[0].visible).toBe(true);
  });

  it("6 — stored ORDER wins over default order", () => {
    const out = ids(
      resolveLayout({
        sections: [
          { id: "report_tables", visible: true },
          { id: "kpis", visible: true },
          { id: "lead_filter_note", visible: true },
        ],
      }),
    );
    expect(out.indexOf("report_tables")).toBeLessThan(out.indexOf("kpis"));
  });

  it("a saved layout round-trips unchanged", () => {
    // Canonicalise-on-write only works if resolving twice is a no-op.
    const once = resolveLayoutFull({
      sections: [
        { id: "kpis", visible: true },
        { id: "funnel", visible: false },
      ],
    }).map((s) => ({ id: s.def.id, visible: s.visible }));
    const twice = resolveLayoutFull({ sections: once }).map((s) => ({
      id: s.def.id,
      visible: s.visible,
    }));
    expect(twice).toEqual(once);
  });
});

/* ------------------------------------------------------------------ *
 * The write path
 * ------------------------------------------------------------------ */

const AG = "00000000-0000-0000-0000-0000000000aa";
const staff: SessionPayload = { userId: "s1", agencyId: AG, role: "staff", slugs: [] };
const owner: SessionPayload = { userId: "c1", agencyId: AG, role: "client", slugs: ["acme"] };
const other: SessionPayload = { userId: "c2", agencyId: AG, role: "client", slugs: ["rival"] };
/*
 * 🔴 Both operator roles carry NO slugs, and that is not an oversight in the
 * fixture — `auth.ts` populates `slugs` for the `client` role only. It is the
 * exact condition that made the old `role === "staff"` check fail closed: an
 * agency operator fell past it into a slug test they can never pass.
 */
const agency: SessionPayload = { userId: "a1", agencyId: AG, role: "agency", slugs: [] };
const superadmin: SessionPayload = { userId: "sa", agencyId: AG, role: "superadmin", slugs: [] };

describe("who may write a layout", () => {
  it("anonymous cannot", () => {
    expect(
      authorizeLayoutWrite(null, "acme", "client", { locked: false }),
    ).toEqual({ ok: false, status: 401, error: "Unauthorized" });
  });

  it("staff can, including a locked layout", () => {
    expect(
      authorizeLayoutWrite(staff, "acme", "client", { locked: true }),
    ).toEqual({ ok: true, staff: true });
  });

  it("the owning client can when unlocked", () => {
    expect(
      authorizeLayoutWrite(owner, "acme", "client", { locked: false }),
    ).toEqual({ ok: true, staff: false });
  });

  it("🔴 the owning client cannot when locked", () => {
    const v = authorizeLayoutWrite(owner, "acme", "client", { locked: true });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(403);
  });

  it("🔴 a different client cannot", () => {
    const v = authorizeLayoutWrite(other, "acme", "client", { locked: false });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(403);
  });

  it("🔴 a client cannot write the STAFF row for their own client", () => {
    /*
     * Not pedantry: the staff row drives what the agency sees on the page they
     * use to judge whether this client's pipes are healthy. A client hiding the
     * campaign table there would blind the people paid to notice a dead feed.
     */
    const v = authorizeLayoutWrite(owner, "acme", "staff", { locked: false });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(403);
  });

  it("🔴 an agency operator can, including a locked layout", () => {
    // The role the tenancy migration exists to move toward. This returned a
    // flat 403 for every layout write while the check named `staff` alone.
    expect(
      authorizeLayoutWrite(agency, "acme", "client", { locked: true }),
    ).toEqual({ ok: true, staff: true });
  });

  it("🔴 a superadmin can", () => {
    expect(
      authorizeLayoutWrite(superadmin, "acme", "client", { locked: true }),
    ).toEqual({ ok: true, staff: true });
  });

  it("🔴 an agency operator may write the STAFF row", () => {
    /*
     * The route already lets an operator ASK for `?audience=staff` — it gates
     * that on `isAgencyOperator`. Before the fix this function then refused the
     * very request the route had just permitted, so the two halves of one
     * request disagreed about who an agency operator is.
     */
    expect(
      authorizeLayoutWrite(agency, "acme", "staff", { locked: false }),
    ).toEqual({ ok: true, staff: true });
  });

  it("routes each role to its own row by default", () => {
    expect(defaultAudience(staff)).toBe("staff");
    expect(defaultAudience(owner)).toBe("client");
    expect(defaultAudience(null)).toBe("client");
    // 🔴 Operators read their OWN view. Defaulting an agency operator to the
    // client row showed them, and let them edit, what their client sees.
    expect(defaultAudience(agency)).toBe("staff");
    expect(defaultAudience(superadmin)).toBe("staff");
  });

  it("rejects an audience that did not come from the enum", () => {
    expect(parseAudience("staff")).toBe("staff");
    expect(parseAudience("client")).toBe("client");
    for (const junk of ["admin", "", null, undefined, 1, {}]) {
      expect(parseAudience(junk)).toBeNull();
    }
  });
});

describe("what a client may send", () => {
  it("accepts a visibility list", () => {
    expect(
      ClientLayoutSchema.safeParse({
        sections: [{ id: "kpis", visible: true }],
      }).success,
    ).toBe(true);
  });

  it("🔴 REJECTS `locked` rather than ignoring it", () => {
    // The escape hatch, defence two: even an unlocked client must not be able
    // to make that permanent.
    expect(
      ClientLayoutSchema.safeParse({ sections: [], locked: false }).success,
    ).toBe(false);
    expect(
      ClientLayoutSchema.safeParse({ sections: [], locked: true }).success,
    ).toBe(false);
    // Staff may.
    expect(
      StaffLayoutSchema.safeParse({ sections: [], locked: false }).success,
    ).toBe(true);
  });

  it("rejects unknown keys at both levels", () => {
    expect(
      ClientLayoutSchema.safeParse({ sections: [], clientId: "x" }).success,
    ).toBe(false);
    expect(
      ClientLayoutSchema.safeParse({
        sections: [{ id: "kpis", visible: true, order: 3 }],
      }).success,
    ).toBe(false);
  });

  it("bounds the list so a payload cannot be used to bloat a row", () => {
    const huge = Array.from({ length: 65 }, (_, i) => ({
      id: `s${i}`,
      visible: true,
    }));
    expect(ClientLayoutSchema.safeParse({ sections: huge }).success).toBe(false);
  });

  it("takes ifUnmodifiedSince only as a real timestamp", () => {
    expect(
      ClientLayoutSchema.safeParse({
        sections: [],
        ifUnmodifiedSince: "2026-08-13T10:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      ClientLayoutSchema.safeParse({ sections: [], ifUnmodifiedSince: "yesterday" })
        .success,
    ).toBe(false);
  });
});


/* ------------------------------------------------------------------ *
 * Staff-only sections
 * ------------------------------------------------------------------ */

describe("staff-only sections", () => {
  const STAFF_ONLY = SECTIONS.filter((s) => s.staffOnly).map((s) => s.id);

  it("there is at least one, or these assertions prove nothing", () => {
    expect(STAFF_ONLY.length).toBeGreaterThan(0);
  });

  it("🔴 are absent for a client, in the page AND in the drawer", () => {
    /*
     * Absent rather than hidden. The customise drawer renders every entry
     * `resolveLayoutFull` returns, including invisible ones — so a section that
     * merely came back with `visible: false` would still appear to a client as
     * a checkbox they could tick, for a section that would never render.
     */
    const page = ids(resolveLayout(null, { staff: false }));
    const drawer = resolveLayoutFull(null, { staff: false }).map((s) => s.def.id);
    for (const id of STAFF_ONLY) {
      expect(page).not.toContain(id);
      expect(drawer).not.toContain(id);
    }
  });

  it("🔴 default to absent when the audience is not stated", () => {
    // Fail closed: a caller that forgets the flag must show LESS, not more.
    const drawer = resolveLayoutFull(null).map((s) => s.def.id);
    for (const id of STAFF_ONLY) expect(drawer).not.toContain(id);
  });

  it("are present for staff", () => {
    const drawer = resolveLayoutFull(null, { staff: true }).map((s) => s.def.id);
    for (const id of STAFF_ONLY) expect(drawer).toContain(id);
  });

  it("🔴 cannot be reintroduced by a stored layout naming one", () => {
    /*
     * The bypass worth closing. A client's layout row is written by a request
     * body; if a staff-only id in that row could put the section back, the
     * filter would be advisory. Rule 1 already drops ids the registry does not
     * hold, and filtering the REGISTRY rather than the result is what makes
     * that rule do this job too.
     */
    const stored = {
      sections: [
        ...STAFF_ONLY.map((id) => ({ id, visible: true })),
        { id: "kpis", visible: true },
      ],
    };
    const out = resolveLayoutFull(stored, { staff: false }).map((s) => s.def.id);
    for (const id of STAFF_ONLY) expect(out).not.toContain(id);
    expect(out).toContain("kpis");
  });
});
