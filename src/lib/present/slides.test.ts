import { describe, it, expect } from "vitest";
import type { DashboardData } from "@/lib/metrics/dashboard";
import type { CommentaryForReport } from "@/lib/commentary/report";
import { resolveAccountability, type Commitment } from "@/lib/commentary/model";
import {
  buildDeck,
  clampSlide,
  formatValue,
  type MetricSlide,
  type Slide,
} from "./slides";

/**
 * The deck builder.
 *
 * Almost every test here is about what the deck REFUSES to contain. A slide
 * with nothing on it cannot be scrolled past on a screen share — the presenter
 * has to stand in front of a client and explain it — so the omissions, and the
 * reasons attached to them, are the feature.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const day = (over: Record<string, unknown> = {}) =>
  ({
    dateKey: "2026-08-01",
    funnel: {
      new_lead: 3, contacted: 2, appointment_booked: 1, showed: 1,
      no_show: 0, closed_won: 0, lost: 0, disqualified: 0, new_lead_qualified: 3,
    },
    ads: { spend: 120, impressions: 4000, clicksAll: 60, linkClicks: 50, fbLeads: 3, reach: null },
    derived: {
      cpLead: 40, cpLeadQualified: 40, cpAppt: 120, cpShow: 120, cpWon: null,
      bookPct: 1 / 3, showPct: 1, closePct: 0, optinPct: 0.06,
      ctr: 0.0125, cpm: 30, cpc: 2.4, roas: null, avgDeal: null,
    },
    ...over,
  }) as unknown as DashboardData["daily"][number];

const data = (over: Record<string, unknown> = {}): DashboardData =>
  ({
    client: {
      id: "c1", name: "Parfaire", slug: "parfaire",
      timezone: "America/Los_Angeles", currency: "USD",
      lastSyncedAt: null, firstWebhookAt: null,
    },
    range: { startKey: "2026-08-01", endKey: "2026-08-31", label: "Aug 1 – Aug 31" },
    current: {
      label: "current",
      window: {},
      funnel: {
        new_lead: 20, contacted: 14, appointment_booked: 7, showed: 4,
        no_show: 3, closed_won: 2, lost: 5, disqualified: 1, new_lead_qualified: 19,
      },
      ads: { spend: 940, impressions: 60_000, clicksAll: 900, linkClicks: 700, fbLeads: 18, reach: 40_000 },
      revenue: { wonOpps: 2, wonWithValue: 2, revenue: 18_400 },
      derived: {
        cpLead: 47, cpLeadQualified: 49.47, cpAppt: 134.29, cpShow: 235, cpWon: 470,
        bookPct: 0.35, showPct: 4 / 7, closePct: 0.5, optinPct: 0.028,
        ctr: 0.0117, cpm: 15.67, cpc: 1.34, roas: 19.57, avgDeal: 9200,
      },
    },
    previous: {},
    deltas: { spend: 0.12, new_lead: 0.4, cpLead: -0.2, appointment_booked: 0.1, cpAppt: -0.05, showed: 0, closed_won: 1, revenue: 0.8, roas: 0.3 },
    funnel: [
      { stage: "new_lead", count: 20, conversionFromPrevious: null, droppedFromPrevious: null },
      { stage: "appointment_booked", count: 7, conversionFromPrevious: 0.35, droppedFromPrevious: 13 },
    ],
    daily: [day(), day({ dateKey: "2026-08-02" }), day({ dateKey: "2026-08-03" })],
    prevDaily: [day(), day(), day()],
    campaigns: [
      { campaignId: "c_1", campaignName: "Leads | GG", platform: "meta", spend: 640, impressions: 40_000, linkClicks: 500, leads: 14, cpLead: 45.71 },
      { campaignId: "c_2", campaignName: "Retargeting", platform: "meta", spend: 300, impressions: 20_000, linkClicks: 200, leads: 6, cpLead: 50 },
    ],
    ...over,
  }) as unknown as DashboardData;

const commit = (over: Partial<Commitment> = {}): Commitment => ({
  id: "c1",
  text: "Rebuild the top-of-funnel creative",
  target: null,
  ...over,
});

const commentary = (over: Partial<CommentaryForReport> = {}): CommentaryForReport => ({
  month: "2026-08",
  did: "Rebuilt three ad sets.",
  commitments: [commit({ id: "next1", text: "Test a new offer" })],
  accountability: null,
  currency: "USD",
  ...over,
});

const build = (d = data(), commentaryArg: CommentaryForReport | null = null) =>
  buildDeck(d, {
    brandName: "Parfaire",
    platformLabel: "Meta",
    commentary: commentaryArg,
  });

const ids = (slides: Slide[]) => slides.map((s) => s.id);
const metric = (slides: Slide[], id: string) =>
  slides.find((s) => s.id === id && s.kind === "metric") as MetricSlide | undefined;
const skipReason = (deck: ReturnType<typeof build>, label: string) =>
  deck.skipped.find((s) => s.label === label)?.why;

/* ------------------------------------------------------------------ *
 * Shape and order
 * ------------------------------------------------------------------ */

