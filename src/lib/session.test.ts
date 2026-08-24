import { describe, it, expect, beforeAll } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  SESSION_ROLES,
  SESSION_TTL_MS,
  type SessionPayload,
} from "./session";
import { userRoleEnum } from "@/db/schema";

/**
 * 🔴 The session token is the whole authorization boundary.
 *
 * The edge proxy authorizes with no database call, so whatever this token says
 * about a user — their role, the slugs they may open, and now the agency they
 * act inside — is taken at face value on every request that never reaches a
 * route handler. The MAC is the only thing standing between a curious user and
 * a cookie they have edited.
 *
 * These tests had no counterpart before the v4 change, which is its own finding:
 * the tenant has just moved INTO the signed payload, and "is agencyId actually
 * covered by the signature" is not a question to answer by reading.
 */

const SECRET = "test-secret-not-a-real-key";
const AGENCY = "aaaaaaaa-0000-0000-0000-00000000000a";
const OTHER_AGENCY = "bbbbbbbb-0000-0000-0000-00000000000b";

const payload: SessionPayload = {
  userId: "u1",
  agencyId: AGENCY,
  role: "agency",
  slugs: ["acme", "beta"],
};

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});

describe("session token", () => {
  it("round-trips every field, the agency included", async () => {
    const token = await createSessionToken(payload);
    expect(await verifySessionToken(token)).toEqual(payload);
  });

  it("carries an empty slug list without inventing one", async () => {
    const staff = { ...payload, role: "staff" as const, slugs: [] };
    const back = await verifySessionToken(await createSessionToken(staff));
    expect(back?.slugs).toEqual([]);
  });

  it("🔴 rejects a token whose agency has been edited", async () => {
    /*
     * THE test for v4. The agency is inside the signed message, not appended
     * beside it — so rewriting it in a cookie invalidates the MAC rather than
     * moving the session into someone else's tenant. If this ever passes with
     * the tenant outside the signature, every agency's data is one string edit
     * away from anyone holding a valid login.
     */
    const token = await createSessionToken(payload);
    const parts = token.split(".");
    parts[2] = OTHER_AGENCY;
    expect(await verifySessionToken(parts.join("."))).toBeNull();
  });

  it("rejects a token whose role has been escalated", async () => {
    const token = await createSessionToken({ ...payload, role: "client" });
    const parts = token.split(".");
    parts[3] = "superadmin";
    expect(await verifySessionToken(parts.join("."))).toBeNull();
  });

  it("rejects a token whose slug list has been extended", async () => {
    const token = await createSessionToken({ ...payload, slugs: ["acme"] });
    const parts = token.split(".");
    parts[4] = "acme,someone-elses-client";
    expect(await verifySessionToken(parts.join("."))).toBeNull();
  });

  it("rejects a role that is not a role", async () => {
    const token = await createSessionToken(payload);
    const parts = token.split(".");
    parts[3] = "root";
    expect(await verifySessionToken(parts.join("."))).toBeNull();
  });

  it("🔴 rejects a v3 token rather than guessing its agency", async () => {
    /*
     * A v3 token names no agency. The only ways to give it one are to guess —
     * wrong in the direction of admitting someone to a tenant — or to read the
     * database from the edge, which is the property the token exists to avoid.
     * Everyone re-logs in once; that is the entire cost and it is paid once.
     */
    const v3 = "v3.u1.staff..99999999999999.deadbeef";
    expect(await verifySessionToken(v3)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const now = Date.now();
    const token = await createSessionToken(payload, now);
    expect(await verifySessionToken(token, now + SESSION_TTL_MS + 1)).toBeNull();
    expect(await verifySessionToken(token, now + SESSION_TTL_MS - 1)).not.toBeNull();
  });

  it("rejects the empty, the malformed and the absent without throwing", async () => {
    for (const t of [undefined, null, "", "nonsense", "v4.only.four.parts"]) {
      expect(await verifySessionToken(t)).toBeNull();
    }
  });

  it("🔴 refuses to validate anything when no secret is configured", async () => {
    // An HMAC keyed on the empty string verifies against any other empty-key
    // token, so a server missing its secret would accept tokens minted by any
    // other server missing its secret.
    const token = await createSessionToken(payload);
    const saved = process.env.AUTH_SECRET;
    const savedEnc = process.env.ENCRYPTION_KEY;
    delete process.env.AUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(await verifySessionToken(token)).toBeNull();
    } finally {
      process.env.AUTH_SECRET = saved;
      if (savedEnc !== undefined) process.env.ENCRYPTION_KEY = savedEnc;
    }
  });

  it("🔴 accepts exactly the roles the database can hold", async () => {
    /*
     * `session.ts` runs in the edge proxy, so it cannot import the schema and
     * has to duplicate the role list. A copy that drifts is worse than no copy:
     * a role the database issues but the token rejects locks those users out,
     * and a role the token accepts but the database never issues is a name
     * waiting to be typed into a forged cookie by someone who reads the source.
     */
    expect([...SESSION_ROLES].sort()).toEqual([...userRoleEnum.enumValues].sort());
  });
});
