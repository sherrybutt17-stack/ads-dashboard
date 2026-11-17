import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isSuperadmin, requireClient } from "@/lib/auth";
import { requestContext } from "@/lib/audit";
import { getClientByIdForSession } from "@/lib/clients";
import {
  ShareError,
  linkClient,
  previewLink,
  purgeFormerMember,
  stopSharing,
} from "@/lib/ghl/share-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sharing copies a whole sub-account; stopping deletes a client's copy of it.
export const maxDuration = 300;

/**
 * "Share this sub-account" — the Growth Guild half: add a client to the
 * sub-account the page's client holds (POST, or a preview with
 * `{ preview: true }`), stop sharing with one (DELETE `{ memberId }`), or remove
 * the copied leads a former member still holds (DELETE `{ purge: true }` on
 * that client).
 *
 * Superadmin only (decision 1 of the share design): adding a client copies one
 * business's lead names and phone numbers into another client. Never named
 * `share` — share links already use that path.
 */

const FORBIDDEN = "Only Growth Guild can add or remove clients on a shared sub-account.";

const RulesSchema = z.object({
  clients: z
    .array(
      z.object({
        clientId: z.guid(),
        tags: z.array(z.string().trim().max(200)).max(50),
      }),
    )
    .max(5),
  untagged: z.guid().nullable(),
  keepRemoved: z.boolean(),
});

const PostSchema = z.object({
  targetId: z.guid(),
  rules: RulesSchema,
  preview: z.boolean().optional(),
});

function refused(err: unknown) {
  if (err instanceof ShareError) return NextResponse.json({ error: err.message }, { status: err.status });
  throw err;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;
  if (!isSuperadmin(session)) return NextResponse.json({ error: FORBIDDEN }, { status: 403 });

  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const target = await getClientByIdForSession(session, parsed.data.targetId);
  if (!target) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  try {
    if (parsed.data.preview) {
      return NextResponse.json({ ok: true, preview: await previewLink(client.id, target.id, parsed.data.rules) });
    }
    const done = await linkClient(client.id, target.id, parsed.data.rules, {
      userId: session.userId,
      ...requestContext(req),
    });
    return NextResponse.json({ ok: true, ...done });
  } catch (err) {
    return refused(err);
  }
}

const DeleteSchema = z.union([
  z.object({ memberId: z.guid() }),
  z.object({ purge: z.literal(true) }),
]);

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;
  if (!isSuperadmin(session)) return NextResponse.json({ error: FORBIDDEN }, { status: 403 });

  const parsed = DeleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const actor = { userId: session.userId, ...requestContext(req) };
  try {
    if ("purge" in parsed.data) {
      return NextResponse.json({ ok: true, ...(await purgeFormerMember(client.id, actor)) });
    }
    const member = await getClientByIdForSession(session, parsed.data.memberId);
    if (!member) return NextResponse.json({ error: "Client not found" }, { status: 404 });
    return NextResponse.json({ ok: true, ...(await stopSharing(member.id, actor)) });
  } catch (err) {
    return refused(err);
  }
}
