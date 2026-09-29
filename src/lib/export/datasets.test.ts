import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLUMNS } from "@/lib/metrics/table-columns";
import { EMPTY_ADS, EMPTY_FUNNEL, derive } from "@/lib/metrics/compute";
import type { DailyPoint, LeadRow, PeriodMetrics } from "@/lib/metrics/queries";
import type { CampaignStageRow } from "@/lib/metrics/campaign-stages";
import { trailingMonths, windowFromKeys } from "@/lib/dates";
import { buildCsv } from "./csv";
import {
  DATASETS,
  DATASET_BUILDERS,
  DATASET_IDS,
  DATASET_ROW_CAP,
  campaignsTable,
  dailyTable,
  isDatasetId,
  leadsTable,
  monthlyTable,
} from "./datasets";

const TZ = "America/Los_Angeles";

function point(dateKey: string, over: Partial<DailyPoint> = {}): DailyPoint {
  const funnel = { ...EMPTY_FUNNEL, new_lead: 10, appointment_booked: 4, ...over.funnel };
  const ads = { ...EMPTY_ADS, spend: 100, impressions: 5000, linkClicks: 200, ...over.ads };
  return { dateKey, funnel, ads, derived: derive(funnel, ads, null) };
}

function period(label: string, startKey: string, endKey: string): PeriodMetrics {
  const funnel = { ...EMPTY_FUNNEL, new_lead: 65, closed_won: 2 };
  const ads = { ...EMPTY_ADS, spend: 364.45 };
  return {
    label,
    window: windowFromKeys(startKey, endKey, TZ),
    funnel,
    ads,
    revenue: null,
    derived: derive(funnel, ads, null),
  };
}

/**
 * A real RFC 4180 reader, because splitting on commas is exactly the bug this
 * export has to not have.
 *
 * The first version of this helper was `line.split(",")`, and it reported two
 * failures against correct output — a campaign named `=Summer, Promo` and a
 * lead named `Doe, Jane` both shifted every column after them. That is the
 * consumer's experience of a broken writer, so the test reads the file the way
 * a spreadsheet does and asserts on decoded values.
 */
