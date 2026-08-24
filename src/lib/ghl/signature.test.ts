import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { generateKeyPairSync, sign as edSign, createSign } from "node:crypto";
import {
  verifyWebhookSignature,
  webhookEnforcementEnabled,
  shouldRejectDelivery,
  type SignatureResult,
  mayRevokeOnDelivery,
} from "./signature";

/**
 * Webhook signature verification.
 *
 * ── What this actually guards ─────────────────────────────────────────
 *
 * The webhook receiver is the only writer of observed stage history, and GHL
 * has no history API — so anything that gets past this function writes into a
 * table that can never be corrected against an upstream source. A forged POST
 * does not corrupt a cache; it invents appointments that no report can ever
 * disprove.
 *
 * 🔴 Signed with REAL keys, generated in the test. Stubbing `node:crypto` here
 * would leave the test asserting that the branches are wired up while proving
 * nothing about whether a forgery actually fails — which is the entire question.
 * Both schemes are exercised because GHL is mid-migration and has published
 * payloads under each.
 */

let ed: { publicKey: string; privateKey: string };
let rsa: { publicKey: string; privateKey: string };
let otherEd: { publicKey: string; privateKey: string };

const BODY = JSON.stringify({
  type: "OpportunityStageUpdate",
  id: "opp0000000000000001",
  pipelineStageId: "aaaaaaaa-0000-4000-8000-000000000002",
});

const signEd = (body: string, key = ed.privateKey) =>
  edSign(null, Buffer.from(body, "utf8"), key).toString("base64");

const signRsa = (body: string, key = rsa.privateKey) => {
  const s = createSign("SHA256");
  s.update(body);
  s.end();
  return s.sign(key, "base64");
};

const pem = (keys: { publicKey: string }) => keys.publicKey;

beforeAll(() => {
  const opts = { publicKeyEncoding: { type: "spki", format: "pem" } } as const;
  ed = generateKeyPairSync("ed25519", {
    ...opts,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }) as unknown as typeof ed;
  otherEd = generateKeyPairSync("ed25519", {
    ...opts,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }) as unknown as typeof otherEd;
  rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    ...opts,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }) as unknown as typeof rsa;
});

beforeEach(() => {
  delete process.env.GHL_WEBHOOK_PUBLIC_KEY;
  delete process.env.GHL_WEBHOOK_ENFORCE;
});

describe("a genuine delivery", () => {
  it("validates the current Ed25519 scheme", () => {
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(ed);
    expect(
      verifyWebhookSignature(BODY, { ghlSignature: signEd(BODY) }),
    ).toEqual({ status: "valid", scheme: "ed25519" });
  });

  it("validates the deprecated RSA scheme during the overlap", () => {
    // X-WH-Signature is deprecated 2026-09-01, not gone. Dropping it early
    // would 401 live deliveries with no way to replay them.
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(rsa);
    expect(
      verifyWebhookSignature(BODY, { whSignature: signRsa(BODY) }),
    ).toEqual({ status: "valid", scheme: "rsa" });
  });

  it("prefers the current scheme when both headers arrive", () => {
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(ed);
    const result = verifyWebhookSignature(BODY, {
      ghlSignature: signEd(BODY),
      // Garbage in the deprecated header must not decide the outcome either way.
      whSignature: "not-a-signature",
    });
    expect(result).toEqual({ status: "valid", scheme: "ed25519" });
  });

  it("🔴 accepts a key pasted with literal \\n escapes", () => {
    /*
     * Not cosmetic. Several env UIs (Vercel's included) collapse a pasted
     * multi-line PEM into one line with literal backslash-n. Without this the
     * key silently fails to parse, every delivery reads "invalid", and with
     * enforcement on the receiver 401s genuine traffic — permanently losing
     * transitions GHL cannot replay.
     */
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(ed).replace(/\n/g, "\\n");
    expect(verifyWebhookSignature(BODY, { ghlSignature: signEd(BODY) })).toEqual({
      status: "valid",
      scheme: "ed25519",
    });
  });
});

