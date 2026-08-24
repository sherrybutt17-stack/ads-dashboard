import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Verification tokens.
 *
 * The token is the whole credential — anyone holding it can prove an address.
 * Two properties carry that weight, and neither is visible by reading the happy
 * path: the link must die when it is used, and it must die when the address it
 * names changes. Both come from what the signature covers, which is exactly the
 * kind of detail that survives a refactor by accident or not at all.
 */

const users = new Map<string, FakeUser>();

vi.mock("@/lib/users", () => ({
  getUserById: async (id: string) => users.get(id) ?? null,
}));

const { createVerifyToken, verifyVerifyToken, VERIFY_TTL_MS } = await import(
  "./email-verification"
);

const ID = "11111111-1111-1111-1111-111111111111";

/** The fields the token construction and the live checks actually read. */
interface FakeUser {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  status: string;
  passwordHash?: string;
}

function seed(over: Partial<FakeUser> = {}): FakeUser {
  const user: FakeUser = {
    id: ID,
    email: "owner@agency.com",
    emailVerifiedAt: null,
    status: "active",
    ...over,
  };
  users.set(ID, user);
  return user;
}

beforeEach(() => {
  users.clear();
  process.env.AUTH_SECRET = "test-secret";
});

describe("verification tokens", () => {
  it("round-trips a freshly created account", async () => {
    const user = seed();
    const token = createVerifyToken(user)!;
    const result = await verifyVerifyToken(token);
    expect(result.ok).toBe(true);
  });

  it("🔴 stops working once the address is verified", async () => {
    /*
     * This is what makes the link single-use, and it costs nothing: the
     * signature covers `emailVerifiedAt`, so stamping it invalidates the link
     * that did the stamping AND every other outstanding link for the account.
     * These arrive in inboxes that get forwarded; a link that stays live for
     * its full 24 hours after use is a credential lying around.
     */
    const user = seed();
    const token = createVerifyToken(user)!;

    users.set(ID, { ...user, emailVerifiedAt: new Date() });
    const result = await verifyVerifyToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already");
  });

  it("🔴 stops working if the address itself changes", async () => {
    // A user who typos their address, corrects it, then clicks the FIRST email
    // would otherwise verify an address they do not hold.
    const user = seed();
    const token = createVerifyToken(user)!;

    users.set(ID, { ...user, email: "corrected@agency.com" });
    const result = await verifyVerifyToken(token);
    expect(result.ok).toBe(false);
  });

  it("survives a password change", async () => {
    /*
     * Deliberately NOT in the signature. Resetting a password and confirming an
     * address are separate journeys a person is quite likely to do in one
     * sitting, and coupling them means the second silently breaks the first
     * with nothing on screen to explain it.
     */
    const user = seed({ passwordHash: "old" });
    const token = createVerifyToken(user)!;

    users.set(ID, { ...user, passwordHash: "new" });
    expect((await verifyVerifyToken(token)).ok).toBe(true);
  });

  it("expires", async () => {
    const user = seed();
    const now = 1_700_000_000_000;
    const token = createVerifyToken(user, now)!;
    expect((await verifyVerifyToken(token, now + VERIFY_TTL_MS - 1)).ok).toBe(true);

    const late = await verifyVerifyToken(token, now + VERIFY_TTL_MS + 1);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe("expired");
  });

  it("gives verification a longer window than a password reset", async () => {
    /*
     * A reset link is a credential for an existing account and worth stealing.
     * This one only proves someone can read an inbox — and it arrives mid
     * sign-up, which people abandon and come back to. An hour would generate
     * dead links for no security gained.
     */
    const { RESET_TTL_MS } = await import("./password-reset");
    expect(VERIFY_TTL_MS).toBeGreaterThan(RESET_TTL_MS);
  });

  it("🔴 refuses to mint or verify without a signing secret", async () => {
    // An HMAC keyed on the empty string verifies against any other empty-key
    // token, so any server missing its secret would accept any other's links.
    const user = seed();
    const token = createVerifyToken(user)!;
    delete process.env.AUTH_SECRET;
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(createVerifyToken(user)).toBeNull();
      const result = await verifyVerifyToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unavailable");
    } finally {
      process.env.AUTH_SECRET = "test-secret";
      if (saved !== undefined) process.env.ENCRYPTION_KEY = saved;
    }
  });

  it("rejects a disabled account", async () => {
    // Checked live rather than baked into the signature, so an account disabled
    // AFTER the link was sent cannot still complete the flow.
    const user = seed();
    const token = createVerifyToken(user)!;
    users.set(ID, { ...user, status: "disabled" });
    expect((await verifyVerifyToken(token)).ok).toBe(false);
  });

  it("rejects the malformed without throwing", async () => {
    for (const t of ["", "nonsense", "a.b", "a.b.c.d", `${ID}.notanumber.sig`]) {
      const r = await verifyVerifyToken(t);
      expect(r.ok).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The flow around the token
 * ------------------------------------------------------------------ */

const AUTH = readFileSync(
  join(process.cwd(), "src", "app", "api", "auth", "route.ts"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SIGNUP = readFileSync(
  join(process.cwd(), "src", "app", "api", "auth", "signup", "route.ts"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const VERIFY_ROUTE = readFileSync(
  join(process.cwd(), "src", "app", "api", "auth", "verify", "route.ts"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("sign-up and verification flow", () => {
  it("parses the sources it is checking", () => {
    expect(AUTH).toContain("export async function POST");
    expect(SIGNUP).toContain("export async function POST");
  });

  it("🔴 an unverified account cannot hold a session", () => {
    /*
     * The gate that makes the whole thing mean something. Sign-up issues no
     * session, so without this check "confirm your email" is a suggestion and
     * anyone can hold a working account on an address they do not own.
     */
    expect(AUTH).toMatch(/if \(!user\.emailVerifiedAt\)/);
    expect(AUTH).toMatch(/status: 403/);
  });

  it("🔴 sign-up issues no session of any kind", () => {
    // Signing them in here would mean the address is never actually proved —
    // the email becomes a thing to ignore, and sign-up becomes a way to get a
    // working session on somebody else's address.
    expect(SIGNUP).not.toContain("createSessionToken");
    expect(SIGNUP).not.toContain("SESSION_COOKIE");
  });

  it("🔴 creates the agency and its owner in one transaction", () => {
    // An agency with no owner is unreachable and holds the slug forever; a user
    // with no agency cannot exist (NOT NULL). A partial sign-up is a support
    // ticket from someone who has not yet used the product.
    expect(SIGNUP).toMatch(/db\.transaction\(/);
    const tx = SIGNUP.indexOf("db.transaction(");
    const agencyInsert = SIGNUP.indexOf(".insert(agencies)", tx);
    const userInsert = SIGNUP.indexOf(".insert(users)", tx);
    expect(agencyInsert).toBeGreaterThan(tx);
    expect(userInsert).toBeGreaterThan(agencyInsert);
  });

  it("🔴 does not leave an account unprovable when email cannot be sent", () => {
    // A deployment with no Resend key would otherwise create accounts nobody
    // can ever finish, with a verification email that never arrives as the only
    // clue.
    expect(SIGNUP).toMatch(/emailConfigured\(\)/);
    expect(SIGNUP).toMatch(/emailVerifiedAt: canSend \? null : new Date\(\)/);
  });

  it("🔴 confirmation is a POST, not a GET", () => {
    /*
     * A GET that performs the write is followed by every link scanner and mail
     * gateway between us and the recipient — the address ends up confirmed by a
     * machine that merely fetched the URL.
     */
    expect(VERIFY_ROUTE).toContain("export async function POST");
    expect(VERIFY_ROUTE).not.toContain("export async function GET");
  });

  it("signs the new owner up as an agency, never as staff", () => {
    // `staff` is the pre-tenancy see-everything role. A self-serve signup
    // minting one would hand a stranger the whole database.
    expect(SIGNUP).toMatch(/role: "agency"/);
    expect(SIGNUP).not.toMatch(/role: "(staff|superadmin)"/);
  });
});
