import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GhlClient, GhlApiError, flattenStages } from "./client";

/**
 * The GoHighLevel API client.
 *
 * Everything this reaches for is irreplaceable. GHL exposes no stage-transition
 * history, so the day-0 backfill that pages through a location is the only
 * chance to establish what is already true — a request dropped here is not
 * retried by anything and has no second source.
 */

const NOW_HEADERS = new Headers({ "content-type": "application/json" });

function res(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ ...Object.fromEntries(NOW_HEADERS), ...headers }),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Run `p` to completion, letting every backoff timer fire immediately. */
async function settle<T>(p: Promise<T>): Promise<T> {
  const done = p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  await vi.runAllTimersAsync();
  const r = await done;
  if (r.ok) return r.v;
  throw r.e;
}

const client = () => new GhlClient("tok-123");

/* ------------------------------------------------------------------ *
 * Request shape
 * ------------------------------------------------------------------ */

describe("request shape", () => {
  it("sends the bearer token and the pinned API version", async () => {
    // `Version` is a required header with a strict enum — omitting it, or
    // sending anything else, fails the request outright.
    fetchMock.mockResolvedValue(res(200, { location: { name: "Acme" } }));
    await settle(client().getLocation("loc_1"));

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(init.headers.Version).toBe("2021-07-28");
  });

  it("url-encodes ids rather than pasting them into the path", async () => {
    fetchMock.mockResolvedValue(res(200, {}));
    await settle(client().getLocation("loc/../../admin"));
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "loc%2F..%2F..%2Fadmin",
    );
  });

  it("omits empty query parameters instead of sending blanks", async () => {
    // `?locationId=` is not the same request as no `locationId` at all, and GHL
    // answers the first with an error rather than a default.
    fetchMock.mockResolvedValue(res(200, { pipelines: [] }));
    await settle(client().getPipelines(""));
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("locationId=");
  });

  it("returns the unwrapped body whether or not GHL wraps it", async () => {
    // The shape of this response is not consistent across GHL's own endpoints.
    fetchMock.mockResolvedValue(res(200, { location: { name: "Wrapped" } }));
    expect((await settle(client().getLocation("l"))).name).toBe("Wrapped");

    fetchMock.mockResolvedValue(res(200, { name: "Bare" }));
    expect((await settle(client().getLocation("l"))).name).toBe("Bare");
  });

  it("surfaces a non-JSON error body as text rather than throwing on the parse", async () => {
    // A gateway returning HTML must produce a readable GhlApiError, not a
    // SyntaxError from JSON.parse that hides the status entirely.
    fetchMock.mockResolvedValue(res(502, "<html>bad gateway</html>"));
    await expect(settle(client().getLocation("l"))).rejects.toThrow(/502/);
  });
});

/* ------------------------------------------------------------------ *
 * Retry
 * ------------------------------------------------------------------ */