describe("a forgery", () => {
  it("🔴 rejects a body altered after signing", () => {
    // The attack this exists to stop: a real captured delivery, replayed with
    // the stage changed to closed_won.
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(ed);
    const signature = signEd(BODY);
    const tampered = BODY.replace("OpportunityStageUpdate", "OpportunityCreate");

    expect(verifyWebhookSignature(tampered, { ghlSignature: signature })).toMatchObject({
      status: "invalid",
      scheme: "ed25519",
    });
  });

  it("🔴 rejects a signature from a different key", () => {
    // Anyone can generate a keypair and sign anything. Only OUR key counts.
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(ed);
    expect(
      verifyWebhookSignature(BODY, { ghlSignature: signEd(BODY, otherEd.privateKey) }),
    ).toMatchObject({ status: "invalid", scheme: "ed25519" });
  });

  it("🔴 rejects a tampered RSA body too", () => {
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(rsa);
    const signature = signRsa(BODY);
    expect(
      verifyWebhookSignature(`${BODY} `, { whSignature: signature }),
    ).toMatchObject({ status: "invalid", scheme: "rsa" });
  });

  it("reports malformed base64 as invalid, never as an exception", () => {
    /*
     * A throw here would escape into the webhook route. The receiver's whole
     * design is to persist the raw payload and return 200 fast, so an
     * unhandled exception turns one bad delivery into a GHL retry storm.
     */
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(ed);
    // Not "" — an empty header means ABSENT, asserted separately below.
    for (const junk of ["%%%%", "a", "!!not base64!!", "===="]) {
      const r = verifyWebhookSignature(BODY, { ghlSignature: junk });
      expect(r.status).toBe("invalid");
    }
  });

  it("does not accept an unparseable public key as a pass", () => {
    // A mis-pasted key must fail closed into "invalid", never "valid".
    process.env.GHL_WEBHOOK_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----";
    expect(
      verifyWebhookSignature(BODY, { ghlSignature: signEd(BODY) }).status,
    ).toBe("invalid");
  });
});

describe("the two ways of not verifying", () => {
  /*
   * 🔴 These must stay distinguishable. "We cannot verify because no key is
   * configured" is an operator state where the delivery MUST be preserved —
   * dropping it destroys a transition GHL cannot supply again. "A key IS set
   * and this arrived unsigned" is a different fact entirely, and in production
   * it means forged. One `skipped` for both would force the receiver to guess.
   */

  it("no key configured is skipped, not invalid", () => {
    expect(verifyWebhookSignature(BODY, { ghlSignature: signEd(BODY) })).toEqual({
      status: "skipped",
      code: "not_configured",
      reason: expect.any(String),
    });
  });

  it("a key set but no signature header is a DIFFERENT skip", () => {
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(ed);
    expect(
      verifyWebhookSignature(BODY, { ghlSignature: null, whSignature: null }),
    ).toEqual({ status: "skipped", code: "no_signature", reason: expect.any(String) });
  });

  it("an empty-string header counts as absent, not as a forgery", () => {
    // Header plumbing yields "" as readily as null; treating that as a failed
    // signature would reject workflow webhooks, which carry no header at all.
    process.env.GHL_WEBHOOK_PUBLIC_KEY = pem(ed);
    const r = verifyWebhookSignature(BODY, { ghlSignature: "", whSignature: "" });
    expect(r).toMatchObject({ status: "skipped", code: "no_signature" });
  });
});

