import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { User } from "@/db/schema";

/*
 * Invite links let a person choose their own password for a login someone else
 * made. Like reset links, what matters is everything they REFUSE: a second use,
 * a stale invite after a newer one, a tampered expiry, another user's id — and,
 * new here, being mistaken for a reset link or vice versa.
 */

const ENV = { ...process.env };

/** `getUserById` is the only I/O either module does; the rest is arithmetic. */
const store = new Map<string, User>();
vi.mock("@/lib/users", () => ({
  getUserById: async (id: string) => store.get(id) ?? null,
}));

let m: typeof import("./invites");
let reset: typeof import("./password-reset");

beforeEach(async () => {
  process.env.AUTH_SECRET = "test-secret-value";
  store.clear();
  m = await import("./invites");
  reset = await import("./password-reset");
});

afterEach(() => {
  process.env = { ...ENV };
});

const ID = "11111111-1111-1111-1111-111111111111";

/** An invite nobody has accepted: unconfirmed, never signed in. */
const invitee = (over: Partial<User> = {}): User =>
  ({
    id: ID,
    agencyId: "00000000-0000-0000-0000-000000000001",
    email: "new@example.com",
    passwordHash: "scrypt$16384$aabb$ccdd",
    role: "client",
    name: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    emailVerifiedAt: null,
    ...over,
  }) as User;

/** A login already in use. */
const member = (over: Partial<User> = {}): User =>
  invitee({ emailVerifiedAt: new Date("2026-09-01"), lastLoginAt: new Date("2026-09-20"), ...over });

const seed = (u: User) => {
  store.set(u.id, u);
  return u;
};

const mint = (u: User, opts?: { ttlMs?: number; now?: number }) =>
  m.createInviteToken(u, opts)!.token;

