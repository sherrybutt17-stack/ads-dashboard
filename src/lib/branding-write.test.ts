import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  authorizeClientBrandingWrite,
  ClientBrandingSchema,
  StaffBrandingSchema,
  readLogoUpload,
  sniffImageType,
  MAX_LOGO_BYTES,
} from "./branding-write";
import { NO_BRANDING } from "./branding";
import type { SessionPayload } from "./session";
import { createTestDb, CLIENT_A, type TestDb } from "./metrics/__testdb__/harness";

/**
 * The client-editable branding write path — W3, the only part of white-label
 * that changes the security model.
 *
 * Two failures are being defended against, and they are different in kind:
 *
 *   1. **A client editing branding they do not own.** Ordinary tenancy.
 *   2. 🔴 **A client who has been locked out unlocking themselves.** The
 *      `clientEditable` switch is stored on the very row the endpoint writes,
 *      so a naive implementation lets a locked client `PUT
 *      {"displayName":"x","clientEditable":true}` and grant themselves the
 *      permission they were just denied. The escape hatch defeats itself, and
 *      nothing errors.
 *
 * The second is defended twice over — the stored flag is consulted before any
 * body is parsed, AND the client schema does not contain the field. The tests
 * below check both mechanisms independently, so removing either one fails.
 */

// Hoisted by vitest regardless of where it is written; keep it at the top so
// the file reads in the order it actually executes.
vi.mock("@/db", () => ({
  get db() {
    return globalThis.__brandingHarnessDb;
  },
  schema: {},
}));

const AG = "00000000-0000-0000-0000-0000000000aa";
const staff: SessionPayload = { userId: "s1", agencyId: AG, role: "staff", slugs: [] };
const owner: SessionPayload = { userId: "c1", agencyId: AG, role: "client", slugs: ["acme"] };
const other: SessionPayload = { userId: "c2", agencyId: AG, role: "client", slugs: ["rival"] };
// Operator roles carry no slugs — see the note in `dashboard/layout.test.ts`.
const agency: SessionPayload = { userId: "a1", agencyId: AG, role: "agency", slugs: [] };
const superadmin: SessionPayload = { userId: "sa", agencyId: AG, role: "superadmin", slugs: [] };

const unlocked = { ...NO_BRANDING, clientEditable: true };
const locked = { ...NO_BRANDING, clientEditable: false };

describe("who may write a client's branding", () => {
  it("an anonymous caller cannot", () => {
    expect(authorizeClientBrandingWrite(null, "acme", unlocked)).toEqual({
      ok: false,
      status: 401,
      error: "Unauthorized",
    });
  });

  it("staff always can, even when the client is locked out", () => {
    // The switch restrains the client, not the agency.
    expect(authorizeClientBrandingWrite(staff, "acme", locked)).toEqual({
      ok: true,
      staff: true,
    });
  });

  it("the owning client can, once enabled", () => {
    expect(authorizeClientBrandingWrite(owner, "acme", unlocked)).toEqual({
      ok: true,
      staff: false,
    });
  });

  it("🔴 a DIFFERENT client cannot, even when that client's own branding is unlocked", () => {
    const verdict = authorizeClientBrandingWrite(other, "acme", unlocked);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.status).toBe(403);
  });

  it("🔴 the owning client cannot while locked out", () => {
    const verdict = authorizeClientBrandingWrite(owner, "acme", locked);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(403);
      // Says what to do about it — the client is not doing anything wrong.
      expect(verdict.error).toMatch(/agency/i);
    }
  });

  it("🔴 defaults to LOCKED when no branding row exists", () => {
    /*
     * Fail closed. `getClientBranding` returns NO_BRANDING both for a client
     * that has never been branded AND for any database error, so if this
     * default were `true` an unreachable database would silently open every
     * client's branding to editing.
     */
    expect(NO_BRANDING.clientEditable).toBe(false);
    const verdict = authorizeClientBrandingWrite(owner, "acme", NO_BRANDING);
    expect(verdict.ok).toBe(false);
  });

  it("🔴 an agency operator can, even when the client is locked out", () => {
    // The switch restrains the CLIENT, not the agency — and an agency operator
    // is the agency. Checking for `staff` alone locked them out of their own
    // clients' branding entirely.
    expect(authorizeClientBrandingWrite(agency, "acme", locked)).toEqual({
      ok: true,
      staff: true,
    });
  });

  it("🔴 a superadmin can", () => {
    expect(authorizeClientBrandingWrite(superadmin, "acme", locked)).toEqual({
      ok: true,
      staff: true,
    });
  });

  it("checks ownership before the editable flag", () => {
    // Otherwise a client could learn whether ANOTHER client's branding is
    // unlocked by comparing the two 403 messages.
    const foreign = authorizeClientBrandingWrite(other, "acme", locked);
    const foreignUnlocked = authorizeClientBrandingWrite(other, "acme", unlocked);
    expect(foreign).toEqual(foreignUnlocked);
  });
});