describe("deck shape", () => {
  it("opens on a title and closes on the close slide", () => {
    const { slides } = build();
    expect(slides[0].kind).toBe("title");
    expect(slides[slides.length - 1].kind).toBe("close");
  });

  it("tells the whole story in a sensible order", () => {
    const { slides } = build(data(), commentary());
    expect(ids(slides)).toEqual([
      "title",
      "spend", "leads", "cpLead", "funnel",
      "appts", "cpAppt", "shows", "won", "revenue", "roas",
      "trend", "campaigns",
      "did", "plan",
      "close",
    ]);
  });

  it("puts last month's plan second, before any number", () => {
    const prior = [commit({ id: "a" })];
    const { slides } = build(
      data(),
      commentary({
        accountability: resolveAccountability({
          priorMonth: "2026-07",
          priorCommitments: prior,
          outcomes: [{ commitmentId: "a", verdict: "done", note: "" }],
          actuals: null,
        }),
      }),
    );
    expect(slides[1].kind).toBe("accountability");
    // 🔴 Before the first metric. A meeting that opens with new promises and
    // never revisits the old ones is a sales call, not a review.
    expect(slides.findIndex((s) => s.kind === "metric")).toBeGreaterThan(1);
  });

  it("puts the funnel straight after cost per lead", () => {
    const { slides } = build();
    const i = ids(slides).indexOf("cpLead");
    expect(slides[i + 1].id).toBe("funnel");
  });

  it("carries the client's currency on the deck", () => {
    const d = data();
    (d.client as { currency: string }).currency = "GBP";
    expect(build(d).currency).toBe("GBP");
  });
});

/* ------------------------------------------------------------------ *
 * What each metric slide says
 * ------------------------------------------------------------------ */

describe("metric slides", () => {
  it("carries the value, delta and polarity key", () => {
    const m = metric(build().slides, "cpLead")!;
    expect(m.value).toBe(47);
    expect(m.delta).toBe(-0.2);
    // Carried, not resolved — so the slide runs it through the same
    // `changeSentiment` dead band as the dashboard tiles.
    expect(m.polarityKey).toBe("cpLead");
  });

  it("🔴 names the denominator, because it gets asked on every call", () => {
    const m = metric(build().slides, "cpLead")!;
    expect(m.basis).toBe("$940.00 spend ÷ 20 paid leads");
    expect(metric(build().slides, "cpAppt")!.basis).toBe(
      "$940.00 spend ÷ 7 appointments",
    );
  });

  it("uses the client's currency in the basis line", () => {
    const d = data();
    (d.client as { currency: string }).currency = "GBP";
    expect(metric(build(d).slides, "cpLead")!.basis).toContain("£940.00");
  });

  it("has no delta when the comparison is missing", () => {
    const d = data({ deltas: {} });
    expect(metric(build(d).slides, "spend")!.delta).toBeNull();
  });

  it("carries a sparkline built from the daily series", () => {
    expect(metric(build().slides, "spend")!.spark).toEqual([120, 120, 120]);
  });
});

