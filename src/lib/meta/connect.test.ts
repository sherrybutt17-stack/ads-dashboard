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

beforeEach(() => listAdAccounts.mockReset());

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

describe("🔴 stash is scoped to the client that opened it", () => {
  it("refuses a stash minted for a different client", async () => {
    const id = await stashMetaConnection("client-a", "TOKEN", null);
    expect(readMetaStash(id, "client-b")).toEqual({ ok: false, reason: "wrong_client" });
    // The rightful client still gets it — the guard is on identity, not use.
    expect(readMetaStash(id, "client-a")).toMatchObject({ ok: true, accessToken: "TOKEN" });
  });

  it("reports an unknown id as expired rather than throwing", async () => {
    expect(readMetaStash("nope", "client-a")).toEqual({ ok: false, reason: "expired" });
  });

  it("forgets a dropped stash", async () => {
    const id = await stashMetaConnection("c", "SECRET", null);
    expect(readMetaStash(id, "c")).toMatchObject({ ok: true, accessToken: "SECRET" });
    dropMetaStash(id);
    expect(readMetaStash(id, "c")).toEqual({ ok: false, reason: "expired" });
  });

  it("carries the token expiry through the stash", async () => {
    const exp = new Date("2026-10-16T00:00:00Z");
    const id = await stashMetaConnection("c", "T", exp);
    const got = readMetaStash(id, "c");
    expect(got.ok && got.tokenExpiresAt?.toISOString()).toBe(exp.toISOString());
  });
});