describe("what a client may write", () => {
  it("accepts the four fields that are theirs", () => {
    const parsed = ClientBrandingSchema.safeParse({
      displayName: "Acme Aesthetics",
      brandColor: "#2aa9b8",
      reportContactLine: "hello@acme.example",
    });
    expect(parsed.success).toBe(true);
  });

  it("🔴 REJECTS clientEditable rather than ignoring it", () => {
    /*
     * The escape hatch, defence two. Even a client who IS currently allowed to
     * edit must not be able to make that permanent. Rejecting rather than
     * silently dropping matters: a caller told "ok" while its field was
     * discarded believes the write succeeded as sent.
     */
    const parsed = ClientBrandingSchema.safeParse({
      displayName: "Acme",
      clientEditable: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("🔴 REJECTS brandColorAppliesToDashboard", () => {
    // Agency-owned: a brand red on a dashboard whose status colours are
    // red/amber/green is a legibility problem, not a preference.
    const parsed = ClientBrandingSchema.safeParse({
      brandColorAppliesToDashboard: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects any unknown key", () => {
    for (const key of ["clientId", "id", "webhookToken", "role", "status"]) {
      const parsed = ClientBrandingSchema.safeParse({ [key]: "x" });
      expect(parsed.success, `${key} should be rejected`).toBe(false);
    }
  });

  it("strips __proto__ rather than rejecting it, and pollutes nothing", () => {
    /*
     * Measured, because it is the one unknown key that does NOT behave like the
     * others: zod's `.strict()` rejects `clientId` but silently drops
     * `__proto__`. Worth pinning rather than assuming, since the whole point of
     * strict parsing here is that nothing unexpected reaches the writer.
     *
     * The safe outcome is what happens — the key is absent from the parsed
     * object, so it never reaches `saveClientBranding`, and `Object.prototype`
     * is untouched. Asserting "rejected" would have been a test that failed for
     * a behaviour that is fine.
     */
    const body = JSON.parse(
      '{"displayName":"Acme","__proto__":{"polluted":true}}',
    );
    const parsed = ClientBrandingSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data)).toEqual(["displayName"]);
      expect(Object.getOwnPropertyNames(parsed.data)).not.toContain("__proto__");
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("bounds the free-text fields", () => {
    expect(
      ClientBrandingSchema.safeParse({ displayName: "x".repeat(121) }).success,
    ).toBe(false);
    expect(
      ClientBrandingSchema.safeParse({ reportContactLine: "x".repeat(201) }).success,
    ).toBe(false);
  });

  it("the staff schema is a strict SUPERSET", () => {
    const agencyOnly = {
      displayName: "Acme",
      brandColorAppliesToDashboard: false,
      clientEditable: true,
    };
    expect(StaffBrandingSchema.safeParse(agencyOnly).success).toBe(true);
    expect(ClientBrandingSchema.safeParse(agencyOnly).success).toBe(false);
    // …and staff are still bounded by the same unknown-key rule.
    expect(StaffBrandingSchema.safeParse({ nonsense: 1 }).success).toBe(false);
  });
});

describe("🔴 the database row proves the lock held", () => {
  let harness: { db: TestDb; close: () => Promise<void> };
  let store: typeof import("./branding-store");

  beforeAll(async () => {
    harness = await createTestDb();
    store = await import("./branding-store");
  });
  afterAll(async () => {
    await harness?.close();
  });

  const HOSTILE = { displayName: "Acme", clientEditable: true };

  async function editableFlag(): Promise<boolean> {
    const res = await harness.db.execute<{ client_editable: boolean }>(
      sql`SELECT client_editable FROM client_branding WHERE client_id = ${CLIENT_A}`,
    );
    return (res as { rows: Array<{ client_editable: boolean }> }).rows[0]
      .client_editable;
  }

  it("the SCHEMA is what stops it — proven by showing the staff schema does not", async () => {
    globalThis.__brandingHarnessDb = harness.db;
    await harness.db.execute(
      sql`INSERT INTO client_branding (client_id, client_editable) VALUES (${CLIENT_A}, false)`,
    );
    expect(await editableFlag()).toBe(false);

    /*
     * Be precise about where the defence lives. `saveClientBranding` writes any
     * named key it is handed, INCLUDING `clientEditable` — it has to, because
     * the staff endpoint sets it. So the writer is not a second line of defence
     * and this test does not pretend it is.
     *
     * What holds the line is that `clientEditable` never survives the client
     * schema, so it is never in the object the route spreads. Demonstrated by
     * running the identical hostile payload through both schemas.
     */

    // Client path: rejected outright, so the route 400s and nothing is written.
    expect(ClientBrandingSchema.safeParse(HOSTILE).success).toBe(false);
    expect(await editableFlag()).toBe(false);

    // Staff path: the same payload parses, and DOES flip the column. This is
    // the control — without it, the assertion above could pass because the
    // writer ignores the field rather than because the schema stopped it.
    const asStaff = StaffBrandingSchema.safeParse(HOSTILE);
    expect(asStaff.success).toBe(true);
    if (asStaff.success) await store.saveClientBranding(CLIENT_A, asStaff.data);
    expect(await editableFlag()).toBe(true);
  });

  it("a well-formed client write leaves the flag untouched", async () => {
    globalThis.__brandingHarnessDb = harness.db;
    // Flag is `true` from the previous test. A normal client save must not
    // disturb it in either direction.
    const parsed = ClientBrandingSchema.safeParse({
      displayName: "Acme Aesthetics",
      brandColor: "#2aa9b8",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) await store.saveClientBranding(CLIENT_A, parsed.data);

    expect(await editableFlag()).toBe(true);
    const res = await harness.db.execute<{ display_name: string }>(
      sql`SELECT display_name FROM client_branding WHERE client_id = ${CLIENT_A}`,
    );
    expect(
      (res as { rows: Array<{ display_name: string }> }).rows[0].display_name,
    ).toBe("Acme Aesthetics");
  });
});

describe("logo uploads", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);

  function form(file: File | string | null): FormData {
    const f = new FormData();
    if (file !== null) f.set("logo", file);
    return f;
  }

  it("accepts a real PNG", async () => {
    const file = new File([png], "logo.png", { type: "image/png" });
    const result = await readLogoUpload(form(file));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.logo?.contentType).toBe("image/png");
  });

  it("treats an empty value as 'remove the logo'", async () => {
    // Must stay possible — a client who rebrands should not be stuck with the
    // old mark.
    const result = await readLogoUpload(form(""));
    expect(result).toEqual({ ok: true, logo: null });
  });

  it("🔴 rejects a file whose bytes contradict its declared type", async () => {
    /*
     * `file.type` is attacker-supplied. These bytes are served back to a
     * browser inline, so trusting the declared type is how "an image" ends up
     * being served as something else.
     */
    const notPng = new File([Buffer.from("<script>alert(1)</script>xxxxxx")], "x.png", {
      type: "image/png",
    });
    const result = await readLogoUpload(form(notPng));
    expect(result.ok).toBe(false);
  });

  it("🔴 rejects SVG outright, whatever it claims", async () => {
    // An SVG is a document that can carry script.
    const svg = new File([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')], "l.svg", {
      type: "image/svg+xml",
    });
    expect((await readLogoUpload(form(svg))).ok).toBe(false);

    // …and re-labelled as PNG it fails the byte check instead.
    const disguised = new File(
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')],
      "l.png",
      { type: "image/png" },
    );
    expect((await readLogoUpload(form(disguised))).ok).toBe(false);
  });

  it("rejects anything over the size ceiling", async () => {
    const big = new File([Buffer.alloc(MAX_LOGO_BYTES + 1)], "big.png", {
      type: "image/png",
    });
    const result = await readLogoUpload(form(big));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/limit/i);
  });

  it("sniffs the three allowed formats and nothing else", () => {
    expect(sniffImageType(png)).toBe("image/png");
    expect(
      sniffImageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)])),
    ).toBe("image/jpeg");
    const webp = Buffer.alloc(16);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    expect(sniffImageType(webp)).toBe("image/webp");

    expect(sniffImageType(Buffer.from("GIF89a______"))).toBeNull();
    expect(sniffImageType(Buffer.from("%PDF-1.4____"))).toBeNull();
    expect(sniffImageType(Buffer.alloc(4))).toBeNull();
  });
});

declare global {
  var __brandingHarnessDb: TestDb | undefined;
}
