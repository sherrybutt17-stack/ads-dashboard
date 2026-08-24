import { z } from "zod";
import type { SessionPayload } from "@/lib/session";
import { isOperatorRole } from "@/lib/roles";
import type { LayoutAudience } from "@/db/schema";

/**
 * The write path for dashboard layouts.
 *
 * Structurally the same problem as client-editable branding, and solved the
 * same way for the same reason: the permission that governs the write is stored
 * on the very row the write targets. Naively, a client frozen out by `locked`
 * can `PUT {"sections":[…],"locked":false}` and thaw themselves — the escape
 * hatch defeating itself, with nothing in the logs.
 *
 * Two mechanisms, deliberately independent:
 *
 *   1. The STORED `locked` value decides before any body is parsed.
 *   2. `ClientLayoutSchema` is `.strict()` and does not contain `locked` at all,
 *      so even an unlocked client cannot reach the switch.
 */

const EntrySchema = z
  .object({ id: z.string().max(64), visible: z.boolean() })
  .strict();

/** What a CLIENT may send: visibility, nothing else. */
export const ClientLayoutSchema = z
  .object({
    sections: z.array(EntrySchema).max(64),
    /**
     * The `updated_at` the caller last read, for optimistic concurrency.
     *
     * Staff and the client write the SAME row when staff are setting that
     * client's view — this is not a template-and-instance cascade — so a
     * simultaneous edit would otherwise silently clobber. Five lines turn that
     * into a visible 409.
     */
    ifUnmodifiedSince: z.string().datetime().optional(),
  })
  .strict();

/** What STAFF may send. A superset — the freeze switch. */
export const StaffLayoutSchema = ClientLayoutSchema.extend({
  locked: z.boolean().optional(),
}).strict();

export type ClientLayoutInput = z.infer<typeof ClientLayoutSchema>;

export type LayoutVerdict =
  | { ok: true; staff: boolean }
  | { ok: false; status: 401 | 403; error: string };

/**
 * May this session write this client's layout for this audience?
 *
 * 🔴 Runs on the STORED `locked` value, before the request body is read.
 *
 * Note the audience check, which is not just tidiness: a client-role user
 * writing the `staff` row would be editing what the agency sees on a page the
 * agency uses to check whether that client's pipes are healthy. Each audience
 * owns its own row; staff may write either.
 */
export function authorizeLayoutWrite(
  session: SessionPayload | null,
  slug: string,
  audience: LayoutAudience,
  stored: { locked: boolean },
): LayoutVerdict {
  if (!session) return { ok: false, status: 401, error: "Unauthorized" };

  /*
   * Every operator role, not just `staff`. This read `role === "staff"` when
   * `staff` was the only one, and an `agency` operator therefore fell through
   * to the slug check below — which they can never pass, because `auth.ts`
   * populates `slugs` for the `client` role alone. A flat 403 on their own
   * clients' layouts, indistinguishable from a permission doing its job.
   */
  if (isOperatorRole(session.role)) return { ok: true, staff: true };

  if (!session.slugs.includes(slug)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  if (audience !== "client") {
    return {
      ok: false,
      status: 403,
      error: "Forbidden",
    };
  }

  if (stored.locked) {
    return {
      ok: false,
      status: 403,
      error:
        "Your agency has fixed the layout of this dashboard. Ask them to unlock it if you would like to change it.",
    };
  }

  return { ok: true, staff: false };
}

/**
 * Which audience's row a session reads and writes by default.
 *
 * Staff see their own; a client sees theirs. Staff editing a CLIENT's view pass
 * the audience explicitly — that is the case the 409 exists for.
 */
export function defaultAudience(session: SessionPayload | null): LayoutAudience {
  // Any operator reads their OWN view by default. An agency operator landing on
  // the client audience would be shown — and would edit — the layout their
  // client sees, on the page they use to check that client's pipes.
  return isOperatorRole(session?.role) ? "staff" : "client";
}

/** Reject an audience string that came off a URL. */
export function parseAudience(value: unknown): LayoutAudience | null {
  return value === "staff" || value === "client" ? value : null;
}
