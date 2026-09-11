import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetaAdAccountSummary } from "./client";

const listAdAccounts = vi.fn<() => Promise<MetaAdAccountSummary[]>>();

vi.mock("./client", () => ({
  MetaClient: class {
    listAdAccounts = listAdAccounts;
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));

/**
 * The stash is shared with the Google flow and tested against a real Postgres
 * in `lib/connect-stash.test.ts`. What is left here is the adapter: which
 * provider this module reaches for, and whether the token EXPIRY survives the
 * round trip — the one field Meta has and Google does not.
 */
const putConnectStash = vi.fn(async () => "stash-id");
const readConnectStash = vi.fn();
const dropConnectStash = vi.fn(async () => {});
vi.mock("@/lib/connect-stash", () => ({
  putConnectStash: (...args: unknown[]) => putConnectStash(...(args as [])),
  readConnectStash: (...args: unknown[]) => readConnectStash(...(args as [])),
  dropConnectStash: (...args: unknown[]) => dropConnectStash(...(args as [])),
}));

const { discoverMetaAccounts, stashMetaConnection, readMetaStash, dropMetaStash } =
  await import("./connect");

const account = (over: Partial<MetaAdAccountSummary> = {}): MetaAdAccountSummary => ({
  account_id: "1",
  name: "Account",
  currency: "USD",
  timezone_name: "America/Los_Angeles",
  account_status: 1,
  ...over,
});

beforeEach(() => {
  listAdAccounts.mockReset();
  vi.clearAllMocks();
  putConnectStash.mockResolvedValue("stash-id");
});

describe("🔴 account discovery must not request permission-gated fields", () => {
  /*
   * Verified against v25.0 with a live token on 2026-08-17: `business` returns
   * `(#100) Requires business_management permission` and `owner` returns
   * `(#200)`. Meta rejects the ENTIRE request rather than omitting the field,
   * so adding either one turns "here are your ad accounts" into "could not
   * read that Facebook sign-in" for every user.
   *
   * Grouping the picker by Business Manager is the obvious thing to reach for
   * with an agency login — this test exists because that reach is a trap, and
   * the only way to satisfy it is a heavier scope that forces App Review.
   */
  const source = readFileSync(join(__dirname, "client.ts"), "utf8");
  const fields = source.match(/"\/me\/adaccounts",\s*\{\s*fields:\s*"([^"]+)"/)?.[1];

  it("finds the field list it is guarding", () => {
    expect(fields, "the /me/adaccounts fields string moved — update this test").toBeTruthy();
  });

  it.each(["business", "owner"])("does not request `%s`", (gated) => {
    expect(fields!.split(",")).not.toContain(gated);
    expect(fields).not.toContain(`${gated}{`);
  });

  it("still requests what the picker actually renders", () => {
    for (const f of ["account_id", "name", "currency", "timezone_name", "account_status"]) {
      expect(fields!.split(",")).toContain(f);
    }
  });
});

describe("discoverMetaAccounts", () => {
  it("puts usable accounts above unusable ones", async () => {
    listAdAccounts.mockResolvedValue([
      account({ account_id: "1", name: "Closed", account_status: 2 }),
      account({ account_id: "2", name: "Live", account_status: 1 }),
    ]);

    const out = await discoverMetaAccounts("tok");
    expect(out.map((a) => a.name)).toEqual(["Live", "Closed"]);
  });

  it("orders by name, not by id", async () => {
    // An agency login reaches many accounts; a numerically-ordered list of
    // 16-digit ids is not something anyone can pick from.
    listAdAccounts.mockResolvedValue([
      account({ account_id: "999", name: "Aardvark Clinic" }),
      account({ account_id: "111", name: "Zebra Med" }),
    ]);

    const out = await discoverMetaAccounts("tok");
    expect(out.map((a) => a.name)).toEqual(["Aardvark Clinic", "Zebra Med"]);
  });

  it("keeps inactive accounts rather than hiding them", async () => {
    // Hiding an account someone knows exists reads as a failed sign-in, and
    // sends them round the consent flow again looking for it.
    listAdAccounts.mockResolvedValue([account({ account_id: "9", account_status: 3 })]);

    const out = await discoverMetaAccounts("tok");
    expect(out).toHaveLength(1);
    expect(out[0].active).toBe(false);
  });

  it("survives an account with no name", async () => {
    listAdAccounts.mockResolvedValue([account({ account_id: "5", name: undefined })]);

    const out = await discoverMetaAccounts("tok");
    expect(out[0].name).toBeNull();
    expect(out[0].adAccountId).toBe("5");
  });

  it("treats every status other than 1 as unusable", async () => {
    // Asserted as a property: Meta documents several disabled states and adds
    // to them, so anything-but-1 is the safe reading rather than a list.
    for (const status of [2, 3, 7, 8, 9, 100, 101]) {
      listAdAccounts.mockResolvedValue([account({ account_status: status })]);
      expect((await discoverMetaAccounts("t"))[0].active, `status ${status}`).toBe(false);
    }
  });
});

describe("the Meta side of the shared stash", () => {
  it("stashes under the meta provider", async () => {
    await stashMetaConnection("client-a", "TOKEN", null);
    expect(putConnectStash).toHaveBeenCalledWith("meta", "client-a", "TOKEN", null);
  });

  it("🔴 carries the token expiry into the stash", async () => {
    /*
     * A Meta user token lasts ~60 days. That date has to survive the picker to
     * reach `meta_ad_accounts`, where the health check warns on it while there
     * is still time to re-authorise. Dropped here, the connection works
     * perfectly through setup and dies two months later with no warning — which
     * is the exact failure this application was built to stop shipping.
     */
    const exp = new Date("2026-10-16T00:00:00Z");
    await stashMetaConnection("client-a", "T", exp);
    expect(putConnectStash).toHaveBeenCalledWith("meta", "client-a", "T", exp);
  });

  it("reads back under the meta provider, keeping the expiry with the token", async () => {
    const exp = new Date("2026-10-16T00:00:00Z");
    readConnectStash.mockResolvedValue({
      ok: true,
      clientId: "client-a",
      token: "TOKEN",
      tokenExpiresAt: exp,
    });
    expect(await readMetaStash("stash-id", "client-a")).toEqual({
      ok: true,
      clientId: "client-a",
      accessToken: "TOKEN",
      tokenExpiresAt: exp,
    });
    expect(readConnectStash).toHaveBeenCalledWith("meta", "stash-id", "client-a");
  });

  it("passes a refusal straight through rather than reshaping it", async () => {
    readConnectStash.mockResolvedValue({ ok: false, reason: "wrong_client" });
    expect(await readMetaStash("stash-id", "client-b")).toEqual({
      ok: false,
      reason: "wrong_client",
    });
  });

  it("drops only the meta stash of that id", async () => {
    await dropMetaStash("stash-id");
    expect(dropConnectStash).toHaveBeenCalledWith("meta", "stash-id");
  });
});
