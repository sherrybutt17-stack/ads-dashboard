import { describe, it, expect } from "vitest";
import {
  buildLeadSources,
  pageLabel,
  MIN_LEADS_FOR_RATE,
  type LeadSourceInput,
} from "./lead-sources";

/** n leads on one attribution object, `booked` of which reached an appointment. */
function leads(
  attribution: Record<string, unknown> | null,
  n: number,
  booked = 0,
  won = 0,
): LeadSourceInput[] {
  return Array.from({ length: n }, (_, i) => ({
    raw: attribution === null ? null : { attributionSource: attribution },
    appt: i < booked,
    won: i < won,
  }));
}

const group = (r: ReturnType<typeof buildLeadSources>, d: "page" | "form" | "medium") =>
  r.groups.find((g) => g.dimension === d)!;

describe("pageLabel", () => {
  it("drops the query string, so one page is one row", () => {
    // The UTMs live in the query string. Keeping it would split a single
    // landing page into one row per ad — the campaign table's job, not this one.
    expect(pageLabel("https://retainer.growthguild.us/ghloffer?utm_source=fb&ad_id=12")).toBe(
      "retainer.growthguild.us/ghloffer",
    );
  });

  it("treats a trailing slash as the same page", () => {
    expect(pageLabel("https://growthguild.us/contact-us/")).toBe(
      pageLabel("https://growthguild.us/contact-us"),
    );
  });

  it("lowercases the host but leaves the path alone", () => {
    // Hosts are case-insensitive; paths are not, and folding them would merge
    // two genuinely different pages.
    expect(pageLabel("https://Retainer.GrowthGuild.US/GhlOffer")).toBe(
      "retainer.growthguild.us/GhlOffer",
    );
  });

  it("shows an unparseable value rather than dropping the lead", () => {
    expect(pageLabel("not a url")).toBe("not a url");
  });

  it("renders the site root as a bare host", () => {
    expect(pageLabel("https://growthguild.us/")).toBe("growthguild.us");
  });
});

describe("buildLeadSources — the unattributed import", () => {
  it("counts leads with no attribution as coverage, never as a row", () => {
    /*
     * The regression this guards, and the whole reason the module exists.
     * The import rows book far worse than any real page because they were
     * never callable — so admitting them to the table would hand every page a
     * flattering comparison against a group that was never in the running.
     */
    const report = buildLeadSources([
      ...leads({ url: "https://a.com/x" }, 10, 5),
      ...leads(null, 900, 9),
    ]);

    expect(report.totalLeads).toBe(910);
    expect(report.unattributedLeads).toBe(900);

    const g = group(report, "page");
    expect(g.attributedLeads).toBe(10);
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0].value).toBe("a.com/x");
    expect(g.rows.some((r) => /import|unattributed/i.test(r.value))).toBe(false);
  });

  it("keeps 'no landing page' apart from 'no attribution at all'", () => {
    /*
     * Two different absences. A calendar booking genuinely has no landing page
     * and is a real answer; an import ghost has no attribution object and is a
     * gap in the record. Folded together, 180 real bookings would be buried
     * under 1,398 spreadsheet rows and both would become unreadable.
     */
    const report = buildLeadSources([
      ...leads({ medium: "calendar", mediumId: "cal_1" }, 12, 6),
      ...leads(null, 50),
    ]);

    const g = group(report, "page");
    expect(g.attributedLeads).toBe(12);
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0].value).toBe("No landing page");
    expect(g.rows[0].isResidual).toBe(true);
    expect(g.rows[0].leads).toBe(12);
    expect(report.unattributedLeads).toBe(50);
  });

  it("reads a bare attribution object as well as a nested one", () => {
    // Older rows hold the object unwrapped. Getting this wrong reads as
    // "no lead has any attribution" rather than as an error.
    const report = buildLeadSources([
      { raw: { url: "https://a.com/bare" }, appt: false, won: false },
      { raw: { attributionSource: { url: "https://a.com/bare" } }, appt: false, won: false },
    ]);
    expect(report.unattributedLeads).toBe(0);
    expect(group(report, "page").rows[0].leads).toBe(2);
  });

  it("treats an empty object as no attribution", () => {
    const report = buildLeadSources([{ raw: {}, appt: false, won: false }]);
    expect(report.unattributedLeads).toBe(1);
  });
});

describe("buildLeadSources — rates", () => {
  it("suppresses a book rate below the minimum", () => {
    // Three leads, three bookings reads "100%" and is noise. It still appears
    // as a row — those are real leads — but with no rate attached.
    const report = buildLeadSources(leads({ url: "https://a.com/tiny" }, 3, 3));
    const row = group(report, "page").rows[0];
    expect(row.leads).toBe(3);
    expect(row.appts).toBe(3);
    expect(row.bookRate).toBeNull();
  });

  it("states a rate once there are enough leads", () => {
    const n = MIN_LEADS_FOR_RATE;
    const report = buildLeadSources(leads({ url: "https://a.com/ok" }, n, n / 2));
    expect(group(report, "page").rows[0].bookRate).toBeCloseTo(0.5, 6);
  });
});

describe("buildLeadSources — ordering", () => {
  it("ranks by lead volume, not by book rate", () => {
    /*
     * Sorting by rate would put a one-lead-one-booking row at the top of every
     * table forever, and the first row of a table is read as its headline.
     */
    const report = buildLeadSources([
      ...leads({ url: "https://a.com/big" }, 80, 40),
      ...leads({ url: "https://a.com/perfect" }, 2, 2),
    ]);
    expect(group(report, "page").rows.map((r) => r.value)).toEqual([
      "a.com/big",
      "a.com/perfect",
    ]);
  });

  it("sinks the residual row below every real one, however large", () => {
    const report = buildLeadSources([
      ...leads({ medium: "manual" }, 500),
      ...leads({ url: "https://a.com/small" }, 3),
    ]);
    const rows = group(report, "page").rows;
    expect(rows[0].value).toBe("a.com/small");
    expect(rows[1].value).toBe("No landing page");
  });
});

describe("buildLeadSources — form and medium", () => {
  it("prefers a readable form name over an opaque id", () => {
    const report = buildLeadSources(
      leads({ formName: "GG | Lead Form | SEO 2", formId: "798747513329989" }, 4),
    );
    expect(group(report, "form").rows[0].value).toBe("GG | Lead Form | SEO 2");
  });

  it("falls back to formId, then mediumId, rather than saying 'unknown'", () => {
    // An id a reader can paste into GHL search beats a row that says nothing.
    expect(group(buildLeadSources(leads({ formId: "abc123" }, 1)), "form").rows[0].value).toBe(
      "abc123",
    );
    expect(group(buildLeadSources(leads({ mediumId: "cal_9" }, 1)), "form").rows[0].value).toBe(
      "cal_9",
    );
  });

  it("groups by the mechanism GHL recorded", () => {
    const report = buildLeadSources([
      ...leads({ medium: "calendar" }, 7),
      ...leads({ medium: "manual" }, 4),
    ]);
    expect(group(report, "medium").rows.map((r) => [r.value, r.leads])).toEqual([
      ["calendar", 7],
      ["manual", 4],
    ]);
  });

  it("carries appointment and won counts through per row", () => {
    const report = buildLeadSources(leads({ url: "https://a.com/x" }, 20, 11, 3));
    const row = group(report, "page").rows[0];
    expect([row.leads, row.appts, row.won]).toEqual([20, 11, 3]);
  });
});