/* ------------------------------------------------------------------ *
 * Zero is a fact; null is an absence
 * ------------------------------------------------------------------ */

describe("zero versus missing", () => {
  it("🔴 keeps a zero-spend slide and says so in words", () => {
    const d = data();
    d.current.ads.spend = 0;
    d.current.derived.cpLead = null;
    const deck = build(d);
    const m = metric(deck.slides, "spend")!;
    expect(m.value).toBe(0);
    // A bare "$0.00" on a screen leaves a room guessing whether the pipe broke.
    expect(m.note).toBe("No spend in this period.");
  });

  it("keeps a zero-lead slide and says so", () => {
    const d = data();
    d.current.funnel.new_lead = 0;
    d.current.derived.cpLead = null;
    const m = metric(build(d).slides, "leads")!;
    expect(m.value).toBe(0);
    expect(m.note).toBe("No leads entered the pipeline in this period.");
  });

  it("🔴 drops a metric with no figure rather than presenting a dash", () => {
    const d = data();
    d.current.derived.cpLead = null;
    const deck = build(d);
    expect(ids(deck.slides)).not.toContain("cpLead");
    expect(skipReason(deck, "Cost per lead")).toBe("no figure for this period");
  });

  it("drops a metric whose figure is not finite", () => {
    const d = data();
    d.current.derived.cpAppt = Number.POSITIVE_INFINITY;
    const deck = build(d);
    expect(ids(deck.slides)).not.toContain("cpAppt");
    expect(skipReason(deck, "Cost per appointment")).toBeTruthy();
  });

  it("drops the funnel when nothing entered it, and says why", () => {
    const d = data();
    d.current.funnel.new_lead = 0;
    const deck = build(d);
    expect(ids(deck.slides)).not.toContain("funnel");
    expect(skipReason(deck, "Funnel")).toContain("no leads entered");
  });
});

/* ------------------------------------------------------------------ *
 * The two suppressions that are not about null
 * ------------------------------------------------------------------ */

describe("suppressed metrics", () => {
  it("🔴 drops revenue and ROAS when no closed deal carries a value", () => {
    /*
     * `revenue` is a confident $0 in this case, not a null — so the guard has to
     * be on the coverage. Telling a client who closed two deals that they
     * produced $0 of revenue is worse than telling them nothing.
     */
    const d = data();
    d.current.revenue = { wonOpps: 2, wonWithValue: 0, revenue: 0 };
    d.current.derived.roas = null;
    const deck = build(d);
    expect(ids(deck.slides)).not.toContain("revenue");
    expect(ids(deck.slides)).not.toContain("roas");
    expect(skipReason(deck, "Revenue")).toBe(
      "2 closed, but no deal value is set on any of them in the CRM",
    );
  });

  it("says plainly when there were no closed deals at all", () => {
    const d = data();
    d.current.revenue = { wonOpps: 0, wonWithValue: 0, revenue: 0 };
    d.current.derived.roas = null;
    expect(skipReason(build(d), "Revenue")).toBe("no closed deals in this period");
  });

  it("keeps revenue when deals are valued", () => {
    const m = metric(build().slides, "revenue")!;
    expect(m.value).toBe(18_400);
  });

  it("🔴 asks whether anyone recorded values, not what they sum to", () => {
    /*
     * A mutation that swapped the coverage check (`wonWithValue`) for the
     * figure itself (`revenue === 0`) survived every other test here, because
     * in the ordinary case the two move together.
     *
     * They come apart on a refund: a $5,000 deal and a −$5,000 credit are two
     * VALUED deals netting to zero. The suppression exists for "nobody types
     * deal values into GHL", which is not what happened — so $0.00 is the true
     * answer and belongs on the slide. Reading the figure instead of the
     * coverage would hide a real net-zero month behind a message about missing
     * CRM data.
     */
    const d = data();
    d.current.revenue = { wonOpps: 2, wonWithValue: 2, revenue: 0 };
    d.current.derived.roas = 0;
    const deck = build(d);
    expect(metric(deck.slides, "revenue")!.value).toBe(0);
    expect(skipReason(deck, "Revenue")).toBeUndefined();
  });

  it("🔴 drops a lone Shows: 0 slide beside real appointments", () => {
    /*
     * Almost always a CRM gap — nobody moves the card after the appointment
     * happens — and "Shows: 0" next to "Appointments: 7" reads as a
     * catastrophe. The funnel slide still carries the number in context, so
     * nothing is hidden.
     */
    const d = data();
    d.current.funnel.showed = 0;
    const deck = build(d);
    expect(ids(deck.slides)).not.toContain("shows");
    expect(skipReason(deck, "Shows")).toContain("Showed stage may not be in use");
    expect(ids(deck.slides)).toContain("funnel");
  });

  it("keeps Shows: 0 when there were no appointments either", () => {
    // Nothing to be inconsistent with — zero shows from zero appointments is
    // just a quiet month, and saying so is honest.
    const d = data();
    d.current.funnel.showed = 0;
    d.current.funnel.appointment_booked = 0;
    d.current.derived.cpAppt = null;
    expect(ids(build(d).slides)).toContain("shows");
  });

  it("keeps a non-zero Shows slide", () => {
    expect(metric(build().slides, "shows")!.value).toBe(4);
  });
});

