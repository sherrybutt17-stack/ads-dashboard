import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The order of operations in the board routes.
 *
 * A board is client-tier: the client can save it. So the safety argument is
 * an ordering one, the section-layout route's — the tenant is checked, then
 * the STORED board, then the caller's role against that board's lock, and only
 * then is anything in the request body read, with the schema for that role.
 * A refactor that parses the body first ("validate early") would let a client
 * probe a locked board with payloads, and one that picks the schema from the
 * body would let a client send `locked: false`. Neither shows up in a type
 * check, so the order is asserted against the source.
 */

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

const BOARD = source("src", "app", "api", "c", "[slug]", "board", "route.ts");
const DATA = source("src", "app", "api", "c", "[slug]", "board", "data", "route.ts");

/** One exported handler's body, from its signature to the next export. */
function handler(src: string, method: string): string {
  const start = src.indexOf(`export async function ${method}(`);
  expect(start, `no ${method} handler`).toBeGreaterThan(-1);
  const next = src.indexOf("export async function", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/** Asserts each needle appears, in this order. */
function inOrder(text: string, needles: string[]) {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at + 1);
    expect(i, `"${n}" missing or out of order`).toBeGreaterThan(at);
    at = i;
  }
}

describe("board route", () => {
  for (const method of ["PUT", "DELETE"]) {
    it(`🔴 ${method}: tenant, stored board, lock, rate limit — in that order`, () => {
      inOrder(handler(BOARD, method), [
        "clientAccessGuard(slug)",
        "getClientForSession(session, slug)",
        "getBoard(client.id",
        "authorizeBoardWrite(session, slug, current)",
        "writeGate(client.id)",
      ]);
    });
  }

  it("🔴 PUT reads the body only after the lock check, with the caller's schema", () => {
    const put = handler(BOARD, "PUT");
    inOrder(put, ["authorizeBoardWrite(", "writeGate(", "req.json()"]);
    expect(put).toMatch(
      /verdict\.staff\s*\?\s*StaffBoardWriteSchema\.safeParse\(body\)\s*:\s*ClientBoardWriteSchema\.safeParse\(body\)/,
    );
    // The lock is taken from the staff shape only.
    expect(put).toMatch(/const locked = verdict\.staff \?/);
  });

  it("🔴 checks an agency metric against the client's own agency before saving", () => {
    // The schema lets any `custom:` id through on shape; this is where another
    // agency's id — or a deleted one — is refused.
    inOrder(handler(BOARD, "PUT"), [
      "ClientBoardWriteSchema.safeParse(body)",
      "checkWidget(widgetQueryOf(w), context.registry)",
      "saveBoard(",
    ]);
  });

  it("answers a conflicting save with 409 and the board as it now is", () => {
    expect(handler(BOARD, "PUT")).toMatch(/board: serialise\(outcome\.current\)[\s\S]*status: 409/);
  });

  it("audits saves and resets", () => {
    expect(handler(BOARD, "PUT")).toContain('action: "board.update"');
    expect(handler(BOARD, "DELETE")).toContain('action: "board.reset"');
  });

  it("rate-limits per client, in one bucket for both writes", () => {
    expect(BOARD).toContain("`board:${clientId}`");
  });

  it("is never cached", () => {
    expect(handler(BOARD, "GET")).toContain('"Cache-Control": "no-store"');
  });
});

describe("board data route", () => {
  const get = handler(DATA, "GET");

  it("🔴 validates the question and the range before any query", () => {
    inOrder(get, [
      "clientAccessGuard(slug)",
      "WidgetQuerySchema.safeParse(decodeWidgetQuery(",
      "isValidDateKey(start)",
      "MAX_RANGE_DAYS",
      "rateLimit(`board-data:${client.id}`",
      "loadWidgetData(",
    ]);
  });

  it("gives reach its own, smaller limit, and reads the cache past it", () => {
    expect(get).toMatch(/rateLimit\(`board-reach:\$\{client\.id\}`, REACH_LIMIT/);
    expect(get).toMatch(/mode = "document"/);
  });

  it("🔴 resolves agency metrics from the client's agency, server-side, before loading", () => {
    inOrder(get, ["loadBoardContext(client)", "context.registry.base(query.metric)", "registry: context.registry"]);
  });

  it("only reads: there is no write handler", () => {
    expect(DATA).not.toMatch(/export async function (PUT|POST|PATCH|DELETE)/);
  });

  it("is never cached", () => {
    expect(get).toContain('"Cache-Control": "no-store"');
  });
});
