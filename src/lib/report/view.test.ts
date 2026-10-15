import { describe, it, expect } from "vitest";
import { REPORT_SECTIONS, SECTIONS } from "@/lib/dashboard/registry";
import {
  DEFAULT_VIEW,
  KPI_OPTIONS,
  VIEW_SECTION_OPTIONS,
  decodeView,
  describeView,
  encodeView,
  isDefaultView,
  normalizeView,
  viewHasPersonal,
} from "./view";

describe("the default view", () => {
  it("is exactly what every report and share link showed before the choice existed", () => {
    expect(DEFAULT_VIEW.sections).toEqual([...REPORT_SECTIONS]);
    expect(DEFAULT_VIEW.kpis).toEqual(KPI_OPTIONS.map((k) => k.id));
    expect(normalizeView(DEFAULT_VIEW)).toEqual(DEFAULT_VIEW);
  });

  it("includes nothing that lists people", () => {
    expect(viewHasPersonal(DEFAULT_VIEW)).toBe(false);
  });
});

describe("the options offered", () => {
  it("never offers an agency-only section", () => {
    const staffOnly = SECTIONS.filter((s) => s.staffOnly).map((s) => s.id);
    expect(staffOnly.length).toBeGreaterThan(0);
    for (const id of staffOnly) {
      expect(VIEW_SECTION_OPTIONS.some((o) => o.id === id)).toBe(false);
    }
  });

  it("marks every section that lists people", () => {
    const pii = SECTIONS.filter((s) => s.containsLeadPii).map((s) => s.id).sort();
    const marked = VIEW_SECTION_OPTIONS.filter((o) => o.personal).map((o) => o.id).sort();
    expect(marked).toEqual(pii);
  });
});

describe("normalizeView", () => {
  it("adds the lead-source note, drops unknown ids and puts sections in dashboard order", () => {
    const v = normalizeView({ sections: ["campaigns", "nonsense", "kpis", "kpis"], kpis: ["spend"] });
    expect(v).toEqual({ sections: ["lead_filter_note", "kpis", "campaigns"], kpis: ["spend"] });
  });

  it("refuses agency-only sections even when asked for by id", () => {
    const v = normalizeView({ sections: ["keep_kill", "budget_pacing", "funnel"] });
    expect(v?.sections).toEqual(["lead_filter_note", "funnel"]);
  });

  it("removes the headline block when no headline number is chosen", () => {
    expect(normalizeView({ sections: ["kpis", "funnel"], kpis: [] })?.sections).toEqual([
      "lead_filter_note",
      "funnel",
    ]);
  });

  it("means every headline number when the list is absent", () => {
    expect(normalizeView({ sections: ["kpis"] })?.kpis).toEqual(KPI_OPTIONS.map((k) => k.id));
  });

  it("is null when nothing but the note would remain", () => {
    expect(normalizeView({ sections: [] })).toBeNull();
    expect(normalizeView({ sections: ["kpis"], kpis: [] })).toBeNull();
    expect(normalizeView(null)).toBeNull();
    expect(normalizeView({ sections: "kpis" })).toBeNull();
  });
});

describe("encode / decode", () => {
  it("round-trips", () => {
    const v = normalizeView({ sections: ["kpis", "pipeline", "trend"], kpis: ["cpLead", "spend"] })!;
    expect(decodeView(encodeView(v))).toEqual(v);
  });

  it("treats junk as no view at all", () => {
    expect(decodeView("")).toBeNull();
    expect(decodeView("garbage")).toBeNull();
    expect(decodeView("s=")).toBeNull();
    expect(decodeView("x".repeat(3000))).toBeNull();
  });

  it("knows the default when it sees it", () => {
    expect(isDefaultView(decodeView(encodeView(DEFAULT_VIEW))!)).toBe(true);
    expect(isDefaultView(normalizeView({ sections: ["kpis"] })!)).toBe(false);
  });
});

describe("describeView", () => {
  it("names the size of the choice and warns about lead names", () => {
    expect(describeView(normalizeView({ sections: ["kpis", "funnel"], kpis: ["spend", "cpLead"] })!)).toBe(
      "2 sections · 2 of 8 headline numbers",
    );
    expect(describeView(normalizeView({ sections: ["pipeline"] })!)).toBe(
      "1 section · includes lead names",
    );
  });
});