describe("staged enforcement", () => {
  /*
   * Off by default on purpose. A wrong key would 401 correctly-signed events,
   * and there is no history API to replay a dropped transition from — the loss
   * is permanent. So the operator watches `__signature` read "valid" on real
   * traffic first, then flips this on.
   */

  it("🔴 defaults to off when unset", () => {
    expect(webhookEnforcementEnabled()).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "On", " true "])("accepts %s", (v) => {
    process.env.GHL_WEBHOOK_ENFORCE = v;
    expect(webhookEnforcementEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", "", "enabled", "2"])(
    "🔴 does not enable on %s",
    (v) => {
      // Anything ambiguous stays OFF. Turning enforcement on by accident is the
      // failure that loses data; leaving it off merely leaves it observed.
      process.env.GHL_WEBHOOK_ENFORCE = v;
      expect(webhookEnforcementEnabled()).toBe(false);
    },
  );
});

describe("the rejection truth table", () => {
  /*
   * 🔴 Every wrong cell here costs something permanent, in one direction or the
   * other: reject a genuine delivery and a stage transition is gone, with no
   * history API to replay it from; accept a forgery and the append-only ledger
   * gains an appointment that no report can ever disprove.
   */

  const VALID: SignatureResult = { status: "valid", scheme: "ed25519" };
  const INVALID: SignatureResult = {
    status: "invalid",
    scheme: "ed25519",
    reason: "signature mismatch",
  };
  const UNSIGNED: SignatureResult = {
    status: "skipped",
    code: "no_signature",
    reason: "",
  };
  const NO_KEY: SignatureResult = {
    status: "skipped",
    code: "not_configured",
    reason: "",
  };

  const verdict = (s: SignatureResult, enforce: boolean, isProduction: boolean) =>
    shouldRejectDelivery(s, { enforce, isProduction });

  it("a valid signature is never rejected", () => {
    for (const enforce of [true, false]) {
      for (const prod of [true, false]) {
        expect(verdict(VALID, enforce, prod)).toEqual({ reject: false, reason: null });
      }
    }
  });

  it("🔴 an invalid signature is a forgery in every environment", () => {
    // A signature that is PRESENT and wrong is not a misconfiguration —
    // nothing legitimate produces one, in dev or anywhere else.
    expect(verdict(INVALID, true, true).reject).toBe(true);
    expect(verdict(INVALID, true, false).reject).toBe(true);
    expect(verdict(INVALID, true, false).reason).toBe("invalid signature");
  });

  it("🔴 an unsigned delivery is a forgery only in production", () => {
    /*
     * The receiver routes by `locationId`, a non-secret identifier, so in
     * production an unsigned delivery has nothing vouching for it. Locally,
     * unsigned is how everybody tests — rejecting there buys nothing and
     * breaks development.
     */
    expect(verdict(UNSIGNED, true, true)).toEqual({
      reject: true,
      reason: "unsigned delivery rejected",
    });
    expect(verdict(UNSIGNED, true, false).reject).toBe(false);
  });

  it("🔴 a missing key never rejects, even under enforcement", () => {
    /*
     * The cell that matters most. We cannot verify at all, so rejecting would
     * discard genuine funnel history to punish our own missing configuration —
     * and GHL cannot supply it again.
     */
    expect(verdict(NO_KEY, true, true)).toEqual({ reject: false, reason: null });
  });

  it("🔴 observe mode still NAMES the problem it declined to act on", () => {
    /*
     * Not merely `reject: false`. The staged rollout only works if a would-be
     * rejection is visible while it is not being enforced — a silent pass would
     * leave the operator with no signal that the key is wrong until they flip
     * enforcement on and start dropping live traffic.
     */
    for (const s of [INVALID, UNSIGNED]) {
      const v = verdict(s, false, true);
      expect(v.reject).toBe(false);
      expect(v.reason).toBeTruthy();
    }
  });
});

/**
 * 🔴 The stricter gate: what an unverified delivery is allowed to DESTROY.
 *
 * `shouldRejectDelivery` runs a staged rollout — with enforcement off, an
 * invalid or unsigned delivery is still processed, because a rejected
 * opportunity event is funnel history GHL cannot supply twice. That reasoning
 * covers adding information. It does not cover taking a client's CRM pipe
 * offline, which is what `UNINSTALL` does, on an endpoint that is necessarily
 * public, keyed by a `locationId` that is not a secret.
 */
describe("mayRevokeOnDelivery", () => {
  const enforcementOff = { enforce: false, isProduction: true };

  it("allows a revocation only on a verified delivery", () => {
    expect(mayRevokeOnDelivery({ status: "valid", scheme: "ed25519" })).toBe(true);
    expect(mayRevokeOnDelivery({ status: "valid", scheme: "rsa" })).toBe(true);
  });

  it("🔴 refuses a forged one", () => {
    expect(
      mayRevokeOnDelivery({
        status: "invalid",
        scheme: "ed25519",
        reason: "signature mismatch",
      }),
    ).toBe(false);
  });

  it("🔴 refuses an unsigned one", () => {
    // The actual attack shape: post JSON with no signature header at all.
    expect(
      mayRevokeOnDelivery({
        status: "skipped",
        code: "no_signature",
        reason: "no signature header",
      }),
    ).toBe(false);
  });

  it("🔴 refuses when no key is configured, rather than trusting everything", () => {
    /*
     * The dangerous default. With `GHL_WEBHOOK_KEY` unset every delivery is
     * "skipped/not_configured", so a rule phrased as "reject only what is
     * provably forged" would wave all of them through — and the deployment most
     * likely to be missing its key is the one least likely to notice.
     *
     * The cost is a genuine uninstall left recorded but not acted on: a stale
     * "installed" flag, wrong in the safe direction and visible on the health
     * checklist once the token stops working.
     */
    expect(
      mayRevokeOnDelivery({
        status: "skipped",
        code: "not_configured",
        reason: "no verification key configured",
      }),
    ).toBe(false);
  });

  it("🔴 is strictly stricter than shouldRejectDelivery", () => {
    /*
     * The relationship that must hold. Every delivery this permits must also be
     * one the ordinary gate accepts — otherwise a revocation could be acted on
     * by a request the receiver was going to turn away.
     *
     * The converse is deliberately false, and the interesting half: in observe
     * mode `shouldRejectDelivery` accepts an unsigned delivery and this still
     * refuses it. If these two ever agree on every input, the second gate has
     * stopped doing anything.
     */
    const deliveries: SignatureResult[] = [
      { status: "valid", scheme: "ed25519" },
      { status: "invalid", scheme: "ed25519", reason: "mismatch" },
      { status: "skipped", code: "no_signature", reason: "none" },
      { status: "skipped", code: "not_configured", reason: "none" },
    ];

    for (const d of deliveries) {
      if (mayRevokeOnDelivery(d)) {
        expect(shouldRejectDelivery(d, enforcementOff).reject).toBe(false);
      }
    }

    const acceptedButNotTrusted = deliveries.filter(
      (d) => !shouldRejectDelivery(d, enforcementOff).reject && !mayRevokeOnDelivery(d),
    );
    expect(acceptedButNotTrusted.length).toBeGreaterThan(0);
  });
});

describe("🔴 the receiver actually uses the gate", () => {
  it("does not call markUninstalled without checking first", () => {
    /*
     * A pure predicate nothing calls is worth nothing, and this one guards the
     * only destructive branch in a public endpoint. Asserted against the source
     * because standing up a Next route handler to prove one `if` would test the
     * harness more than the rule.
     */
    const receiver = readFileSync(
      join(process.cwd(), "src/app/api/webhooks/crm/route.ts"),
      "utf8",
    );
    expect(receiver).toContain("mayRevokeOnDelivery");
    const gateAt = receiver.indexOf("mayRevokeOnDelivery(signature)");
    const revokeAt = receiver.indexOf("markUninstalled(evt.locationId)");
    expect(gateAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(gateAt);
  });
});
