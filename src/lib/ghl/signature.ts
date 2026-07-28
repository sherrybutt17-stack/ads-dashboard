import { createPublicKey, createVerify, verify as edVerify } from "node:crypto";

/**
 * Webhook signature verification.
 *
 * GHL is mid-migration between two schemes:
 *   X-GHL-Signature  — Ed25519, current
 *   X-WH-Signature   — RSA-SHA256, deprecated 2026-09-01
 *
 * Both are supported so a payload signed either way validates during the
 * overlap. The public key is supplied via env rather than hardcoded — GHL
 * publishes it in the marketplace docs, and baking in a key we could not
 * independently confirm would be worse than requiring one line of config.
 *
 * When no key is configured, verification is SKIPPED rather than failing.
 * That is the deliberate choice: rejecting unverified deliveries would silently
 * discard stage transitions, and GoHighLevel has no history API to recover them
 * from. The endpoint's other defences (unguessable URL for workflow webhooks,
 * locationId→installation lookup for app webhooks) still apply, and the health
 * checklist reports when verification is inactive.
 */

export type SignatureResult =
  | { status: "valid"; scheme: "ed25519" | "rsa" }
  | { status: "invalid"; scheme: "ed25519" | "rsa"; reason: string }
  // `code` distinguishes "we cannot verify because no key is set" (preserve the
  // delivery) from "a key IS set but this delivery arrived unsigned" (in
  // production, treat as forged).
  | { status: "skipped"; code: "not_configured" | "no_signature"; reason: string };

function publicKeyPem(): string | null {
  const raw = process.env.GHL_WEBHOOK_PUBLIC_KEY;
  if (!raw) return null;
  // Allow the key to be pasted with literal \n escapes, as env UIs often force.
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

export function verifyWebhookSignature(
  rawBody: string,
  headers: { ghlSignature?: string | null; whSignature?: string | null },
): SignatureResult {
  const pem = publicKeyPem();
  if (!pem) {
    return {
      status: "skipped",
      code: "not_configured",
      reason: "GHL_WEBHOOK_PUBLIC_KEY is not configured",
    };
  }

  const { ghlSignature, whSignature } = headers;
  if (!ghlSignature && !whSignature) {
    return {
      status: "skipped",
      code: "no_signature",
      reason: "no signature header present",
    };
  }

  // Prefer the current scheme when both are present.
  if (ghlSignature) {
    try {
      const key = createPublicKey(pem);
      const ok = edVerify(
        null, // Ed25519 takes no separate digest algorithm
        Buffer.from(rawBody, "utf8"),
        key,
        Buffer.from(ghlSignature, "base64"),
      );
      return ok
        ? { status: "valid", scheme: "ed25519" }
        : { status: "invalid", scheme: "ed25519", reason: "signature mismatch" };
    } catch (err) {
      return {
        status: "invalid",
        scheme: "ed25519",
        reason: err instanceof Error ? err.message : "verification error",
      };
    }
  }

  try {
    const verifier = createVerify("SHA256");
    verifier.update(rawBody);
    verifier.end();
    const ok = verifier.verify(pem, whSignature!, "base64");
    return ok
      ? { status: "valid", scheme: "rsa" }
      : { status: "invalid", scheme: "rsa", reason: "signature mismatch" };
  } catch (err) {
    return {
      status: "invalid",
      scheme: "rsa",
      reason: err instanceof Error ? err.message : "verification error",
    };
  }
}
