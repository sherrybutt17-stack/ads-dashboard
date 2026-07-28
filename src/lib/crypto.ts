import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * AES-256-GCM encryption for per-client credentials.
 *
 * Client GHL tokens and Meta token overrides are entered through the onboarding
 * UI at runtime, so they cannot live in env vars — they go in the `clients`
 * table, encrypted with a key that does.
 */

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32",
    );
  }
  // Accept either a 64-char hex key or any passphrase (hashed to 32 bytes).
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return createHash("sha256").update(raw).digest();
}

/** Returns `iv:authTag:ciphertext`, all base64. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decrypt(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext — expected iv:authTag:ciphertext");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Malformed ciphertext — bad auth tag length");
  }
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Nullable-safe helpers, since these columns are optional. */
export function encryptNullable(v: string | null | undefined): string | null {
  return v ? encrypt(v) : null;
}

export function decryptNullable(v: string | null | undefined): string | null {
  return v ? decrypt(v) : null;
}

/**
 * Meta requires `appsecret_proof` on server-side calls: an HMAC-SHA256 of the
 * access token, keyed by the app secret. Sending it on every request is the
 * documented best practice and hardens against a leaked token.
 */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

/** Constant-time compare, for the dashboard password gate. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return ha.equals(hb);
}

/* ------------------------------------------------------------------ *
 * User password hashing — scrypt (built into node:crypto, no dependency)
 * ------------------------------------------------------------------ */

const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_KEYLEN = 32;

/** Hash a user password. Returns `scrypt$<N>$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verify a password against a stored hash. Constant-time; never throws. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, nStr, saltHex, hashHex] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const N = Number(nStr);
    if (!Number.isFinite(N)) return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, salt, expected.length, { N });
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
