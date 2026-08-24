import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The gap between "the client signed in" and "these accounts are theirs".
 *
 * This is the whole of Model B — the client authorizes with their own Google
 * account and picks which customers to attach. Two things here are load-bearing
 * and neither fails loudly:
 *
 *   - the stash, which holds a **live refresh token** for an unfinished flow;
 *   - `loginCustomerId`, resolved at discovery because that is the only moment
 *     the hierarchy is known. Get it wrong and every query is syntactically
 *     valid and returns nothing for an account with obvious spend.
 */

const listAccessibleCustomers = vi.fn();
const getCustomer = vi.fn();
const listClientAccounts = vi.fn();

vi.mock("./client", () => ({
  GoogleAdsClient: class {
    constructor(
      readonly refreshToken: string,
      readonly loginCustomerId: string,
    ) {}
    listAccessibleCustomers = listAccessibleCustomers;
    getCustomer = getCustomer;
    listClientAccounts = listClientAccounts;
  },
}));

process.env.ENCRYPTION_KEY = "c".repeat(64);
const mod = await import("./connect");

const CLIENT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  getCustomer.mockResolvedValue({
    descriptiveName: "Acme",
    currencyCode: "USD",
    timeZone: "America/Los_Angeles",
  });
  listClientAccounts.mockResolvedValue([]);
});

/* ------------------------------------------------------------------ *
 * The stash
 * ------------------------------------------------------------------ */

