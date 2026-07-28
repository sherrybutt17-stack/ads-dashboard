import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import {
  setUserPassword,
  setUserStatus,
  setUserClients,
  deleteUser,
  getUserById,
} from "@/lib/users";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function staffOnly(): Promise<boolean> {
  return isStaff(await getSessionUser());
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
  if (!(await staffOnly())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
    metadata: { email: user.email, changed },
    ...audit.requestContext(req),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!(await staffOnly())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await deleteUser(id);
  void audit.record({
    action: "user.delete",
    targetType: "user",
    targetId: id,
    metadata: { email: user.email },
    ...audit.requestContext(req),
  });
  return NextResponse.json({ ok: true });
}
