import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, listClients, webhookUrlFor } from "@/lib/clients";
import { listAdAccounts } from "@/lib/meta/accounts";
import { quickHealth } from "@/lib/health";
import { isValidTimeZone } from "@/lib/dates";
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
  const rows = await listClients();
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
        webhookUrl: webhookUrlFor(c),
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
  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const client = await createClient(parsed.data);
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