/* ------------------------------------------------------------------ *
 * Trend and campaigns
 * ------------------------------------------------------------------ */

describe("trend and campaigns", () => {
  it("drops the trend on a single-day range", () => {
    const deck = build(data({ daily: [day()] }));
    expect(ids(deck.slides)).not.toContain("trend");
    expect(skipReason(deck, "Trend")).toContain("single day");
  });

  it("keeps the trend at two days", () => {
    expect(ids(build(data({ daily: [day(), day()] })).slides)).toContain("trend");
  });

  it("drops campaigns that recorded no spend", () => {
    const d = data({
      campaigns: [
        { campaignId: "c_1", campaignName: "Live", platform: "meta", spend: 640, impressions: 1, linkClicks: 1, leads: 14, cpLead: 45.71 },
        { campaignId: "c_2", campaignName: "Paused", platform: "meta", spend: 0, impressions: 0, linkClicks: 0, leads: 0, cpLead: null },
      ],
    });
    const slide = build(d).slides.find((s) => s.kind === "campaigns");
    expect(slide?.kind === "campaigns" && slide.rows.map((r) => r.campaignId)).toEqual([
      "c_1",
    ]);
  });

  it("drops the campaign slide entirely when nothing spent", () => {
    const deck = build(data({ campaigns: [] }));
    expect(ids(deck.slides)).not.toContain("campaigns");
    expect(skipReason(deck, "Campaigns")).toContain("no campaign recorded spend");
  });
});

/* ------------------------------------------------------------------ *
 * Commentary
 * ------------------------------------------------------------------ */

describe("commentary slides", () => {
  it("adds what-we-did and what's-next when both are published", () => {
    const { slides } = build(data(), commentary());
    expect(ids(slides)).toContain("did");
    expect(ids(slides)).toContain("plan");
  });

  it("omits an empty what-we-did without complaining", () => {
    const { slides } = build(data(), commentary({ did: "   " }));
    expect(ids(slides)).not.toContain("did");
    expect(ids(slides)).toContain("plan");
  });

  it("omits an empty plan", () => {
    const { slides } = build(data(), commentary({ commitments: [] }));
    expect(ids(slides)).not.toContain("plan");
  });

  it("🔴 tells the presenter when nothing was published for the month", () => {
    // Not an error, and not silence: the presenter finds out here rather than
    // when the slide fails to arrive.
    const deck = build(data(), null);
    expect(skipReason(deck, "Commentary")).toBe(
      "no commentary has been published for this month",
    );
  });

  it("carries the accountability block through untouched", () => {
    const a = resolveAccountability({
      priorMonth: "2026-07",
      priorCommitments: [commit({ id: "a" }), commit({ id: "b" })],
      outcomes: [{ commitmentId: "a", verdict: "partly", note: "Half." }],
      actuals: null,
    });
    const slide = build(data(), commentary({ accountability: a })).slides.find(
      (s) => s.kind === "accountability",
    );
    expect(slide?.kind === "accountability" && slide.accountability.unanswered).toBe(1);
    expect(slide?.kind === "accountability" && slide.month).toBe("2026-08");
  });
});

