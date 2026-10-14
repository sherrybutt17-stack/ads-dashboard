import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_ATTACH_PER_SIGN_IN,
  accountsByManager,
  coverage,
  deselectAll,
  selectAll,
} from "./connect-picker";

describe("selectAll / deselectAll", () => {
  it("adds and removes without touching the input set", () => {
    const picked = new Set(["a"]);
    const more = selectAll(picked, ["b", "c"]);
    expect([...more].sort()).toEqual(["a", "b", "c"]);
    expect([...picked]).toEqual(["a"]);
    expect([...deselectAll(more, ["a", "c", "zz"])]).toEqual(["b"]);
  });
});

describe("coverage", () => {
  it("reads none, some and all, and treats an empty list as none", () => {
    const picked = new Set(["a", "b"]);
    expect(coverage(picked, ["c"])).toBe("none");
    expect(coverage(picked, ["a", "c"])).toBe("some");
    expect(coverage(picked, ["a", "b"])).toBe("all");
    expect(coverage(picked, [])).toBe("none");
  });
});

describe("accountsByManager", () => {
  it("groups attachable accounts under the manager they are reached through", () => {
    const groups = accountsByManager([
      { customerId: "M1", isManager: true, loginCustomerId: "" },
      { customerId: "M2", isManager: true, loginCustomerId: "M1" },
      { customerId: "a", isManager: false, loginCustomerId: "M1" },
      { customerId: "b", isManager: false, loginCustomerId: "M2" },
      { customerId: "c", isManager: false, loginCustomerId: "M1" },
      // Reached directly: belongs to no manager.
      { customerId: "d", isManager: false, loginCustomerId: "" },
      // Through a manager that is not in the list: ignored, not invented.
      { customerId: "e", isManager: false, loginCustomerId: "GONE" },
      // Older payloads without the field.
      { customerId: "f", isManager: false },
    ]);
    expect(groups.get("M1")).toEqual(["a", "c"]);
    expect(groups.get("M2")).toEqual(["b"]);
    expect([...groups.keys()].sort()).toEqual(["M1", "M2"]);
  });

  it("never puts a manager inside a group, since managers hold no campaigns", () => {
    const groups = accountsByManager([
      { customerId: "M1", isManager: true, loginCustomerId: "" },
      { customerId: "M2", isManager: true, loginCustomerId: "M1" },
    ]);
    expect(groups.get("M1")).toEqual([]);
  });
});

describe("the attach cap", () => {
  it("is the one the three attach routes enforce", () => {
    // The pickers stop at this number; a route with its own literal would
    // refuse, or allow, a selection the picker said otherwise about.
    for (const platform of ["google", "meta", "tiktok"]) {
      const src = readFileSync(
        join(__dirname, `../app/api/clients/[id]/${platform}-connect/route.ts`),
        "utf8",
      );
      expect(src).toContain(".max(MAX_ATTACH_PER_SIGN_IN)");
      // No literal cap left on the id list itself (the inner string lengths are fine).
      expect(src).not.toMatch(/\)\)\.min\(1\)\.max\(\d+\)/);
    }
    expect(MAX_ATTACH_PER_SIGN_IN).toBe(50);
  });
});
