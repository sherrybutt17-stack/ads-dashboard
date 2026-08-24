import { z } from "zod";
import type { SessionPayload } from "@/lib/session";
import { isOperatorRole } from "@/lib/roles";
import type { ClientBranding } from "@/lib/branding";

/**
 * The write path for branding, shared by the staff endpoint and the client one.
 *
 * It lives here rather than in either route because the two endpoints differ in
 * exactly one respect — WHICH FIELDS they may write — and everything else about
 * them must be identical. Two hand-maintained copies of image sniffing and size
 * limits is how one of them quietly starts accepting SVG.
 *
 * ── The field split ────────────────────────────────────────────────────
 *
 * Client-editable: `displayName`, `brandColor`, `reportContactLine`, and the
 * logo. These are the client's own end-brand, on their own document.
 *
 * Agency-only: `brandColorAppliesToDashboard` (a brand red on a dashboard whose
 * status colours are red/amber/green is a legibility problem, not a preference)
 * and `clientEditable` itself.
 *
 * 🔴 The split is enforced by two SEPARATE `.strict()` schemas, not by one
 * schema plus a filter. A filter that silently drops a forbidden key leaves the
 * caller believing the write succeeded as sent; strict parsing rejects it. And
 * because `saveClientBranding` writes only the keys it is explicitly given, a
 * value that never survives parsing can never reach a column.
 */

/** Formats a browser renders inline and that cannot execute script. */
export const ALLOWED_LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/**
 * 512 KB. A wordmark that exceeds this is a mis-exported asset, not a logo —
 * and the bytes travel out of Postgres on every cache miss, and are inlined
 * base64 into every report.
 */
export const MAX_LOGO_BYTES = 512 * 1024;

/** What a CLIENT may write about their own brand. */
export const ClientBrandingSchema = z
  .object({
    displayName: z.string().max(120).nullable().optional(),
    brandColor: z.string().max(9).nullable().optional(),
    reportContactLine: z.string().max(200).nullable().optional(),
  })
  .strict();

/** What STAFF may write. A superset — the two agency-owned switches. */
export const StaffBrandingSchema = ClientBrandingSchema.extend({
  brandColorAppliesToDashboard: z.boolean().optional(),
  clientEditable: z.boolean().optional(),
}).strict();

export type ClientBrandingInput = z.infer<typeof ClientBrandingSchema>;

/* ------------------------------------------------------------------ *
 * Authorization — one named decision, not a sequence of ifs
 * ------------------------------------------------------------------ */

export type WriteVerdict =
  | { ok: true; staff: boolean }
  | { ok: false; status: 401 | 403; error: string };

/**
 * May this session write this client's branding through the CLIENT endpoint?
 *
 * Extracted as a pure function so the decision can be tested exhaustively
 * without standing up a request. Route handlers are the worst place to keep an
 * authorization rule: they are the hardest thing in the codebase to call from a
 * test, so in practice the rule ends up covered by nothing.
 *
 * 🔴 **The `clientEditable` check happens HERE, before any body is parsed.**
 * That ordering is the whole defence. A locked-out client who can get as far as
 * parsing can send `{"displayName":"x","clientEditable":true}` and unlock
 * themselves — the escape hatch defeating itself. Deciding on the STORED value
 * first means the body never gets a vote on whether the body is allowed.
 *
 * Staff pass regardless: the switch exists to restrain the client, not the
 * agency, and staff already hold the id-scoped endpoint.
 */
export function authorizeClientBrandingWrite(
  session: SessionPayload | null,
  slug: string,
  branding: Pick<ClientBranding, "clientEditable">,
): WriteVerdict {
  if (!session) return { ok: false, status: 401, error: "Unauthorized" };

  // Every operator role — see the note on `isOperatorRole`. Checking for
  // `staff` alone locked agency operators out of their own clients' branding.
  if (isOperatorRole(session.role)) return { ok: true, staff: true };

  if (!session.slugs.includes(slug)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  if (!branding.clientEditable) {
    return {
      ok: false,
      status: 403,
      // Named rather than a bare 403: the client is not doing anything wrong,
      // and "ask your agency" is the actual next step.
      error:
        "Branding for this account is managed by your agency. Ask them to enable editing.",
    };
  }

  return { ok: true, staff: false };
}

/**
 * What to say when the branding WRITE itself fails.
 *
 * Reads are already forgiving — `getClientBranding` catches and falls back to
 * `NO_BRANDING`, so an unmigrated database degrades to "no branding" rather than
 * taking a dashboard down. Writes cannot degrade: there is no sensible fallback
 * for "save this", and silently succeeding would be worse than failing.
 *
 * So they fail loudly, but with the actual likely cause named. A bare 500 in a
 * settings dialog tells the operator nothing, and by far the most probable
 * reason a branding write throws is that migration 0013 has not been applied to
 * this deployment — which is specific, checkable, and fixable in a minute.
 */
export const BRANDING_WRITE_FAILED =
  "Could not save. If branding has never worked on this deployment, the database migration for it has not been applied yet.";

/* ------------------------------------------------------------------ *
 * Logo bytes
 * ------------------------------------------------------------------ */

export type LogoResult =
  | { ok: true; logo: { bytes: Buffer; contentType: string } | null }
  | { ok: false; error: string };

/**
 * Validate an uploaded logo, or a request to remove one.
 *
 * Returns `logo: null` for removal, which must stay possible — a client who
 * rebrands should not be stuck with the old mark.
 */
export async function readLogoUpload(form: FormData | null): Promise<LogoResult> {
  const file = form?.get("logo");

  if (file === null || file === "" || file === undefined) {
    return { ok: true, logo: null };
  }
  if (!(file instanceof File)) {
    return { ok: false, error: "Expected a file" };
  }
  if (!ALLOWED_LOGO_TYPES.has(file.type)) {
    return {
      ok: false,
      error: `Unsupported image type "${file.type || "unknown"}". Use PNG, JPEG or WebP.`,
    };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return {
      ok: false,
      error: `Logo is ${Math.round(file.size / 1024)} KB; the limit is ${MAX_LOGO_BYTES / 1024} KB.`,
    };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  /*
   * Verify the BYTES, not the declared type. `file.type` is attacker-supplied,
   * and a route that serves uploaded bytes back with a Content-Type taken on
   * trust is how an "image" ends up being served as something else.
   */
  const sniffed = sniffImageType(bytes);
  if (!sniffed || sniffed !== file.type) {
    return {
      ok: false,
      error: "That file does not look like the image type it claims to be.",
    };
  }

  return { ok: true, logo: { bytes, contentType: sniffed } };
}

/**
 * Identify an image from its magic bytes.
 *
 * SVG is deliberately absent: an SVG is a document that can carry script, and
 * these bytes are served back to a browser with `Content-Disposition: inline`.
 * That is what makes it dangerous rather than merely untidy.
 */
export function sniffImageType(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
