import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import type { SessionPayload } from "@/lib/session";
import type { User } from "@/db/schema";
import {
  setUserPassword,
  setUserStatus,
  setUserClients,
  deleteUser,
  getUserInAgency,
} from "@/lib/users";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The user at `id`, if the caller may administer them.
 *
 * 🔴 Both handlers here did `staffOnly()` then `getUserById(id)` — an IDOR on
 * a guessed uuid that could reset another agency's admin password, disable
 * their account, or delete it outright. The role check said the caller was
 * somebody; nothing said the user was theirs.
 *
 * Returns a discriminated result rather than throwing, so neither handler can
 * perform half of it.
 */
async function requireUser(
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
  return { target, session: session! };
}

const PatchSchema = z.object({
  password: z.string().min(8).max(200).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  clientIds: z.array(z.string().uuid()).optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireUser(id);
  if ("denied" in got) return got.denied;
  const user = got.target;

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const d = parsed.data;
  const changed: string[] = [];

  if (d.password) {
    await setUserPassword(id, d.password);
    changed.push("password");
  }
  if (d.status) {
    await setUserStatus(id, d.status);
    changed.push(`status=${d.status}`);
  }
  if (d.clientIds) {
    await setUserClients(id, d.clientIds);
    changed.push("clients");
  }

  void audit.record({
    action: d.password ? "user.password_reset" : "user.update",
    targetType: "user",
    targetId: id,
    // The target's agency, not the caller's: a superadmin acting on an
    // agency's user files the entry under that agency, where it is relevant.
    agencyId: user.agencyId,
    metadata: { email: user.email, changed },
    ...audit.requestContext(req),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const got = await requireUser(id);
  if ("denied" in got) return got.denied;
  const user = got.target;

  await deleteUser(id);
  void audit.record({
    action: "user.delete",
    targetType: "user",
    targetId: id,
    agencyId: user.agencyId,
    metadata: { email: user.email },
    ...audit.requestContext(req),
  });
  return NextResponse.json({ ok: true });
}
