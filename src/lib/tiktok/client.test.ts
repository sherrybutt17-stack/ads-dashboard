import { describe, it, expect, afterEach, vi } from "vitest";
import { TiktokApiError, TiktokClient, normalizeAdvertiserId, num } from "./client";

afterEach(() => vi.unstubAllGlobals());

const envelope = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

const client = () => new TiktokClient("tok");

describe("normalizeAdvertiserId", () => {
  it("accepts a numeric id", () => {
    expect(normalizeAdvertiserId(" 7012345678901234567 ")).toBe("7012345678901234567");
  });

  it("🔴 refuses anything that could reach the request URL", () => {
    // The single point where a stored id is interpolated outbound.
    for (const bad of ["../x", "123/ads", "abc", "", "12 34"]) {
      expect(() => normalizeAdvertiserId(bad), bad).toThrow(/Invalid TikTok/);
    }
  });
});

describe("num", () => {
  it("casts TikTok's string metrics", () => {
    // Every metric comes back as a string, exactly as Meta's do.
    expect(num("12.34")).toBeCloseTo(12.34);
    expect(num(5)).toBe(5);
  });

  it("treats missing and unparseable as zero, not NaN", () => {
    // A NaN here propagates into a sum and blanks the whole column.
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("n/a")).toBe(0);
  });
});

describe("🔴 TikTok answers 200 for its own errors", () => {
  /*
   * The single most important difference from Meta and Google. A client written
   * to the other two integrations' shape reads `res.ok` and parses an absent
   * `data` key into zero spend — and zero spend is a legitimate state here, so
   * the failure would surface as a client whose dashboard reads $0 with a green
   * health check.
   */
  it("throws on a non-zero code despite the 200", async () => {
    stubFetch(async () => envelope({ code: 40001, message: "Invalid token" }));
    await expect(client().getAdvertiser("7012345678901234567")).rejects.toThrow(
      /Invalid token/,
    );
  });

  it("does NOT read a failed call as zero spend", async () => {
    stubFetch(async () => envelope({ code: 40002, message: "no permission" }));
    await expect(
      client().getDailyInsights("7012345678901234567", "2026-07-01", "2026-07-31"),
    ).rejects.toBeInstanceOf(TiktokApiError);
  });

  it("classifies a dead token as an auth failure", async () => {
    stubFetch(async () => envelope({ code: 40105, message: "invalid token" }));
    await client()
      .getAdvertiser("7012345678901234567")
      .catch((e: TiktokApiError) => {
        expect(e.isAuth).toBe(true);
        expect(e.isRateLimit).toBe(false);
      });
    expect.assertions(2);
  });

  it("🔴 never classifies one code as both auth failure and rate limit", async () => {
    /*
     * They imply opposite actions — stop versus wait and retry — and the retry
     * branch wins, so a permanently dead token would spend 35 seconds backing
     * off before reporting itself. Asserted over a range rather than the two
     * codes we happen to use, so widening either list re-checks the invariant.
     */
    for (let code = 40000; code < 50010; code++) {
      const e = new TiktokApiError("x", code);
      expect(e.isAuth && e.isRateLimit, `code ${code}`).toBe(false);
    }
  });

  it("throws when code is 0 but data is absent", async () => {
    // A success envelope with nothing in it is still nothing to store.
    stubFetch(async () => envelope({ code: 0, message: "ok" }));
    await expect(client().getAdvertiser("7012345678901234567")).rejects.toThrow(
      /no data/i,
    );
  });

  it("throws when the body is not JSON at all", async () => {
    stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("nope");
          },
        }) as unknown as Response,
    );
    await expect(client().getAdvertiser("7012345678901234567")).rejects.toThrow(
      /no JSON/i,
    );
  });
});