describe("🔴 rate limiting", () => {
  /*
   * This client had no retry at all, while `meta/client.ts` reads throttle
   * headers and `google/client.ts` backs off on 429 — and GHL is the only one
   * that fires up to 500 requests in a tight paging loop. The first 429 aborted
   * a backfill partway through, leaving a silently partial snapshot of the one
   * thing that cannot be re-derived.
   */
  it("retries a 429 and returns the eventual success", async () => {
    fetchMock
      .mockResolvedValueOnce(res(429, { message: "rate limited" }))
      .mockResolvedValueOnce(res(200, { location: { name: "Acme" } }));

    const out = await settle(client().getLocation("loc_1"));
    expect(out.name).toBe("Acme");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(res(503, "unavailable"))
      .mockResolvedValueOnce(res(200, { location: { name: "Acme" } }));
    await settle(client().getLocation("loc_1"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("🔴 does NOT retry a 401 or a 404", async () => {
    // A dead token and a wrong id both return the same answer next time.
    // Retrying holds a sync open to arrive at it four times over.
    fetchMock.mockResolvedValue(res(401, { message: "unauthorized" }));
    await expect(settle(client().getLocation("l"))).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(res(404, { message: "gone" }));
    await expect(settle(client().getPipelines("l"))).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of attempts", async () => {
    // Bounded, so a sustained outage fails the run instead of pinning a
    // serverless invocation until the platform kills it mid-write.
    fetchMock.mockResolvedValue(res(429, "slow down"));
    await expect(settle(client().getLocation("l"))).rejects.toThrow(GhlApiError);
    expect(fetchMock).toHaveBeenCalledTimes(5); // first try + 4 retries
  });

  it("🔴 honours Retry-After over its own backoff curve", async () => {
    /*
     * The header is the server telling us when it will accept traffic again.
     * GHL's burst limit refills on a short window, so the stated wait is
     * usually shorter than a doubling curve — ignoring it turns a two-second
     * pause into thirty, and a paging loop pays that on every page.
     */
    fetchMock
      .mockResolvedValueOnce(res(429, "slow down", { "retry-after": "2" }))
      .mockResolvedValueOnce(res(200, { location: { name: "Acme" } }));

    const p = client().getLocation("l");
    const done = p.then(() => "resolved");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still waiting out the 2s

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBe("resolved");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a nonsense Retry-After instead of waiting forever", async () => {
    fetchMock
      .mockResolvedValueOnce(res(429, "slow", { "retry-after": "not-a-number" }))
      .mockResolvedValueOnce(res(200, { location: {} }));
    await settle(client().getLocation("l"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ *
 * Missing records
 * ------------------------------------------------------------------ */

describe("a 404 on a single record", () => {
  it("reads as null, not as an error", async () => {
    // Opportunities and contacts get deleted in GHL between an event being
    // queued and us reading it back. That is ordinary, not a fault.
    fetchMock.mockResolvedValue(res(404, { message: "not found" }));
    expect(await settle(client().getOpportunity("opp_1"))).toBeNull();
    expect(await settle(client().getContact("c_1"))).toBeNull();
  });

  it("still raises anything that is not a 404", async () => {
    fetchMock.mockResolvedValue(res(401, { message: "unauthorized" }));
    await expect(settle(client().getOpportunity("opp_1"))).rejects.toThrow(/401/);
  });
});

/* ------------------------------------------------------------------ *
 * Paging
 * ------------------------------------------------------------------ */

describe("iterateOpportunities", () => {
  const page = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `opp_${i}` }));

  async function collect(gen: AsyncGenerator<unknown[]>) {
    const out: unknown[][] = [];
    for await (const batch of gen) out.push(batch);
    return out;
  }

  it("stops on a short page", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { opportunities: page(100) }))
      .mockResolvedValueOnce(res(200, { opportunities: page(7) }));
    const batches = await settle(collect(client().iterateOpportunities("loc_1")));
    expect(batches.map((b) => b.length)).toEqual([100, 7]);
  });

  it("stops on an empty page without yielding it", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { opportunities: page(100) }))
      .mockResolvedValueOnce(res(200, { opportunities: [] }));
    const batches = await settle(collect(client().iterateOpportunities("loc_1")));
    expect(batches).toHaveLength(1);
  });

  it("stops when the API says there is no next page", async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, { opportunities: page(100), meta: { nextPageUrl: null } }),
    );
    const batches = await settle(collect(client().iterateOpportunities("loc_1")));
    expect(batches).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("🔴 says so when it stops at the page cap", async () => {
    /*
     * Falling off the loop silently is indistinguishable from finishing, and
     * the caller writes `sync_runs.status = success` either way. The snapshot
     * would be missing everything past the cap, with nothing anywhere saying
     * so and no history to reconcile against later.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(res(200, { opportunities: page(2) }));

    const batches = await settle(
      collect(client().iterateOpportunities("loc_1", { limit: 2, maxPages: 3 })),
    );
    expect(batches).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PARTIAL"));
  });

  it("does not warn when it finished naturally", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(res(200, { opportunities: page(1) }));
    await settle(
      collect(client().iterateOpportunities("loc_1", { limit: 2, maxPages: 3 })),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Stage flattening
 * ------------------------------------------------------------------ */

describe("flattenStages", () => {
  /*
   * The element shape of `stages[]` is genuinely unpublished — GHL's own PHP
   * SDK types it `array<array<mixed>>` — so every field here is defensive on
   * purpose, and the defence is what is being tested.
   */
  it("reads either spelling of the stage id", () => {
    const out = flattenStages([
      { id: "p1", name: "Main", stages: [{ id: "s1" }, { _id: "s2" }] },
    ] as never);
    expect(out.map((s) => s.stageId)).toEqual(["s1", "s2"]);
  });

  it("skips a stage with no id rather than emitting a broken row", () => {
    // A stage row with no `ghl_stage_id` can never be matched to an incoming
    // webhook, so it would sit unmappable in the wizard forever.
    const out = flattenStages([
      { id: "p1", stages: [{ name: "nameless" }, { id: "s1" }] },
    ] as never);
    expect(out).toHaveLength(1);
  });

  it("falls back to array order when position is absent or not a number", () => {
    const out = flattenStages([
      { id: "p1", stages: [{ id: "a" }, { id: "b", position: "2" }, { id: "c", position: 9 }] },
    ] as never);
    expect(out.map((s) => s.position)).toEqual([0, 1, 9]);
  });

  it("survives a pipeline whose stages are missing or not an array", () => {
    const out = flattenStages([
      { id: "p1" },
      { id: "p2", stages: null },
      { id: "p3", stages: [{ id: "s" }] },
    ] as never);
    expect(out).toHaveLength(1);
  });

  it("keeps every pipeline's stages, not just the first", () => {
    const out = flattenStages([
      { id: "p1", name: "One", stages: [{ id: "a" }] },
      { id: "p2", name: "Two", stages: [{ id: "b" }] },
    ] as never);
    expect(out.map((s) => s.pipelineName)).toEqual(["One", "Two"]);
  });
});
