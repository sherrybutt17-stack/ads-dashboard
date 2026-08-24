import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import {
  RENDER_TOKEN_TTL_SECONDS,
  mintRenderToken,
  verifyRenderToken,
  type RenderClaims,
} from "./render-token";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

const CLAIMS: RenderClaims = {
  clientId: "11111111-2222-3333-4444-555555555555",
  start: "2026-07-01",
  end: "2026-07-31",
  platform: "meta",
};

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

describe("mint → verify", () => {
  it("round-trips every claim", () => {
    const r = verifyRenderToken(mintRenderToken(CLAIMS, NOW), NOW);
    expect(r).toEqual({ ok: true, claims: CLAIMS });
  });

  it("produces a URL-safe token", () => {
    // It goes in a path segment. `+`, `/` and `=` would all need escaping, and
    // one of the three would eventually not get it.
    expect(mintRenderToken(CLAIMS, NOW)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("is deterministic for the same claims and instant", () => {
    expect(mintRenderToken(CLAIMS, NOW)).toBe(mintRenderToken(CLAIMS, NOW));
  });
});

describe("🔴 forgery", () => {
  it("rejects a flipped byte in the signature", () => {
    const token = mintRenderToken(CLAIMS, NOW);
    const dot = token.indexOf(".");
    const sig = token.slice(dot + 1);
    const tampered =
      token.slice(0, dot + 1) + (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyRenderToken(tampered, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("🔴 rejects a payload edited to point at another client", () => {
    /*
     * The attack this whole file exists to stop: take a token you were legitimately
     * issued and swap the client id for someone else's.
     */
    const token = mintRenderToken(CLAIMS, NOW);
    const [body, sig] = token.split(".");
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    const swapped = decoded.replace(CLAIMS.clientId, "99999999-9999-9999-9999-999999999999");
    const forged = `${Buffer.from(swapped).toString("base64url")}.${sig}`;
    expect(verifyRenderToken(forged, NOW).ok).toBe(false);
  });

  it("🔴 rejects a payload edited to widen the date range", () => {
    // The range is INSIDE the signature, not a separate query parameter, so a
    // valid token cannot be replayed against a different window.
    const token = mintRenderToken(CLAIMS, NOW);
    const [body, sig] = token.split(".");
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    const widened = decoded.replace("2026-07-01", "2020-01-01");
    expect(
      verifyRenderToken(`${Buffer.from(widened).toString("base64url")}.${sig}`, NOW).ok,
    ).toBe(false);
  });

  it("rejects a payload edited to extend the expiry", () => {
    const token = mintRenderToken(CLAIMS, NOW);
    const [body, sig] = token.split(".");
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    const parts = decoded.split("\n");
    parts[4] = String(Number(parts[4]) + 86_400);
    const forged = `${Buffer.from(parts.join("\n")).toString("base64url")}.${sig}`;
    expect(verifyRenderToken(forged, NOW).ok).toBe(false);
  });

  it("rejects a token signed with a different key", () => {
    const token = mintRenderToken(CLAIMS, NOW);
    process.env.ENCRYPTION_KEY = "1".repeat(64);
    const r = verifyRenderToken(token, NOW);
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("🔴 cannot be confused by moving a separator between fields", () => {
    /*
     * The reason the canonical form is `\n`-separated rather than concatenated.
     * With no separator, {clientId:"ab", start:"cd"} and {clientId:"abc",
     * start:"d"} sign identical bytes, and one valid token authorises a report
     * it was not issued for.
     */
    const a = mintRenderToken(
      { clientId: "ab", start: "cd", end: "e", platform: "meta" },
      NOW,
    );
    const b = mintRenderToken(
      { clientId: "abc", start: "d", end: "e", platform: "meta" },
      NOW,
    );
    expect(a).not.toBe(b);
  });
});

describe("expiry", () => {
  it(`lives ${RENDER_TOKEN_TTL_SECONDS} seconds`, () => {
    const token = mintRenderToken(CLAIMS, NOW);
    expect(verifyRenderToken(token, NOW + (RENDER_TOKEN_TTL_SECONDS - 1) * 1000).ok).toBe(
      true,
    );
    expect(
      verifyRenderToken(token, NOW + (RENDER_TOKEN_TTL_SECONDS + 1) * 1000),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("🔴 checks the signature BEFORE the expiry", () => {
    /*
     * Order matters: answering "expired" for a forged payload would let an
     * attacker learn that their edit parsed, and would let unsigned input decide
     * whether the comparison runs at all.
     */
    const forged = `${Buffer.from("a\nb\nc\nd\n1").toString("base64url")}.notasignature`;
    expect(verifyRenderToken(forged, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("is short enough that statelessness costs nothing", () => {
    // The trade a stateless token makes is that it cannot be revoked early.
    // At this TTL that window is shorter than a revocation would take to reach
    // anyone, which is what makes the trade acceptable here and nowhere else.
    expect(RENDER_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(300);
  });
});

describe("malformed input", () => {
  it.each([
    ["empty", ""],
    ["no separator", "abcdef"],
    ["separator first", ".abc"],
    ["separator last", "abc."],
    ["not base64", "!!!.???"],
  ])("refuses %s without throwing", (_label, token) => {
    expect(() => verifyRenderToken(token, NOW)).not.toThrow();
    expect(verifyRenderToken(token, NOW).ok).toBe(false);
  });

  it("refuses null and undefined", () => {
    expect(verifyRenderToken(null, NOW).ok).toBe(false);
    expect(verifyRenderToken(undefined, NOW).ok).toBe(false);
  });

  it("refuses a correctly-signed payload with the wrong field count", () => {
    // Signed by us, so the signature passes — the shape check is what stops it.
    const body = "only\nthree\nfields";
    const key = createHmac("sha256", process.env.ENCRYPTION_KEY!)
      .update("report-render-token/v1")
      .digest();
    const sig = createHmac("sha256", key).update(body).digest("base64url");
    const token = `${Buffer.from(body).toString("base64url")}.${sig}`;
    expect(verifyRenderToken(token, NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});
