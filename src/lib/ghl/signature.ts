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

/**
 * Whether unverified deliveries are REJECTED (fail-closed) or merely observed.
 *
 * Off by default, deliberately. A freshly-configured public key must be proven
 * against live traffic before it can be trusted to reject: the `__signature`
 * status is recorded on every event regardless, so the operator can confirm
 * real deliveries read "valid" FIRST, then flip this on. Only then do forged or
 * unsigned deliveries get a 401. The staged rollout exists because a wrong key
 * would 401 correctly-signed events, and GoHighLevel has no history API to
 * replay a dropped stage transition from — the loss would be permanent.
 *
 * Accepts 1 / true / yes / on (case-insensitive); anything else is off.
 */
export function webhookEnforcementEnabled(): boolean {
  const v = (process.env.GHL_WEBHOOK_ENFORCE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

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

/**
 * Should this delivery be rejected outright?
 *
 * ── Why this is a function and not four lines in the route ────────────
 *
 * It is a four-way rule over two independent signals, and every wrong cell has
 * a permanent cost in one direction or the other: reject something genuine and
 * a stage transition is lost with no history API to replay it from; accept a
 * forgery and the append-only ledger gains an appointment that no report can
 * ever disprove. Inline in a route handler it was reachable only by standing up
 * the whole receiver, so the truth table had never been asserted.
 *
 * The cells, and why each is what it is:
 *
 *   valid            → never rejected, obviously.
 *   invalid          → always a forgery. A signature that is PRESENT and wrong
 *                      is not a misconfiguration; nothing legitimate produces
 *                      one.
 *   no_signature     → forged only IN PRODUCTION. This receiver routes by
 *                      `locationId`, a non-secret identifier, so once a key is
 *                      configured an unsigned delivery has nothing vouching for
 *                      it. Locally, unsigned is how everyone tests.
 *   not_configured   → NEVER rejected, even under enforcement. We cannot verify
 *                      at all, so rejecting would discard genuine history to
 *                      punish our own missing config.
 *
 * And all of it is gated on `enforce`, which is off by default: until the
 * operator has watched real deliveries read "valid", this only observes.
 */
/**
 * May this delivery REVOKE something, as opposed to adding to what we hold?
 *
 * 🔴 A second, stricter gate, deliberately not folded into
 * `shouldRejectDelivery`.
 *
 * That function implements a staged rollout: with `GHL_WEBHOOK_ENFORCE` off, a
 * delivery whose signature is invalid or absent is still processed. For DATA
 * that is the right trade — a rejected opportunity event is funnel history
 * GoHighLevel cannot supply twice, so recording an unverified one and sorting
 * it out from the stored payload later beats losing it.
 *
 * The trade inverts for anything destructive. `UNINSTALL` takes a client's CRM
 * pipe offline, the receiver is necessarily public, and a `locationId` is not a
 * secret — it appears in URLs, support threads, and every one of that client's
 * own webhooks. In observe mode, four lines of JSON from anyone who has seen
 * one would disconnect them, and no replay brings the missing leads back
 * because they were never sent.
 *
 * So: an unverified delivery may ADD information, since a wrong row can be
 * corrected from the raw payload we kept. It may not REVOKE anything, because
 * there is no equivalent way back.
 *
 * Note what this costs when `GHL_WEBHOOK_KEY` is unset: a genuine uninstall is
 * recorded but not acted on, leaving the installation marked live until its
 * token stops working and the health checklist says so. That is a stale flag —
 * visible, and wrong in the safe direction.
 */
export function mayRevokeOnDelivery(signature: SignatureResult): boolean {
  return signature.status === "valid";
}

export function shouldRejectDelivery(
  signature: SignatureResult,
  opts: { enforce: boolean; isProduction: boolean },
): { reject: boolean; reason: string | null } {
  const forged = signature.status === "invalid";
  const unsignedInProd =
    signature.status === "skipped" &&
    signature.code === "no_signature" &&
    opts.isProduction;

  if (!forged && !unsignedInProd) return { reject: false, reason: null };
  const reason = forged ? "invalid signature" : "unsigned delivery rejected";
  // Observe mode: the caller still logs and records the status, but the
  // delivery is processed rather than dropped.
  return { reject: opts.enforce, reason };
}
