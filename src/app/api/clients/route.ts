import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createClient,
  listClientsForSession,
  webhookUrlFor,
} from "@/lib/clients";
import { listAdAccounts } from "@/lib/meta/accounts";
import { quickHealth } from "@/lib/health";
import { isValidTimeZone } from "@/lib/dates";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { assertLocationIdAvailable } from "@/lib/ghl/oauth";
import * as audit from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  // Validate against a real IANA zone: an invalid value later crashes every
  // render path that feeds it to Intl / Postgres `AT TIME ZONE`.
  timezone: z
    .string()
    .default("America/Los_Angeles")
    .refine(isValidTimeZone, "Invalid IANA timezone"),
  ghlLocationId: z.string().trim().optional(),
  ghlToken: z.string().trim().optional(),
});

export async function GET() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await listClientsForSession(session);
  const withHealth = await Promise.all(
    rows.map(async (c) => {
      const accounts = await listAdAccounts(c.id);
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        timezone: c.timezone,
        status: c.status,
        adAccountCount: accounts.length,
        primaryAccountName:
          accounts.find((a) => a.isPrimary)?.accountName ??
          accounts[0]?.accountName ??
          null,
        ghlLocationName: c.ghlLocationName,
        // Deliberately NOT webhookUrl. `clients.webhookToken` doubles as the GHL
        // shared secret, so anyone holding it can forge lead and stage-transition
        // events into the append-only ledger. Nothing renders it from here; the
        // per-client GET returns it for the setup page that actually needs it.
        firstWebhookAt: c.firstWebhookAt,
        lastWebhookAt: c.lastWebhookAt,
        lastSyncedAt: c.lastSyncedAt,
        health: await quickHealth(c),
      };
    }),
  );
  return NextResponse.json({ clients: withHealth });
}

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    /*
     * The tenant comes from the SESSION, never from `parsed.data`. The request
     * body is caller input, and a body that could name its own agency would let
     * anyone file a client under someone else's — a write across the tenant
     * boundary, from the one endpoint whose whole job is creating rows.
     */
    // A typed location id must not name another tenant's live install.
    if (parsed.data.ghlLocationId) {
      await assertLocationIdAvailable(
        session!.agencyId,
        parsed.data.ghlLocationId,
      );
    }
    const client = await createClient({
      ...parsed.data,
      agencyId: session!.agencyId,
    });
    void audit.record({
      action: "client.create",
      targetType: "client",
      targetId: client.id,
      clientId: client.id,
      metadata: { name: client.name, slug: client.slug },
      ...audit.requestContext(req),
    });
    return NextResponse.json(
      {
        client: {
          id: client.id,
          name: client.name,
          slug: client.slug,
          webhookUrl: webhookUrlFor(client),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create client" },
      { status: 500 },
    );
  }
}