describe("invite tokens", () => {
  it("round-trips", async () => {
    const u = seed(invitee());
    const res = await m.verifyInviteToken(mint(u));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.id).toBe(u.id);
  });

  it("returns when it expires, so the operator can be told", () => {
    const minted = m.createInviteToken(invitee(), { now: 1_000 })!;
    expect(minted.expiresAt.getTime()).toBe(1_000 + m.INVITE_TTL_MS);
  });

  it("🔴 dies once a password is set — single use, no table", async () => {
    /*
     * THE property the design rests on. Accepting changes the hash the token is
     * signed over, so the link that did it — and every other one for that login
     * — stops verifying at the same instant.
     */
    const u = seed(invitee());
    const token = mint(u);
    seed(member({ passwordHash: "scrypt$16384$newsalt$newhash" }));
    const res = await m.verifyInviteToken(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("used");
  });

  it("🔴 a newer invite kills the older one", async () => {
    // "New invite link" rotates the random hash: the lost or forwarded link
    // must stop working the moment its replacement exists.
    const u = seed(invitee());
    const old = mint(u);
    seed(invitee({ passwordHash: "scrypt$16384$rotated$hash" }));
    const res = await m.verifyInviteToken(old);
    expect(res.ok).toBe(false);
    // Still waiting, so not "used" — the next step is "ask for a fresh link".
    if (!res.ok) expect(res.reason).toBe("malformed");
  });

  it("🔴 dies if the address on the login changes", async () => {
    const u = seed(invitee());
    const token = mint(u);
    seed(invitee({ email: "someone-else@example.com" }));
    expect((await m.verifyInviteToken(token)).ok).toBe(false);
  });

  it("lasts seven days by default, and no longer", async () => {
    const u = seed(invitee());
    const token = mint(u, { now: 1_000 });
    expect((await m.verifyInviteToken(token, 1_000 + m.INVITE_TTL_MS - 1)).ok).toBe(true);
    const res = await m.verifyInviteToken(token, 1_000 + m.INVITE_TTL_MS + 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
  });

  it("honours the shorter lifetime of a password link", async () => {
    const u = seed(member());
    const token = mint(u, { ttlMs: m.PASSWORD_LINK_TTL_MS, now: 1_000 });
    expect(m.PASSWORD_LINK_TTL_MS).toBeLessThan(m.INVITE_TTL_MS);
    const res = await m.verifyInviteToken(token, 1_000 + m.PASSWORD_LINK_TTL_MS + 1);
    expect(res.ok).toBe(false);
  });

  it("🔴 rejects a tampered expiry — the deadline is signed, not just printed", async () => {
    const u = seed(invitee());
    const [id, , sig] = mint(u, { now: 1_000 }).split(".");
    const res = await m.verifyInviteToken(`${id}.${9_999_999_999_999}.${sig}`, 2_000);
    expect(res.ok).toBe(false);
  });

  it("🔴 rejects a token pointed at a different user", async () => {
    const a = seed(invitee());
    const other = "22222222-2222-2222-2222-222222222222";
    seed(invitee({ id: other, email: "b@example.com" }));
    const [, exp, sig] = mint(a).split(".");
    expect((await m.verifyInviteToken(`${other}.${exp}.${sig}`)).ok).toBe(false);
  });

  it("refuses a disabled login, checked live rather than at mint time", async () => {
    const u = seed(invitee());
    const token = mint(u);
    seed(invitee({ status: "disabled" }));
    expect((await m.verifyInviteToken(token)).ok).toBe(false);
  });

  it("reports an unknown user the same way as a malformed token", async () => {
    const res = await m.verifyInviteToken(mint(invitee())); // never seeded
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("malformed");
  });

  it("rejects junk without throwing", async () => {
    for (const junk of ["", "a", "a.b", "a.b.c.d", "....", "x.NaN.y"]) {
      expect((await m.verifyInviteToken(junk)).ok, junk).toBe(false);
    }
  });

  it("🔴 mints nothing when no signing secret is configured", async () => {
    // An HMAC keyed on "" verifies against any other empty-key token.
    vi.resetModules();
    delete process.env.AUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    const fresh = await import("./invites");
    expect(fresh.invitesConfigured()).toBe(false);
    expect(fresh.createInviteToken(invitee())).toBeNull();
    const res = await fresh.verifyInviteToken("a.1.b");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
  });
});

describe("🔴 invite links and reset links are not interchangeable", () => {
  /*
   * Both are `id.exp.sig`, keyed on the same secret, over the same password
   * hash. Without the label in the invite's signed message one would BE the
   * other — and accepting an invite also confirms an address, a power a reset
   * link was never meant to carry.
   */
  it("a reset link does not verify as an invite", async () => {
    const u = seed(member());
    const resetToken = reset.createResetToken(u)!;
    expect((await reset.verifyResetToken(resetToken)).ok).toBe(true);
    expect((await m.verifyInviteToken(resetToken)).ok).toBe(false);
  });

  it("is signed over a message carrying its own label", () => {
    /*
     * Pinned directly because the cross-checks above would still pass without
     * it today — the email field alone keeps the two messages apart. That is an
     * accident of the current fields, and a later edit dropping the email would
     * quietly merge the two link types. The label is the deliberate separation.
     */
    const u = member();
    const [id, exp, sig] = mint(u).split(".");
    const expected = createHmac("sha256", "test-secret-value")
      .update(`invite/v1|${id}|${exp}|${u.email}|${u.passwordHash}`)
      .digest("base64url");
    expect(sig).toBe(expected);
  });

  it("an invite link does not verify as a reset", async () => {
    const u = seed(member());
    const inviteToken = mint(u);
    expect((await m.verifyInviteToken(inviteToken)).ok).toBe(true);
    expect((await reset.verifyResetToken(inviteToken)).ok).toBe(false);
  });
});

describe("isPendingInvite", () => {
  it("is an invite while unconfirmed and never signed in", () => {
    expect(m.isPendingInvite(invitee())).toBe(true);
  });
  it("stops being one once the address is confirmed", () => {
    expect(m.isPendingInvite(invitee({ emailVerifiedAt: new Date() }))).toBe(false);
  });
  it("stops being one once anyone has signed in", () => {
    // A legacy login made before confirmation existed is not "an invite".
    expect(m.isPendingInvite(invitee({ lastLoginAt: new Date() }))).toBe(false);
  });
});

describe("inviteUrl", () => {
  it("points at the public /invite page, token encoded", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://dash.example.com";
    expect(m.inviteUrl("a.b.c+d")).toBe("https://dash.example.com/invite?token=a.b.c%2Bd");
  });
});
