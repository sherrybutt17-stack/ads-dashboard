import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireClient } from "@/lib/auth";
import { requestContext } from "@/lib/audit";
import { getClientByIdForSession } from "@/lib/clients";
import { db } from "@/db";
import type { SessionPayload } from "@/lib/session";
import { loadShareForClient, shareClients } from "@/lib/ghl/share";
import { ShareError, previewTags, resplitShare, saveShareTags } from "@/lib/ghl/share-actions";
import { loadSharePanel } from "@/lib/ghl/share-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tag save re-splits every person in the sub-account.
export const maxDuration = 300;

/**
 * "Share this sub-account" — the agency half (decision 1 of the share design):
 * the agency's own logins, and Growth Guild, read the panel (GET), preview a
 * tag change (POST), save it (PUT, with the version they read) and re-split
 * now (PATCH). Adding or removing clients is the superadmin route next door.
 *
 * Every client in the share must be one this login may see — a tag change
 * moves leads between all of them.
 */

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

/** Null when the login may see every client in the share; a response refusing it otherwise. */
async function mayEditShare(clientId: string, session: SessionPayload): Promise<NextResponse | null> {
  const share = await loadShareForClient(db, clientId);
  if (!share) {
    return NextResponse.json({ error: "This client doesn't share a GoHighLevel sub-account." }, { status: 404 });
  }
  for (const c of shareClients(share)) {
    if (!(await getClientByIdForSession(session, c.id))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
  return null;
}

function refused(err: unknown) {
  if (err instanceof ShareError) return NextResponse.json({ error: err.message }, { status: err.status });
  throw err;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  return NextResponse.json(await loadSharePanel(got.client, got.session));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;
  const denied = await mayEditShare(client.id, session);
  if (denied) return denied;
  const parsed = z.object({ rules: RulesSchema }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, preview: await previewTags(client.id, parsed.data.rules) });
  } catch (err) {
    return refused(err);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;
  const denied = await mayEditShare(client.id, session);
  if (denied) return denied;
  const parsed = z
    .object({ rules: RulesSchema, version: z.number().int() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const saved = await saveShareTags(client.id, parsed.data.rules, parsed.data.version, {
      userId: session.userId,
      ...requestContext(req),
    });
    return NextResponse.json({ ok: true, ...saved });
  } catch (err) {
    return refused(err);
  }
}

export async function PATCH(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const got = await requireClient(id);
  if ("denied" in got) return got.denied;
  const { client, session } = got;
  const denied = await mayEditShare(client.id, session);
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, ...(await resplitShare(client.id)) });
  } catch (err) {
    return refused(err);
  }
}
