import { describe, it, expect, vi } from "vitest";
import { MetaApiError } from "./client";
import {
  classifyLeadgenError,
  isBlockedByPermission,
  isLeadgenId,
  resolveLeadgen,
} from "./leadgen";

/** A stand-in for `MetaClient` carrying only the one method this uses. */
function fakeClient(
  impl: (leadId: string) => Promise<Record<string, string>>,
) {
  const getLeadgen = vi.fn(impl);
  return {
    client: { getLeadgen } as unknown as import("./client").MetaClient,
    getLeadgen,
  };
}

const err = (code: number, subcode?: number, status = 400) =>
  new MetaApiError(`Meta error ${code}`, status, code, subcode);

describe("isLeadgenId", () => {
  it("accepts a long numeric id", () => {
    expect(isLeadgenId("1203630123456789")).toBe(true);
  });

  it("🔴 rejects anything that could reach the request path", () => {
    /*
     * This value is interpolated into a Graph API path, and it arrives from a
     * CRM field that may hold whatever someone typed. Anything non-numeric must
     * be refused here rather than sanitised downstream.
     */
    for (const bad of ["../me", "123/adaccounts", "abc", "12 34", "", " ", "1e10"]) {
      expect(isLeadgenId(bad), bad).toBe(false);
    }
    expect(isLeadgenId(null)).toBe(false);
    expect(isLeadgenId(undefined)).toBe(false);
  });

  it("rejects an id too short to be one", () => {
    expect(isLeadgenId("12345")).toBe(false);
    expect(isLeadgenId("123456")).toBe(true);
  });
});

describe("classifyLeadgenError", () => {
  it("🔴 reads a missing scope as a permission problem", () => {
    // The expected outcome of the first real run — see the header of leadgen.ts.
    expect(classifyLeadgenError(err(10)).reason).toBe("permission");
    expect(classifyLeadgenError(err(200)).reason).toBe("permission");
    expect(classifyLeadgenError(err(100, 33)).reason).toBe("permission");
  });

  it("separates a missing object from a missing permission", () => {
    // Code 100 without subcode 33 is "no such id", which is one lead's problem
    // rather than the token's, and must not stop the run.
    expect(classifyLeadgenError(err(100)).reason).toBe("not_found");
  });

  it("marks throttling and server errors as retryable", () => {
    expect(classifyLeadgenError(err(4)).reason).toBe("transient");
    expect(classifyLeadgenError(err(17)).reason).toBe("transient");
    expect(classifyLeadgenError(err(1, undefined, 500)).reason).toBe("transient");
  });

  it("does not crash on something that is not a Meta error", () => {
    expect(classifyLeadgenError(new Error("socket hang up")).reason).toBe("unknown");
    expect(classifyLeadgenError("nope").reason).toBe("unknown");
  });
});

describe("resolveLeadgen", () => {
  it("returns the three ids for each lead", async () => {
    const { client } = fakeClient(async (id) => ({
      id,
      ad_id: "111",
      adset_id: "222",
      campaign_id: "333",
      created_time: "2026-07-01T10:00:00+0000",
    }));

    const r = await resolveLeadgen(["1203630123456789"], { client });
    expect(r.resolved).toEqual([
      {
        leadId: "1203630123456789",
        adId: "111",
        adsetId: "222",
        campaignId: "333",
        createdTime: "2026-07-01T10:00:00+0000",
      },
    ]);
    expect(r.failures).toEqual([]);
  });

  it("nulls a field Meta omits rather than dropping the lead", async () => {
    // Meta omits rather than nulls — an ad deleted since the lead came in
    // returns a row with no ad_id at all, and the campaign is still worth
    // having.
    const { client } = fakeClient(async (id) => ({ id, campaign_id: "333" }));
    const r = await resolveLeadgen(["1203630123456789"], { client });
    expect(r.resolved[0]).toMatchObject({ adId: null, adsetId: null, campaignId: "333" });
  });

  it("🔴 never issues a request for a non-numeric id", async () => {
    const { client, getLeadgen } = fakeClient(async () => ({}));
    const r = await resolveLeadgen(["../me", "abc"], { client });
    expect(getLeadgen).not.toHaveBeenCalled();
    expect(r.failures.map((f) => f.reason)).toEqual(["not_found", "not_found"]);
  });

  it("keeps going past one lead that cannot be found", async () => {
    const { client } = fakeClient(async (id) => {
      if (id === "1203630123456789") throw err(100);
      return { id, campaign_id: "333" };
    });
    const r = await resolveLeadgen(["1203630123456789", "1203630987654321"], {
      client,
    });
    expect(r.resolved).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
  });

  it("🔴 stops at the first permission error instead of burning the budget", async () => {
    /*
     * With no `leads_retrieval` every id fails identically. Continuing would
     * issue one doomed call per lead — thousands of requests that achieve
     * nothing except spending the account's rate budget and possibly tripping a
     * block that stalls the nightly insights sync behind it.
     */
    const { client, getLeadgen } = fakeClient(async () => {
      throw err(10);
    });
    const ids = Array.from({ length: 50 }, (_, i) => `12036301234567${String(i).padStart(2, "0")}`);
    const r = await resolveLeadgen(ids, { client });

    expect(getLeadgen).toHaveBeenCalledTimes(1);
    expect(r.failures).toHaveLength(1);
    expect(r.resolved).toEqual([]);
  });

  it("calls Meta once per lead, serially", async () => {
    const seen: string[] = [];
    const { client } = fakeClient(async (id) => {
      seen.push(id);
      return { id, campaign_id: "333" };
    });
    await resolveLeadgen(["1203630000000001", "1203630000000002"], { client });
    expect(seen).toEqual(["1203630000000001", "1203630000000002"]);
  });

  it("trims whitespace off an id before using it", async () => {
    const { client, getLeadgen } = fakeClient(async (id) => ({ id }));
    await resolveLeadgen([" 1203630123456789 "], { client });
    expect(getLeadgen).toHaveBeenCalledWith("1203630123456789");
  });

  it("handles an empty list", async () => {
    const { client, getLeadgen } = fakeClient(async () => ({}));
    const r = await resolveLeadgen([], { client });
    expect(r).toEqual({ resolved: [], failures: [] });
    expect(getLeadgen).not.toHaveBeenCalled();
  });
});

describe("isBlockedByPermission", () => {
  it("is true when nothing resolved and the reason was the scope", () => {
    expect(
      isBlockedByPermission({
        resolved: [],
        failures: [{ leadId: "1", reason: "permission", message: "no" }],
      }),
    ).toBe(true);
  });

  it("🔴 is false when some leads did resolve", () => {
    /*
     * "The token cannot read leads" and "3 of 40 leads could not be found" are
     * different messages with different fixes, and conflating them would send
     * someone hunting for missing leads when the answer is a scope.
     */
    expect(
      isBlockedByPermission({
        resolved: [
          { leadId: "1", adId: "a", adsetId: null, campaignId: null, createdTime: null },
        ],
        failures: [{ leadId: "2", reason: "permission", message: "no" }],
      }),
    ).toBe(false);
  });

  it("is false for an ordinary not-found run", () => {
    expect(
      isBlockedByPermission({
        resolved: [],
        failures: [{ leadId: "1", reason: "not_found", message: "gone" }],
      }),
    ).toBe(false);
  });

  it("is false for a run with nothing in it", () => {
    expect(isBlockedByPermission({ resolved: [], failures: [] })).toBe(false);
  });
});
