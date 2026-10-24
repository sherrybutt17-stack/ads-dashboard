import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GoogleAdsClient } from "./client";
import { GOOGLE_EXTRA_FAMILIES } from "@/lib/metrics/platform-extras";

/**
 * The columns beside Conversions — `getDailyExtras`.
 *
 * Two families, two queries, each best-effort on its own: a field Google
 * refuses costs that family and nothing else. v25 retired `metrics.video_views`
 * for `metrics.video_trueview_views` (probed 24 Oct 2026: UNRECOGNIZED_FIELD),
 * which is exactly the kind of refusal this has to survive.
 */

type Sent = { query: string };
let sent: Sent[];
let answer: (query: string) => Response;

beforeEach(() => {
  vi.stubEnv("GOOGLE_ADS_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_ADS_CLIENT_SECRET", "client-secret");
  vi.stubEnv("GOOGLE_ADS_API_VERSION", undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
      }
      const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
      sent.push({ query });
      return answer(query);
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let n = 0;
const client = () => new GoogleAdsClient(`refresh-extras-${++n}`, "");
const stream = (results: unknown[]) => new Response(JSON.stringify([{ results }]));

describe("getDailyExtras", () => {
  it("asks for each family's fields, campaign by day, over the window", async () => {
    answer = () => stream([]);
    await client().getDailyExtras("123-456-7890", "2026-10-01", "2026-10-07");
    expect(sent).toHaveLength(2);
    for (const [i, family] of Object.values(GOOGLE_EXTRA_FAMILIES).entries()) {
      for (const f of Object.values(family)) expect(sent[i].query).toContain(f.field);
      expect(sent[i].query).toMatch(/FROM campaign/);
      expect(sent[i].query).toContain("segments.date BETWEEN '2026-10-01' AND '2026-10-07'");
    }
    // The retired name is never sent.
    expect(sent.map((s) => s.query).join(" ")).not.toMatch(/metrics\.video_views\b/);
  });

  it("returns each campaign-day's figures by our own keys", async () => {
    answer = (q) =>
      q.includes("all_conversions")
        ? stream([
            {
              campaign: { id: "11" },
              segments: { date: "2026-10-02" },
              metrics: { allConversions: 2.5, allConversionsValue: "120.5", conversionsValue: 100, viewThroughConversions: "1" },
            },
          ])
        : stream([
            {
              campaign: { id: "11" },
              segments: { date: "2026-10-02" },
              metrics: { interactions: "40", engagements: 0, videoTrueviewViews: "7", phoneCalls: 1 },
            },
          ]);
    const x = await client().getDailyExtras("1234567890", "2026-10-01", "2026-10-07");
    expect(x.xc?.get("11|2026-10-02")).toEqual({
      all_conversions: 2.5,
      all_conversions_value: 120.5,
      conversions_value: 100,
      view_through_conversions: 1,
    });
    expect(x.xe?.get("11|2026-10-02")).toEqual({ interactions: 40, engagements: 0, video_views: 7, phone_calls: 1 });
  });

  it("🔴 a refused family is null; the other family still arrives", async () => {
    answer = (q) =>
      q.includes("interactions")
        ? new Response(
            JSON.stringify({
              error: {
                code: 400,
                details: [{ errors: [{ errorCode: { queryError: "UNRECOGNIZED_FIELD" }, message: "Unrecognized field" }] }],
              },
            }),
            { status: 400 },
          )
        : stream([{ campaign: { id: "11" }, segments: { date: "2026-10-02" }, metrics: { allConversions: 3 } }]);
    const x = await client().getDailyExtras("1234567890", "2026-10-01", "2026-10-07");
    expect(x.xe).toBeNull();
    expect(x.xc?.get("11|2026-10-02")?.all_conversions).toBe(3);
  });

  it("rounds a shared conversion to six places, so it is stored as a plain decimal", async () => {
    answer = (q) =>
      q.includes("all_conversions")
        ? stream([{ campaign: { id: "11" }, segments: { date: "2026-10-02" }, metrics: { allConversions: 1 / 3 } }])
        : stream([]);
    const x = await client().getDailyExtras("1234567890", "2026-10-01", "2026-10-07");
    expect(x.xc?.get("11|2026-10-02")?.all_conversions).toBe(0.333333);
  });
});
