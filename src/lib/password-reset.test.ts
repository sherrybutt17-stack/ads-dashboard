import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { User } from "@/db/schema";

/*
 * Password reset is one of the few features where the interesting behaviour is
 * everything it REFUSES to do: reuse a link, outlive an hour, survive the
 * password changing, or tell a stranger whether an address has an account.
 * Each of those is silent when broken and none is visible in normal use.
 */

const ENV = { ...process.env };

/** `getUserById` is the only I/O in the module; the rest is arithmetic. */
const store = new Map<string, User>();
vi.mock("@/lib/users", () => ({
  getUserById: async (id: string) => store.get(id) ?? null,
}));

let m: typeof import("./password-reset");

beforeEach(async () => {
  process.env.AUTH_SECRET = "test-secret-value";
  store.clear();
  m = await import("./password-reset");
});

afterEach(() => {
  process.env = { ...ENV };
});

const user = (over: Partial<User> = {}): User =>
  ({
    id: "11111111-1111-1111-1111-111111111111",
    email: "a@example.com",
    passwordHash: "scrypt$16384$aabb$ccdd",
    role: "client",
    name: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    ...over,
  }) as User;

const seed = (u: User) => {
  store.set(u.id, u);
  return u;
};

describe("reset tokens", () => {
  it("round-trips a valid token", async () => {
    const u = seed(user());
    const token = m.createResetToken(u)!;
    const res = await m.verifyResetToken(token);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.id).toBe(u.id);
  });

  it("🔴 stops verifying once the password has changed — single use, no table", async () => {
    /*
     * THE property the whole design rests on. The signature covers the current
     * password hash, so completing a reset invalidates the link that did it and
     * every other outstanding link for that account, at the same instant and
     * with no cleanup job. If this breaks, an emailed link becomes a permanent
     * skeleton key for anyone who still has the message.
     */
    const u = seed(user());
    const token = m.createResetToken(u)!;
    expect((await m.verifyResetToken(token)).ok).toBe(true);

    seed(user({ passwordHash: "scrypt$16384$newsalt$newhash" }));
    const res = await m.verifyResetToken(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("used");
  });

  it("expires", async () => {
    const u = seed(user());
    const token = m.createResetToken(u, 1_000)!;
    const res = await m.verifyResetToken(token, 1_000 + m.RESET_TTL_MS + 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
  });

  it("is still valid one millisecond before it expires", async () => {
    const u = seed(user());
    const token = m.createResetToken(u, 1_000)!;
    expect((await m.verifyResetToken(token, 1_000 + m.RESET_TTL_MS - 1)).ok).toBe(true);
  });

  it("🔴 rejects a tampered expiry — the deadline is signed, not just printed", async () => {
    // Otherwise anyone holding an expired link extends it by editing a number.
    const u = seed(user());
    const token = m.createResetToken(u, 1_000)!;
    const [id, , sig] = token.split(".");
    const forged = `${id}.${9_999_999_999_999}.${sig}`;
    const res = await m.verifyResetToken(forged, 2_000);
    expect(res.ok).toBe(false);
  });

  it("🔴 rejects a token pointed at a different user", async () => {
    // The user id is in the signed message, so swapping it must not let one
    // account's link reset another's.
    const a = seed(user());
    seed(user({ id: "22222222-2222-2222-2222-222222222222", email: "b@example.com" }));
    const token = m.createResetToken(a)!;
    const [, exp, sig] = token.split(".");
    const forged = `22222222-2222-2222-2222-222222222222.${exp}.${sig}`;
    expect((await m.verifyResetToken(forged)).ok).toBe(false);
  });

  it("refuses a disabled account, checked live rather than at mint time", async () => {
    // Disabling someone must take effect on links already in their inbox.
    const u = seed(user());
    const token = m.createResetToken(u)!;
    seed(user({ status: "disabled" }));
    expect((await m.verifyResetToken(token)).ok).toBe(false);
  });

  it("reports an unknown user the same way as a malformed token", async () => {
    // Keeps the endpoint from being turned into a user-id oracle.
    const token = m.createResetToken(user())!; // never seeded
    const res = await m.verifyResetToken(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("malformed");
  });

  it("rejects junk without throwing", async () => {
    for (const junk of ["", "a", "a.b", "a.b.c.d", "....", "x.NaN.y"]) {
      const res = await m.verifyResetToken(junk);
      expect(res.ok, junk).toBe(false);
    }
  });

  it("🔴 mints nothing when no signing secret is configured", async () => {
    /*
     * An HMAC keyed on "" verifies against any other empty-key token, so a
     * misconfigured deploy would hand out reset links that anyone could forge.
     * Refusing to mint is the only safe failure.
     */
    vi.resetModules();
    delete process.env.AUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    const fresh = await import("./password-reset");
    expect(fresh.createResetToken(user())).toBeNull();
    const res = await fresh.verifyResetToken("a.1.b");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
  });
});

describe("🔴 the forgot endpoint must not leak who has an account", () => {
  /*
   * An endpoint that answers differently for a known address is a membership
   * oracle: point it at a staff list and it reports who has a login here. The
   * uniform response is easy to write and just as easy to "improve" into a
   * helpful "no account with that email", so it is pinned by source.
   */
  const SRC = readFileSync(
    join(__dirname, "..", "app", "api", "auth", "forgot", "route.ts"),
    "utf8",
  );
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("returns exactly one shape for the whole happy path", () => {
    const bodies = [...CODE.matchAll(/NextResponse\.json\(\s*\{([^}]*)\}/g)].map((x) =>
      x[1].replace(/\s+/g, ""),
    );
    // The 429 is the only other response, and a rate limit is not a membership
    // signal — it depends on the caller's own IP, not on the address queried.
    const nonRateLimit = bodies.filter((b) => !b.includes("Toomanyrequests"));
    expect(nonRateLimit).toEqual(["ok:true"]);
  });

  it("does the lookup and the send after responding, so timing does not leak either", () => {
    // A uniform body with a response time that varies by whether mail was sent
    // gives back exactly what the body was careful to withhold.
    expect(CODE).toMatch(/after\(async \(\) => \{/);
    const afterAt = CODE.indexOf("after(async");
    // The CALL, not the import at the top of the file.
    const sendAt = CODE.indexOf("await sendEmail(");
    const lookupAt = CODE.indexOf(".from(users)");
    expect(sendAt, "sendEmail is called outside after()").toBeGreaterThan(afterAt);
    expect(lookupAt, "the user lookup happens outside after()").toBeGreaterThan(afterAt);
  });

  it("never logs the token", () => {
    // It is the credential for the next hour, and audit logs are read by more
    // people than a password store is.
    const audited = CODE.slice(CODE.indexOf("auth.reset_requested"));
    expect(audited).not.toMatch(/metadata:[^}]*token/);
  });
});