/* ------------------------------------------------------------------ *
 * Nothing at all
 * ------------------------------------------------------------------ */

describe("a client with nothing", () => {
  it("still produces a walkable deck and explains every gap", () => {
    const d = data({ campaigns: [], daily: [] });
    d.current.ads.spend = 0;
    d.current.funnel = {
      new_lead: 0, contacted: 0, appointment_booked: 0, showed: 0,
      no_show: 0, closed_won: 0, lost: 0, disqualified: 0, new_lead_qualified: 0,
    } as DashboardData["current"]["funnel"];
    d.current.revenue = { wonOpps: 0, wonWithValue: 0, revenue: 0 };
    d.current.derived = {
      ...d.current.derived,
      cpLead: null, cpAppt: null, cpWon: null, roas: null,
    };

    const deck = build(d);
    // Title, spend, leads, appointments, shows, closed won, close — the counts
    // that are honestly zero survive; every ratio is dropped with a reason.
    expect(ids(deck.slides)).toEqual([
      "title", "spend", "leads", "appts", "shows", "won", "close",
    ]);
    expect(deck.skipped.map((s) => s.label).sort()).toEqual([
      "Campaigns", "Commentary", "Cost per appointment", "Cost per lead",
      "Funnel", "Return on ad spend", "Revenue", "Trend",
    ]);
    // 🔴 Every omission carries a reason. A silently shorter deck is how six
    // empty blocks went unnoticed in the spreadsheet for months.
    expect(deck.skipped.every((s) => s.why.trim().length > 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

describe("formatValue", () => {
  it("renders each format in its own units", () => {
    expect(formatValue(940, "currency", "USD")).toBe("$940.00");
    // Not USD — a deck for a GBP account must not print dollars.
    expect(formatValue(940, "currency", "GBP")).toBe("£940.00");
    expect(formatValue(20, "count")).toBe("20");
    expect(formatValue(0.35, "percent")).toBe("35.0%");
    // `formatMultiple` drops the decimal above 10× — a ROAS of "19.6×" implies a
    // precision the underlying deal values do not have.
    expect(formatValue(19.57, "multiple")).toBe("20×");
    expect(formatValue(3.44, "multiple")).toBe("3.4×");
  });

  it("renders an absent figure as a dash", () => {
    expect(formatValue(null, "currency")).toBe("–");
  });
});

describe("clampSlide", () => {
  it("keeps an index inside the deck", () => {
    expect(clampSlide(3, 10)).toBe(3);
    expect(clampSlide(-4, 10)).toBe(0);
    expect(clampSlide(99, 10)).toBe(9);
    expect(clampSlide(9, 10)).toBe(9);
  });

  it("🔴 survives junk from the URL rather than blanking the screen", () => {
    // `?slide=banana` reaches here as NaN, mid-call, in front of a client.
    expect(clampSlide(NaN, 10)).toBe(0);
    // Infinity lands on the FIRST slide, not the last. `?slide=Infinity` is
    // garbage, and garbage should open the deck rather than jump a presenter to
    // the closing slide in front of a room.
    expect(clampSlide(Infinity, 10)).toBe(0);
    expect(clampSlide(-Infinity, 10)).toBe(0);
    expect(clampSlide(2.7, 10)).toBe(2);
  });

  it("returns 0 for an empty deck rather than -1", () => {
    expect(clampSlide(5, 0)).toBe(0);
  });
});
