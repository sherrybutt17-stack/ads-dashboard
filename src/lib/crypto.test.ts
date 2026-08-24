import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHmac, scryptSync, randomBytes } from "node:crypto";
import {
  encrypt,
  decrypt,
  encryptNullable,
  decryptNullable,
  appSecretProof,
  safeEqual,
  hashPassword,
  verifyPassword,
} from "./crypto";

/**
 * The module every stored credential passes through.
 *
 * GHL private-integration tokens, Meta token overrides, Google refresh tokens,
 * TikTok access tokens and Slack alert webhooks all sit in Postgres encrypted
 * by `encrypt`; every login goes through `hashPassword`/`verifyPassword`; and
 * `safeEqual` is the only thing standing in front of five cron endpoints that
 * iterate every client.
 *
 * It had no tests. The reason that is worse here than elsewhere: broken
 * encryption does not throw. It returns a string that looks exactly like
 * ciphertext, and the failure surfaces — if ever — as a credential that stops
 * working months later, with no way to tell whether the token was revoked
 * upstream or we simply cannot read it back.
 */

const HEX_KEY = "a".repeat(64);
const OTHER_HEX = "b".repeat(64);
const TOKEN = "pit-0123456789abcdef-a-realistic-looking-ghl-token";

const originalKey = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = HEX_KEY;
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