describe("the connection stash", () => {
  it("round-trips the refresh token for the client it was minted for", async () => {
    const id = await mod.stashGoogleConnection(CLIENT, "refresh-abc");
    const found = mod.readGoogleStash(id, CLIENT);
    expect(found).toEqual({ ok: true, clientId: CLIENT, refreshToken: "refresh-abc" });
  });

  it("🔴 refuses a stash minted for a different client", async () => {
    /*
     * The stash id travels through a URL. Without this check, an operator who
     * can reach two clients could take a stash minted while connecting one and
     * attach that client's Google accounts — with their live credential — to
     * the other.
     */
    const id = await mod.stashGoogleConnection(CLIENT, "refresh-abc");
    expect(mod.readGoogleStash(id, OTHER)).toEqual({
      ok: false,
      reason: "wrong_client",
    });
  });

  it("🔴 encrypts the token rather than parking it in a Map in the clear", async () => {
    /*
     * A heap dump, or an error that serialises this map, should not print a
     * live credential. There is no way to look inside the module's private Map
     * from here, and an assertion that pretends to is worse than none — so this
     * asserts the WRITE path calls `encrypt`, and the round-trip test above
     * covers that the value is still usable afterwards.
     */
    const { encrypt } = await import("@/lib/crypto");
    const spy = vi.spyOn(await import("@/lib/crypto"), "encrypt");
    void encrypt;

    await mod.stashGoogleConnection(CLIENT, "refresh-xyz");
    expect(spy).toHaveBeenCalledWith("refresh-xyz");
    spy.mockRestore();
  });

  it("reports an unknown id as expired rather than throwing", async () => {
    // On serverless a later request may land on a different instance and find
    // nothing. That has to read as "sign-in expired, try again", not a 500.
    expect(mod.readGoogleStash("no-such-stash", CLIENT)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("drops a stash once it has been used", async () => {
    const id = await mod.stashGoogleConnection(CLIENT, "refresh-abc");
    mod.dropGoogleStash(id);
    expect(mod.readGoogleStash(id, CLIENT).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

describe("discoverGoogleAccounts", () => {
  it("🔴 records no manager as \"\" for a directly-accessible account", async () => {
    /*
     * Stored as a decision, not an absence. A null here would be filled in
     * later with the agency MCC, which produces a request that is perfectly
     * valid and returns nothing at all for an account that plainly has spend —
     * the exact failure this field was added to end.
     */
    listAccessibleCustomers.mockResolvedValue(["111"]);
    const { accounts } = await mod.discoverGoogleAccounts("tok");
    expect(accounts[0].loginCustomerId).toBe("");
  });

  it("🔴 records the manager it was reached through, for a child account", async () => {
    listAccessibleCustomers.mockResolvedValue(["999"]);
    listClientAccounts.mockResolvedValue([
      {
        customerId: "111",
        name: "Child",
        currency: "USD",
        timezone: "UTC",
        isManager: false,
        level: 1,
      },
    ]);

    const { accounts } = await mod.discoverGoogleAccounts("tok");
    const child = accounts.find((a) => a.customerId === "111");
    expect(child?.loginCustomerId).toBe("999");
  });

  it("expands a manager, because listAccessibleCustomers returns only the manager", async () => {
    // Authorizing with a manager account grants the manager alone — the
    // accounts beneath it never appear unless each one is expanded.
    listAccessibleCustomers.mockResolvedValue(["999"]);
    listClientAccounts.mockResolvedValue([
      { customerId: "111", name: "A", isManager: false, level: 1 },
      { customerId: "222", name: "B", isManager: false, level: 1 },
    ]);

    const { accounts } = await mod.discoverGoogleAccounts("tok");
    expect(accounts.map((a) => a.customerId).sort()).toEqual(["111", "222", "999"]);
  });

  it("marks a customer as a manager once children come back", async () => {
    // The picker refuses manager accounts — they hold no spend of their own, so
    // attaching one guarantees a permanently empty dashboard.
    listAccessibleCustomers.mockResolvedValue(["999"]);
    listClientAccounts.mockResolvedValue([
      { customerId: "111", name: "A", isManager: false, level: 1 },
    ]);
    const { accounts } = await mod.discoverGoogleAccounts("tok");
    expect(accounts.find((a) => a.customerId === "999")?.isManager).toBe(true);
  });

  describe("🔴 partial results", () => {
    /*
     * A user with five managers, one suspended, must get the other four rather
     * than an error page. But `partial` then has to reach the caller: the
     * attach route uses it to tell "your login cannot reach this" apart from
     * "part of the hierarchy did not answer this time", and those two send an
     * operator to completely different places.
     */
    it("flags a branch that failed to expand", async () => {
      listAccessibleCustomers.mockResolvedValue(["999"]);
      listClientAccounts.mockRejectedValue(new Error("suspended"));
      const { partial } = await mod.discoverGoogleAccounts("tok");
      expect(partial).toBe(true);
    });

    it("flags a customer that refused a plain lookup, but keeps its id", async () => {
      // A manager account can refuse a `customer` query while still being the
      // route to everything beneath it.
      listAccessibleCustomers.mockResolvedValue(["999"]);
      getCustomer.mockRejectedValue(new Error("not permitted"));
      listClientAccounts.mockResolvedValue([
        { customerId: "111", name: "A", isManager: false, level: 1 },
      ]);

      const { accounts, partial } = await mod.discoverGoogleAccounts("tok");
      expect(partial).toBe(true);
      expect(accounts.map((a) => a.customerId).sort()).toEqual(["111", "999"]);
    });

    it("is false when everything answered", async () => {
      listAccessibleCustomers.mockResolvedValue(["111"]);
      const { partial } = await mod.discoverGoogleAccounts("tok");
      expect(partial).toBe(false);
    });

    it("keeps the accounts it did reach", async () => {
      listAccessibleCustomers.mockResolvedValue(["111", "222"]);
      listClientAccounts
        .mockRejectedValueOnce(new Error("suspended"))
        .mockResolvedValueOnce([]);
      const { accounts } = await mod.discoverGoogleAccounts("tok");
      expect(accounts).toHaveLength(2);
    });
  });

  it("sorts managers first, then by name", async () => {
    listAccessibleCustomers.mockResolvedValue(["999"]);
    listClientAccounts.mockResolvedValue([
      { customerId: "222", name: "Zeta", isManager: false, level: 1 },
      { customerId: "111", name: "Alpha", isManager: false, level: 1 },
    ]);
    const { accounts } = await mod.discoverGoogleAccounts("tok");
    // The manager sorts first regardless of where its name falls alphabetically.
    expect(accounts.map((a) => a.name)).toEqual(["Acme", "Alpha", "Zeta"]);
    expect(accounts[0].isManager).toBe(true);
  });
});

describe("🔴 the attach route distinguishes partial from unreachable", () => {
  it("uses `partial` in the not-found message", () => {
    /*
     * Asserted against the source: `partial` was computed and discarded here,
     * so an account missing because a branch 500'd was reported as a permission
     * problem. That sends someone to re-authorize and re-link over a transient
     * error, and eventually to support.
     */
    const route = readFileSync(
      join(process.cwd(), "src/app/api/clients/[id]/google-connect/route.ts"),
      "utf8",
    );
    expect(route).toContain("const { accounts, partial } = await discoverGoogleAccounts");

    /*
     * Comments stripped first. The original form of this assertion searched the
     * raw slice for the word "partial" and passed against a version that had
     * stopped using it — the surrounding comment block contains the word too.
     * A test that a comment mentions something is not a test.
     */
    const code = route
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const notFound = code.slice(code.indexOf("if (!node) {"));
    expect(notFound.slice(0, 600)).toContain("error: partial");
  });
});
