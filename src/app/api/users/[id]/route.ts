import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setUserStatus, setUserClients, deleteUser } from "@/lib/users";
import { requireUser } from "@/lib/user-access";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * `requireUser` — the tenant check and the rank check in one call — lives in
 * `lib/user-access.ts`, shared with `./invite/route.ts`.
 */

/*
 * 🔴 No `password` field, deliberately.
 *
 * An operator used to type a password here and was shown "Share: x@y.com /
 * hunter2" to paste into a chat. That put a working password in a message
 * thread forever and meant the operator knew it for the life of the account.
 * A password is now only ever set by its owner, through a link —
 * `POST ./invite` mints one. `.strict()` so an old client still sending
 * `password` is told so, rather than seeing `ok` and believing it changed.
 */
const PatchSchema = z
  .object({
    status: z.enum(["active", "disabled"]).optional(),
    clientIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

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

  /*
   * Nobody disables their own login. It is the one change on this page that
   * cannot be undone from the page — the person who could undo it has just
   * been signed out — and for the last operator it locks the whole agency out.
   */
  if (d.status === "disabled" && user.id === got.session.userId) {
    return NextResponse.json(
      { error: "You can't disable your own login." },
      { status: 400 },
    );
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
    action: "user.update",
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

  // Same reasoning as disabling yourself, and it cannot be undone at all.
  if (user.id === got.session.userId) {
    return NextResponse.json(
      { error: "You can't remove your own login." },
      { status: 400 },
    );
  }

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
