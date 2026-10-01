import { NextResponse } from "next/server";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import type { SessionPayload } from "@/lib/session";
import type { User } from "@/db/schema";
import { getUserInAgency } from "@/lib/users";
import { mayAdminister } from "@/lib/roles";

/**
 * The user at `id`, if the caller may administer them.
 *
 * 🔴 Both `/api/users/[id]` handlers did `staffOnly()` then `getUserById(id)` —
 * an IDOR on a guessed uuid that could reset another agency's admin password,
 * disable their account, or delete it outright. The role check said the caller
 * was somebody; nothing said the user was theirs.
 *
 * 🔴 And "theirs" is not enough on its own. Being in the same agency let an
 * `agency` operator manage the `superadmin` beside them — set its password and
 * sign in as it. `mayAdminister` applies the same downward rule that creation
 * does; see the note on it in `roles.ts`.
 *
 * Shared by every route that acts on one login, so none of them can do the
 * tenant half without the rank half. Returns a discriminated result rather
 * than throwing, so no handler can perform half of it.
 */
export async function requireUser(
  id: string,
): Promise<
  { target: User; session: SessionPayload } | { denied: NextResponse }
> {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return {
      denied: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  }
  const target = await getUserInAgency(session!.agencyId, id);
  // One answer for "no such user" and "not yours" — see `getUserInAgency`.
  if (!target) {
    return {
      denied: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  if (!mayAdminister(session!.role, target.role)) {
    /*
     * 403, not 404: the login is on this operator's own Users page, so its
     * existence is no secret. What they lack is the rank to manage it.
     */
    return {
      denied: NextResponse.json(
        { error: `You can't manage a ${target.role} login.` },
        { status: 403 },
      ),
    };
  }
  return { target, session: session! };
}