describe("encrypting a credential", () => {
  it("round-trips exactly", () => {
    expect(decrypt(encrypt(TOKEN))).toBe(TOKEN);
  });

  it("round-trips unicode and long values without truncation", () => {
    // Client names and Slack URLs both reach these columns; a byte-vs-character
    // slip would corrupt silently rather than throw.
    for (const v of ["café ☕ — naïve", "x".repeat(5000), "{\"json\":true}"]) {
      expect(decrypt(encrypt(v))).toBe(v);
    }
  });

  it("🔴 produces different ciphertext every time", () => {
    /*
     * The random IV, and it is not a nicety. With a fixed IV, two clients who
     * pasted the same token would produce byte-identical rows — so anyone with
     * read access to the table could tell that two accounts share a credential
     * without decrypting anything. GCM additionally becomes catastrophically
     * weak under IV reuse: the same keystream is XORed against both plaintexts.
     */
    const a = encrypt(TOKEN);
    const b = encrypt(TOKEN);
    expect(a).not.toBe(b);
    expect(a.split(":")[0]).not.toBe(b.split(":")[0]);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it("🔴 refuses a ciphertext that has been tampered with", () => {
    /*
     * What the GCM auth tag buys. Without authentication an attacker with write
     * access to the row could flip bits in the ciphertext and steer the
     * decrypted token — here that fails loudly instead.
     */
    const [iv, tag, data] = encrypt(TOKEN).split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    expect(() => decrypt([iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });

  it("🔴 refuses a forged auth tag", () => {
    const [iv, tag, data] = encrypt(TOKEN).split(":");
    const forged = Buffer.from(tag, "base64");
    forged[0] ^= 0xff;
    expect(() => decrypt([iv, forged.toString("base64"), data].join(":"))).toThrow();
  });

  it("🔴 cannot be read with a different key", () => {
    // The whole premise of storing these in the database at all.
    const payload = encrypt(TOKEN);
    process.env.ENCRYPTION_KEY = OTHER_HEX;
    expect(() => decrypt(payload)).toThrow();
  });

  it("throws rather than returning garbage on a malformed payload", () => {
    for (const bad of ["", "nope", "a:b", "a:b:c:d", "::"]) {
      expect(() => decrypt(bad)).toThrow();
    }
  });

  it("rejects an auth tag of the wrong length", () => {
    const [iv, , data] = encrypt(TOKEN).split(":");
    expect(() => decrypt([iv, Buffer.from("short").toString("base64"), data].join(":"))).toThrow(
      /auth tag/i,
    );
  });

  it("🔴 refuses to work at all with no key configured", () => {
    // Failing closed matters more than the message: silently falling back to a
    // default or empty key would write credentials that anyone could read.
    const payload = encrypt(TOKEN);
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt(TOKEN)).toThrow(/ENCRYPTION_KEY/);
    expect(() => decrypt(payload)).toThrow(/ENCRYPTION_KEY/);
  });
});

describe("how the key is derived", () => {
  it("treats a 64-char hex key as raw bytes, in either case", () => {
    const payload = encrypt(TOKEN);
    process.env.ENCRYPTION_KEY = HEX_KEY.toUpperCase();
    // Same key, written differently — it must still decrypt, or rotating the
    // env var's letter case would lock every client out of their credentials.
    expect(decrypt(payload)).toBe(TOKEN);
  });

  it("accepts a passphrase by hashing it to 32 bytes", () => {
    process.env.ENCRYPTION_KEY = "a passphrase, not hex";
    expect(decrypt(encrypt(TOKEN))).toBe(TOKEN);
  });

  it("🔴 a passphrase and its hex-looking sibling are different keys", () => {
    /*
     * The one confusable case in the rule: 64 hex characters are used raw,
     * anything else is SHA-256'd. So a passphrase that happens to be 64 hex
     * chars takes the other branch. Pinned so the branch cannot be quietly
     * widened — a change there would make every existing ciphertext
     * undecryptable, with no error until someone tried to sync.
     */
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    const asHex = encrypt(TOKEN);
    process.env.ENCRYPTION_KEY = "0".repeat(63) + "z";
    expect(() => decrypt(asHex)).toThrow();
  });
});

describe("the nullable helpers", () => {
  it("passes null and undefined straight through", () => {
    expect(encryptNullable(null)).toBeNull();
    expect(encryptNullable(undefined)).toBeNull();
    expect(decryptNullable(null)).toBeNull();
    expect(decryptNullable(undefined)).toBeNull();
  });

  it("treats an empty string as absent", () => {
    // These back optional columns; "" and null both mean "no credential", and
    // encrypting "" would store a value that reads as configured.
    expect(encryptNullable("")).toBeNull();
    expect(decryptNullable("")).toBeNull();
  });

  it("round-trips a real value", () => {
    expect(decryptNullable(encryptNullable(TOKEN))).toBe(TOKEN);
  });
});

describe("Meta's appsecret_proof", () => {
  it("is the documented HMAC of the token, keyed by the app secret", () => {
    expect(appSecretProof(TOKEN, "app-secret")).toBe(
      createHmac("sha256", "app-secret").update(TOKEN).digest("hex"),
    );
  });

  it("🔴 is keyed by the SECRET, not by the token", () => {
    /*
     * Swapping the arguments still produces a plausible 64-char hex string, and
     * Meta rejects it with a generic OAuth error — which reads exactly like an
     * expired token. Someone would go re-issue a perfectly good System User
     * token before suspecting the argument order.
     */
    expect(appSecretProof(TOKEN, "app-secret")).not.toBe(
      appSecretProof("app-secret", TOKEN),
    );
  });

  it("is deterministic and hex", () => {
    const proof = appSecretProof(TOKEN, "app-secret");
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(appSecretProof(TOKEN, "app-secret")).toBe(proof);
  });
});

describe("comparing a shared secret", () => {
  it("matches identical values and rejects near-misses", () => {
    expect(safeEqual("s3cr3t", "s3cr3t")).toBe(true);
    expect(safeEqual("s3cr3t", "s3cr3T")).toBe(false);
    expect(safeEqual("s3cr3t", "s3cr3t ")).toBe(false);
    expect(safeEqual("s3cr3t", "s3cr3t-longer")).toBe(false);
  });

  it("handles wildly unequal lengths", () => {
    /*
     * 🔴 An honest note about what is NOT proven here.
     *
     * This function hashes both sides before comparing so that every comparison
     * is the same fixed-size operation regardless of input length — a raw `===`
     * leaks the secret's length, and then its prefix, through timing. That is a
     * TIMING property, and replacing the body with `a === b` produces identical
     * results for every input, so no behavioural test can detect the change.
     *
     * The assertions below pin the behaviour; the construction is protected by
     * the comment on the function and by this paragraph, not by a mutation
     * anyone can catch. Saying so beats a test that implies otherwise.
     */
    expect(safeEqual("a", "a".repeat(10_000))).toBe(false);
    expect(safeEqual("a".repeat(10_000), "a".repeat(10_000))).toBe(true);
  });

  it("🔴 two empty strings compare EQUAL — which is why callers check for a missing secret", () => {
    /*
     * Not a bug in this function, but the sharp edge that makes every cron
     * route write `if (!secret || !safeEqual(bearer, secret))`. Without the
     * first half, an unset CRON_SECRET would make five endpoints that iterate
     * every client answer to a request carrying no bearer token at all.
     * Asserted here so the hazard is documented where the function lives.
     */
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("user passwords", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("🔴 salts every hash, so identical passwords do not collide", () => {
    /*
     * Two users choosing the same password must not produce the same row, or
     * anyone reading the table learns which accounts share a password — and one
     * cracked hash unlocks all of them.
     */
    const a = hashPassword("hunter2");
    const b = hashPassword("hunter2");
    expect(a).not.toBe(b);
    expect(verifyPassword("hunter2", a)).toBe(true);
    expect(verifyPassword("hunter2", b)).toBe(true);
  });

  it("stores the scheme and cost, not a bare digest", () => {
    // So the cost can be raised later without invalidating existing hashes.
    const [scheme, n, salt, hash] = hashPassword("x").split("$");
    expect(scheme).toBe("scrypt");
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("🔴 never throws on a malformed or hostile stored value", () => {
    /*
     * `verifyPassword` runs on the login path against whatever is in the row.
     * A throw there is a 500 on sign-in — and a 500 that distinguishes some
     * accounts from others is itself an oracle. Every one of these must be a
     * quiet false.
     */
    for (const stored of [
      "",
      "not-a-hash",
      "scrypt$",
      "scrypt$notanumber$aa$bb",
      "scrypt$16384$nothex$nothex",
      "bcrypt$16384$aa$bb",
      "scrypt$-1$aa$bb",
      "scrypt$Infinity$aa$bb",
      "scrypt$16384$$",
      // 🔴 The bypass. `Buffer.from("nothex", "hex")` yields ZERO bytes rather
      // than throwing, so an unchecked implementation asks scrypt for a 0-byte
      // key, gets one, and compares empty to empty — true for every password.
      "scrypt$16384$zz".padEnd(45, "z") + "$" + "zz".repeat(32),
      // Valid hex, but far too short to be a real salt or key.
      "scrypt$16384$aabb$ccdd",
      "scrypt$16384$" + "a".repeat(32) + "$" + "b".repeat(2),
      // Odd-length hex: silently truncated by Buffer.from.
      "scrypt$16384$" + "a".repeat(31) + "$" + "b".repeat(63),
    ]) {
      expect(verifyPassword("anything", stored)).toBe(false);
    }
  });

  it("🔴 rejects a hash made from a different password", () => {
    expect(verifyPassword("hunter2", hashPassword("hunter3"))).toBe(false);
  });

  describe("stored values that are structurally valid but too weak", () => {
    /*
     * 🔴 Built with a CORRECTLY derived key at the bad size, so each case is
     * deterministic.
     *
     * Asserting `false` against a random short hash proves nothing: a 1-byte
     * key matches by chance 1 time in 256, so the test would pass by luck and
     * flake. Deriving the key properly means an implementation missing the
     * length floor returns TRUE every run, and one that has it returns false
     * every run — which is what makes these mutations detectable at all.
     */
    const PASSWORD = "hunter2";
    const forge = (saltBytes: number, keyBytes: number, N = 16384) => {
      const salt = randomBytes(saltBytes);
      const key = scryptSync(PASSWORD, salt, keyBytes, { N });
      return `scrypt$${N}$${salt.toString("hex")}$${key.toString("hex")}`;
    };

    it("🔴 refuses a key shorter than a real one", () => {
      // A truncated column leaves a hash that a brute-forcer clears in seconds.
      expect(verifyPassword(PASSWORD, forge(16, 1))).toBe(false);
      expect(verifyPassword(PASSWORD, forge(16, 8))).toBe(false);
      // …and the full-size one still works, so the floor is not simply "no".
      expect(verifyPassword(PASSWORD, forge(16, 32))).toBe(true);
    });

    it("🔴 refuses a salt shorter than a real one", () => {
      // A 1-byte salt is 256 possible salts — a rainbow table, not a salt.
      expect(verifyPassword(PASSWORD, forge(1, 32))).toBe(false);
      expect(verifyPassword(PASSWORD, forge(8, 32))).toBe(false);
    });

    it("🔴 refuses odd-length hex, which Buffer.from silently truncates", () => {
      const [scheme, n, salt, hash] = forge(16, 32).split("$");
      const stored = (sa: string, ha: string) => `${scheme}$${n}$${sa}$${ha}`;

      // A character short: truncated to fewer bytes than were written.
      expect(verifyPassword(PASSWORD, stored(salt, hash.slice(0, -1)))).toBe(false);
      expect(verifyPassword(PASSWORD, stored(salt.slice(0, -1), hash))).toBe(false);

      /*
       * 🔴 And a character LONG, which is the case the length floors cannot
       * see. `Buffer.from` keeps the first 32 whole bytes and drops the stray
       * nibble, so the decoded value equals the real hash exactly — a row with
       * one extra character silently authenticates as if it were correct,
       * while anything that later re-reads the column disagrees about what it
       * contains.
       */
      expect(verifyPassword(PASSWORD, stored(salt, `${hash}a`))).toBe(false);
      expect(verifyPassword(PASSWORD, stored(`${salt}a`, hash))).toBe(false);
    });

    it("🔴 refuses anything appended after the hash", () => {
      /*
       * Destructuring four names out of `split("$")` ignores extra parts, so
       * without an explicit count a row could carry trailing content that
       * verification silently disregards — and whatever wrote it thought it was
       * storing something meaningful.
       */
      expect(verifyPassword(PASSWORD, `${forge(16, 32)}$extra`)).toBe(false);
    });
  });
});
