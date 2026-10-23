import type { SessionPayload } from "@/lib/session";
import { isOperatorRole } from "@/lib/roles";

export type BoardVerdict =
  | { ok: true; staff: boolean }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Who may change a client's board — decided on the STORED row, before a byte
 * of the request is read, so a request cannot argue its way past the lock.
 *
 *  - no session: 401;
 *  - an agency operator: always (and only they may lock or unlock);
 *  - a client login: only their own client, and only while it is unlocked.
 *
 * The route still loads the client through `getClientForSession`, which is the
 * tenant check; this is the role check on top of it.
 */
export function authorizeBoardWrite(
  session: SessionPayload | null,
  slug: string,
  stored: { locked: boolean },
): BoardVerdict {
  if (!session) return { ok: false, status: 401, error: "Unauthorized" };
  if (isOperatorRole(session.role)) return { ok: true, staff: true };
  if (!session.slugs.includes(slug)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  if (stored.locked) {
    return {
      ok: false,
      status: 403,
      error:
        "Your agency has fixed this board. Ask them to unlock it if you would like to change it.",
    };
  }
  return { ok: true, staff: false };
}
