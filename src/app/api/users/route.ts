import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { createUser, listUsers } from "@/lib/users";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function staffOnly(): Promise<boolean> {
  return isStaff(await getSessionUser());
}

export async function GET() {
  if (!(await staffOnly())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ users: await listUsers() });
}

const CreateSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  role: z.enum(["staff", "client"]),
  name: z.string().trim().max(120).optional(),
  clientIds: z.array(z.string().uuid()).optional(),
});

export async function POST(req: NextRequest) {
  if (!(await staffOnly())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const user = await createUser({
      email: parsed.data.email,
      password: parsed.data.password,
      role: parsed.data.role,
      name: parsed.data.name,
      clientIds: parsed.data.role === "client" ? (parsed.data.clientIds ?? []) : [],
    });
    void audit.record({
      action: "user.create",
      targetType: "user",
      targetId: user.id,
      metadata: {
        email: user.email,
        role: user.role,
        clients: parsed.data.role === "client" ? (parsed.data.clientIds ?? []).length : "all",
      },
      ...audit.requestContext(req),
    });
    return NextResponse.json(
      { ok: true, user: { id: user.id, email: user.email, role: user.role } },
      { status: 201 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed";
    const dup = /unique|duplicate/i.test(msg);
    return NextResponse.json(
      {
        ok: false,
        error: dup
          ? "A user with that email already exists."
          : "Failed to create user",
      },
      { status: dup ? 409 : 500 },
    );
  }
}
