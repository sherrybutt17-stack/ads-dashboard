import { describe, it, expect } from "vitest";
import type { SessionPayload } from "@/lib/session";
import { authorizeBoardWrite } from "./write";

const session = (role: SessionPayload["role"], slugs: string[] = []): SessionPayload =>
  ({ userId: "u1", agencyId: "a1", role, slugs }) as SessionPayload;

describe("who may change a board", () => {
  it("refuses without a session", () => {
    expect(authorizeBoardWrite(null, "acme", { locked: false })).toMatchObject({ ok: false, status: 401 });
  });

  it("lets every agency role edit, locked or not, as staff", () => {
    for (const role of ["staff", "superadmin", "agency"] as const) {
      expect(authorizeBoardWrite(session(role), "acme", { locked: true })).toEqual({ ok: true, staff: true });
    }
  });

  it("lets a client edit their own unlocked board, as a client", () => {
    expect(authorizeBoardWrite(session("client", ["acme"]), "acme", { locked: false })).toEqual({
      ok: true,
      staff: false,
    });
  });

  it("🔴 refuses a client on a locked board, and on anyone else's", () => {
    const locked = authorizeBoardWrite(session("client", ["acme"]), "acme", { locked: true });
    expect(locked).toMatchObject({ ok: false, status: 403 });
    if (!locked.ok) expect(locked.error).toMatch(/agency has fixed this board/);
    expect(authorizeBoardWrite(session("client", ["acme"]), "rival", { locked: false })).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});