function parse(csv: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = csv.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && src[i + 1] === "\n") {
      row.push(field);
      out.push(row);
      row = [];
      field = "";
      i++;
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

/** Raw physical lines, for the assertions where the quoting IS the point. */
const rawLines = (csv: string) => csv.replace(/^﻿/, "").split("\r\n");

describe("dataset registry", () => {
  it("accepts only the ids it declares", () => {
    for (const d of DATASETS) expect(isDatasetId(d.id)).toBe(true);
    expect(isDatasetId("contacts")).toBe(false);
    expect(isDatasetId("")).toBe(false);
    // The parameter reaches a filename and a switch; a traversal attempt is not
    // an id and must be refused at the type boundary rather than sanitised.
    expect(isDatasetId("../../etc/passwd")).toBe(false);
  });

  it("marks exactly the dataset that carries personal data", () => {
    expect(DATASETS.filter((d) => d.personal).map((d) => d.id)).toEqual(["leads"]);
  });
});

describe("dailyTable", () => {
  it("🔴 carries exactly the report tables' columns, in order", () => {
    /*
     * Identity with `COLUMNS`, not similarity. A second list would drift, and a
     * client reconciling a spreadsheet against the dashboard would find a
     * column that disagrees with no way to tell which one is right.
     */
    const t = dailyTable([point("2026-07-01")]);
    expect(t.headers).toEqual(["Date", ...COLUMNS.map((c) => c.label)]);
  });

  it("writes one row per day, dated first", () => {
    const t = dailyTable([point("2026-07-01"), point("2026-07-02")]);
    expect(t.rows).toHaveLength(2);
    expect(parse(buildCsv(t))[1][0]).toBe("2026-07-01");
  });

  it("emits money unformatted and percentages as the header's unit", () => {
    const row = parse(buildCsv(dailyTable([point("2026-07-01")])))[1];
    const at = (label: string) => row[1 + COLUMNS.findIndex((c) => c.label === label)];
    expect(at("Spend")).toBe("100.00");
    expect(at("CP-Lead")).toBe("10.00");
    // 4 appts / 10 leads.
    expect(at("Book %")).toBe("40.00");
  });

  it("leaves an undefined cost empty rather than writing zero", () => {
    const zero = point("2026-07-01", { ads: { ...EMPTY_ADS, spend: 0 } });
    const row = parse(buildCsv(dailyTable([zero])))[1];
    const at = (label: string) => row[1 + COLUMNS.findIndex((c) => c.label === label)];
    expect(at("Spend")).toBe("0.00");
    expect(at("CP-Lead")).toBe("");
  });

  it("handles an empty range", () => {
    expect(dailyTable([]).rows).toEqual([]);
  });
});

describe("monthlyTable", () => {
  it("🔴 spells out each row's own bounds", () => {
    /*
     * `monthOnMonth` is a fixed trailing 12 months and ignores the date picker.
     * Without the bounds per row, a file exported with a 7-day range selected
     * silently contains a year and reads as though it honoured the range.
     */
    const t = monthlyTable([period("Jul 2026", "2026-07-01", "2026-07-31")]);
    expect(t.headers.slice(0, 3)).toEqual(["Month", "From", "To"]);
    const row = parse(buildCsv(t))[1];
    expect(row.slice(0, 3)).toEqual(["Jul 2026", "2026-07-01", "2026-07-31"]);
  });

  it("regression: the CSV reproduces the source spreadsheet's December", () => {
    // $364.45 spend / 65 leads / $5.61 CP-LEAD / 2 won — the figures the
    // metrics engine is regression-tested against, now through the export.
    const row = parse(buildCsv(monthlyTable([period("Dec 2025", "2025-12-01", "2025-12-31")])))[1];
    const at = (label: string) => row[3 + COLUMNS.findIndex((c) => c.label === label)];
    expect(at("Spend")).toBe("364.45");
    expect(at("Leads")).toBe("65");
    expect(at("CP-Lead")).toBe("5.61");
    expect(at("Won")).toBe("2");
  });
});

describe("campaignsTable", () => {
  const row: CampaignStageRow = {
    campaignId: "120363012345678901",
    campaignName: "=Summer, Promo",
    platform: "meta",
    spend: 500,
    impressions: 20000,
    linkClicks: 400,
    counts: { new_lead: 20, appointment_booked: 5, showed: 2, closed_won: 1 },
    costs: {
      new_lead: { cost: 25, conversions: 20 },
      appointment_booked: { cost: 100, conversions: 5 },
      showed: { cost: 250, conversions: 2 },
      closed_won: { cost: null, conversions: 0 },
    },
  };

  it("🔴 writes the campaign id as text so a spreadsheet cannot round it", () => {
    /*
     * A 17-digit Meta id parsed as a number renders `1.20363E+17` and no longer
     * matches Ads Manager — which is the only thing this column is for.
     */
    expect(parse(buildCsv(campaignsTable([row])))[1][1]).toBe("120363012345678901");
    // Quoted on the wire — that is what stops the spreadsheet typing it as a
    // number, and it is invisible to the parser above.
    expect(rawLines(buildCsv(campaignsTable([row])))[1]).toContain(
      '"120363012345678901"',
    );
  });

  it("defuses a campaign name that would otherwise execute", () => {
    const out = buildCsv(campaignsTable([row]));
    expect(out).toContain(`"'=Summer, Promo"`);
  });

  it("leaves an undefined stage cost empty", () => {
    const out = parse(buildCsv(campaignsTable([row])))[1];
    expect(out[out.length - 1]).toBe("");
  });
});

describe("leadsTable", () => {
  const lead: LeadRow = {
    id: "id-1",
    name: "Doe, Jane",
    campaignName: "Summer",
    campaignId: "120363012345678901",
    ghlStageName: "Booked Consult",
    ghlPipelineName: "Main",
    canonicalStage: "appointment_booked",
    displayOrder: 3,
    createdAt: "2026-07-04T12:00:00.000Z",
    value: 0,
    status: "open",
  };

  it("🔴 carries no email and no phone column", () => {
    /*
     * Both are in the schema. Neither is here, and neither is on the dashboard —
     * so exporting them would put more personal data in a downloads folder than
     * the product shows on screen. GHL is the system of record for contact
     * details and has its own access control.
     */
    const headers = leadsTable([]).headers.map((h) => h.toLowerCase());
    expect(headers).not.toContain("email");
    expect(headers).not.toContain("phone");
    expect(headers.some((h) => /mail|phone|mobile/.test(h))).toBe(false);
  });

  it("names both the canonical stage and the client's own GHL stage", () => {
    const out = parse(buildCsv(leadsTable([lead])))[1];
    expect(out[2]).toBe("Appointment Booked");
    expect(out[3]).toBe("Booked Consult");
  });

  it("🔴 keeps a comma-bearing name in ONE field", () => {
    /*
     * `Doe, Jane` is the ordinary case, not an edge case — GHL stores plenty of
     * names this way. Unquoted it becomes two fields and every column to its
     * right shifts by one, so the stage column reads a date and the export is
     * wrong in a way that looks like data rather than like a bug.
     */
    const csv = buildCsv(leadsTable([lead]));
    const row = parse(csv)[1];
    expect(row[0]).toBe("Doe, Jane");
    expect(row).toHaveLength(leadsTable([lead]).headers.length);
    expect(rawLines(csv)[1].startsWith('"Doe, Jane",')).toBe(true);
  });

  it("writes an unrecorded deal value as 0.00 rather than blank", () => {
    // Blanking would erase the difference between a $0 deal and one nobody
    // priced, and for most of this book that is every row.
    const out = parse(buildCsv(leadsTable([lead])));
    expect(out[1][out[1].length - 1]).toBe("0.00");
  });

  it("survives a lead with nothing but an id", () => {
    const bare: LeadRow = {
      ...lead,
      name: null,
      campaignName: null,
      campaignId: null,
      ghlStageName: null,
      ghlPipelineName: null,
      canonicalStage: null,
      createdAt: null,
      status: null,
    };
    expect(() => buildCsv(leadsTable([bare]))).not.toThrow();
  });
});

describe("the export route", () => {
  const src = readFileSync(
    join(process.cwd(), "src/app/api/c/[slug]/export/route.ts"),
    "utf8",
  );

  /*
   * Source assertions, so they must match CODE rather than prose: an earlier
   * version checked for the bare identifiers and for "403", both of which also
   * appear in this file's comments — deleting the guard or the gate left the
   * tests green. Comments are stripped first, and the patterns require the
   * actual call shapes.
   */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("🔴 is guarded, and scoped to one tenant", () => {
    /*
     * A raw export of a client's leads, spend and pipeline is the
     * highest-value single response in the application. The tier widened from
     * staff to agency to client (a client may take their OWN numbers); what
     * never changed is `getClientForSession`, the scoping that returns null
     * across a tenant boundary regardless of role.
     */
    expect(code).toMatch(/await\s+clientAccessGuard\(\s*slug\s*\)/);
    expect(code).toMatch(/if\s*\(\s*denied\s*\)\s*return\s+denied/);
    expect(code).toMatch(/await\s+getClientForSession\(\s*session\s*,\s*slug\s*\)/);
  });

  it("🔴 still refuses personal datasets to client-role callers", () => {
    /*
     * The counterweight to widening the guard: the LEAD LIST does not leave
     * with a client-role user. Asserted as the real condition and its 403, so
     * deleting or inverting the gate fails here.
     */
    expect(code).toMatch(
      /\.personal\s*&&\s*!isAgencyOperator\(\s*session\s*\)\s*\)\s*\{\s*return\s+NextResponse\.json\([\s\S]{0,300}?status:\s*403/,
    );
  });

  it("🔴 sends the file as an attachment, not inline", () => {
    /*
     * Inline, a browser renders the CSV as a page and the download never
     * happens; worse, a text/csv rendered inline has been an XSS vector in
     * older browsers. `attachment` is both the working behaviour and the safe
     * one.
     */
    expect(src).toContain('"Content-Disposition": `attachment;');
  });

  it("🔴 forbids caching a file containing spend and lead names", () => {
    expect(src).toContain("no-store");
  });

  it("audits every export, recording whether it carried personal data", () => {
    expect(src).toContain("client.exported");
    expect(src).toContain("personal:");
  });
});

describe("DATASET_BUILDERS", () => {
  it("🔴 has a builder for every dataset id", () => {
    /*
     * The type already enforces this — `Record<DatasetId, DatasetBuilder>` will
     * not compile with a member missing. This is the runtime backstop for the
     * one way round that: an `as any` or an `as DatasetBuilder` cast added in a
     * hurry.
     *
     * It matters more than a usual exhaustiveness check because of what the old
     * code did when a dataset was unrecognised: the nested ternary it replaced
     * fell through to `leadsTable`, so an unmatched id served the LEAD LIST
     * under the wrong filename and logged `personal: false` while doing it.
     */
    expect(Object.keys(DATASET_BUILDERS).sort()).toEqual(
      [...DATASET_IDS].sort(),
    );
  });

  it("declares a range resolver exactly when the source is deferred", () => {
    for (const [id, b] of Object.entries(DATASET_BUILDERS)) {
      if (b.source === "deferred") {
        // Deferred datasets ignore the picker, so they must report the bounds
        // they actually contain or the filename claims a range the rows do not
        // cover.
        expect(typeof b.range, id).toBe("function");
      } else {
        expect(b.source, id).toBe("dashboard");
      }
    }
  });

  it("routes only month-on-month through the deferred loader", () => {
    const deferred = Object.entries(DATASET_BUILDERS)
      .filter(([, b]) => b.source === "deferred")
      .map(([id]) => id);
    expect(deferred).toEqual(["monthly"]);
  });
});

describe("DATASET_ROW_CAP", () => {
  it("matches the limit the leads query is actually called with", () => {
    /*
     * Read from dashboard.ts rather than restated here, so moving the query's
     * limit without moving the cap fails — a stale cap makes the truncation
     * signal lie in the quieter direction.
     */
    const dash = readFileSync(
      join(process.cwd(), "src/lib/metrics/dashboard.ts"),
      "utf8",
    );
    const m = dash.match(/getLeads\(\s*client\.id\s*,\s*\w+\s*,\s*(\d+)/);
    expect(m, "getLeads call not found in dashboard.ts").not.toBeNull();
    expect(DATASET_ROW_CAP).toEqual({ leads: Number(m![1]) });
  });

  it("only caps ids that exist", () => {
    for (const id of Object.keys(DATASET_ROW_CAP)) {
      expect(DATASET_IDS).toContain(id);
    }
  });
});

describe("month-on-month range", () => {
  it("🔴 returns start <= end for the real, newest-first month list", () => {
    /*
     * `trailingMonths` returns months NEWEST FIRST. The resolver took the
     * first element's start and the last element's end, so start was this
     * month and end was eleven months ago. For CSV that garbled the filename;
     * for PDF it failed the render page's start > end guard, and every
     * month-on-month PDF was a PDF of a 404. Driven through the real
     * `trailingMonths`, so the order it produces is the order tested.
     */
    const months = trailingMonths(12, TZ);
    const tables = {
      monthOnMonth: months.map((w) => ({ window: w })),
    } as unknown as Parameters<
      Extract<(typeof DATASET_BUILDERS)["monthly"], { source: "deferred" }>["range"]
    >[0];
    const b = DATASET_BUILDERS.monthly;
    if (b.source !== "deferred") throw new Error("monthly must be deferred");
    const [start, end] = b.range(tables);
    expect(start <= end).toBe(true);
    expect(start).toBe(months.map((m) => m.startKey).sort()[0]);
    expect(end).toBe(months.map((m) => m.endKey).sort().at(-1));
  });
});