describe("requests", () => {
  it("authenticates with the Access-Token header, not a bearer", async () => {
    const spy = stubFetch(async () => envelope({ code: 0, data: { list: [] } }));
    await client().getAdvertiser("7012345678901234567");
    const init = (spy.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Access-Token"]).toBe("tok");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("asks for auction campaign delivery, day by day", async () => {
    const spy = stubFetch(async () => envelope({ code: 0, data: { list: [] } }));
    await client().getDailyInsights("7012345678901234567", "2026-07-01", "2026-07-31");
    // `fetch` is called with a URL object, not a string.
    const url = String((spy.mock.calls[0] as unknown as [URL, RequestInit])[0]);
    expect(url).toContain("service_type=AUCTION");
    expect(url).toContain("data_level=AUCTION_CAMPAIGN");
    expect(url).toContain("start_date=2026-07-01");
    expect(url).toContain("end_date=2026-07-31");
  });

  it("returns an empty list rather than undefined when nothing ran", async () => {
    stubFetch(async () => envelope({ code: 0, data: {} }));
    expect(
      await client().getDailyInsights("7012345678901234567", "2026-07-01", "2026-07-02"),
    ).toEqual([]);
  });

  it("parses rows through", async () => {
    stubFetch(async () =>
      envelope({
        code: 0,
        data: {
          list: [
            {
              dimensions: { campaign_id: "111", stat_time_day: "2026-07-01 00:00:00" },
              metrics: { spend: "12.50", impressions: "1000", clicks: "40" },
            },
          ],
        },
      }),
    );
    const rows = await client().getDailyInsights(
      "7012345678901234567",
      "2026-07-01",
      "2026-07-01",
    );
    expect(rows).toHaveLength(1);
    expect(num(rows[0].metrics.spend)).toBeCloseTo(12.5);
  });

  it("refuses to construct without a token", () => {
    expect(() => new TiktokClient("")).toThrow(/No TikTok access token/);
  });
});

describe("🔴 paginated reports", () => {
  /*
   * One row per campaign per day means a 7-day window needs only ~143 campaigns
   * to exceed a single page. The original version read `data.list` and never
   * looked at `page_info`, so past that point spend was silently understated —
   * no error, and a smaller-than-real number looks entirely plausible.
   */
  const pageOf = (ids: string[], totalPage: number) =>
    envelope({
      code: 0,
      data: {
        list: ids.map((id) => ({
          dimensions: { campaign_id: id, stat_time_day: "2026-07-01 00:00:00" },
          metrics: { spend: "10" },
        })),
        page_info: { total_page: totalPage, total_number: totalPage * 2 },
      },
    });

  it("🔴 walks every page instead of dropping the tail", async () => {
    const spy = stubFetch(async (url) => {
      const page = new URL(String(url)).searchParams.get("page");
      return pageOf(page === "1" ? ["a", "b"] : ["c", "d"], 2);
    });

    const rows = await client().getDailyInsights(
      "7012345678901234567",
      "2026-07-01",
      "2026-07-07",
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.dimensions.campaign_id)).toEqual(["a", "b", "c", "d"]);
  });

  it("sends page=1 first and increments", async () => {
    const pages: (string | null)[] = [];
    stubFetch(async (url) => {
      pages.push(new URL(String(url)).searchParams.get("page"));
      return pageOf(["x"], 3);
    });
    await client().getDailyInsights("7012345678901234567", "2026-07-01", "2026-07-07");
    expect(pages).toEqual(["1", "2", "3"]);
  });

  it("stops after one request when there is only one page", async () => {
    // An absent or 1 `total_page` must not loop to the cap on an empty account.
    const spy = stubFetch(async () => pageOf(["only"], 1));
    await client().getDailyInsights("7012345678901234567", "2026-07-01", "2026-07-07");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("treats a missing page_info as a single page", async () => {
    const spy = stubFetch(async () => envelope({ code: 0, data: { list: [] } }));
    expect(
      await client().getDailyInsights("7012345678901234567", "2026-07-01", "2026-07-07"),
    ).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("🔴 refuses to report a partial total rather than understating spend", async () => {
    // Matches MetaClient.getAds: a truncated report is worse than a failed one,
    // because low spend looks plausible and nobody investigates it.
    stubFetch(async () => pageOf(["x"], 9999));
    await expect(
      client().getDailyInsights("7012345678901234567", "2026-07-01", "2026-07-07"),
    ).rejects.toThrow(/refusing to report partial spend/);
  });
});
