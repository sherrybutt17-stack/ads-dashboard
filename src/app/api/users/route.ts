import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { createUser, listUsersForAgency } from "@/lib/users";
import { assignableRoles } from "@/lib/roles";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Their own agency's team, not the platform's.
  return NextResponse.json({
    users: await listUsersForAgency(session!.agencyId),
  });
}

const CreateSchema = z.object({
  email: z.string().trim().email(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200),
  // Validated as a shape here; whether the CALLER may hand it out is decided
  // below against `assignableRoles`, which the request body cannot influence.
  role: z.enum(["superadmin", "agency", "staff", "client"]),
  name: z.string().trim().max(120).optional(),
  clientIds: z.array(z.string().uuid()).optional(),
});

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
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
    /*
     * 🔴 Roles are handed out strictly downward.
     *
     * Without this an `agency` operator could POST `role: "staff"` and mint an
     * account that reads every tenant in the database — a one-request escape
     * from their own tenancy, through the ordinary "add a teammate" form. The
     * check is against the caller's role from `getSessionUser` (re-read from
     * the database), never against anything in the body.
     */
    if (!assignableRoles(session!.role).includes(parsed.data.role)) {
      return NextResponse.json(
        { error: "You cannot create a user with that role." },
        { status: 403 },
      );
    }

    const user = await createUser({
      // Same rule as client creation: the tenant comes from the caller's
      // session, so nobody can plant a login inside another agency.
      agencyId: session!.agencyId,
      email: parsed.data.email,
      password: parsed.data.password,
      role: parsed.data.role,
      name: parsed.data.name,
      clientIds:
        parsed.data.role === "client" ? (parsed.data.clientIds ?? []) : [],
    });
    void audit.record({
      action: "user.create",
      targetType: "user",
      targetId: user.id,
      // A teammate change names no client, so the tenant comes from the
      // session — the same one the user was just created inside.
      agencyId: session!.agencyId,
      metadata: {
        email: user.email,
        role: user.role,
        clients:
          parsed.data.role === "client"
            ? (parsed.data.clientIds ?? []).length
            : "all",
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
