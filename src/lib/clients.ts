import { customAlphabet } from "nanoid";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, pipelineStages, type Client } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { GhlClient, flattenStages, guessCanonicalStage } from "@/lib/ghl/client";

/** URL-safe, unambiguous alphabet — no look-alike characters. */
const tokenId = customAlphabet(
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  32,
);

export function generateWebhookToken(): string {
  return tokenId();
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || "client";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [existing] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.slug, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  return `${root}-${tokenId().slice(0, 6).toLowerCase()}`;
}

export function webhookUrlFor(client: Pick<Client, "webhookToken">): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    "http://localhost:3000";
  return `${base}/api/webhooks/ghl/${client.webhookToken}`;
}

/**
 * Verify a GHL token before storing it.
 *
 * Proves the token is valid AND that it can reach this specific location. A
 * token that merely parses tells you nothing — the common failure is a PIT
 * generated against the wrong sub-account, which fails silently forever.
 */
export async function verifyGhl(token: string, locationId: string) {
  const ghl = new GhlClient(token);
  const location = await ghl.getLocation(locationId);
  return {
    ok: true as const,
    locationName: location.name ?? null,
    timezone: location.timezone ?? null,
  };
}

/**
 * Import this client's pipelines from GHL into `pipeline_stages`.
 *
 * Canonical mapping is only ever GUESSED here to pre-select dropdowns; the
 * operator confirms every one. A silently wrong auto-map would corrupt the
 * funnel in a way that is very hard to notice — the numbers would look
 * plausible and simply be attributed to the wrong stage.
 *
 * Existing mappings are preserved on re-import.
 */
export async function importPipelineStages(client: Client): Promise<number> {
  if (!client.ghlLocationId) {
    throw new Error("Client has no GHL location configured");
  }
  // Resolves an OAuth install token when present, else the PIT.
  const { getGhlClientAsync } = await import("@/lib/ghl/process");
  const ghl = await getGhlClientAsync(client);
  if (!ghl) throw new Error("Client has no usable GHL credential");

  const pipelines = await ghl.getPipelines(client.ghlLocationId);
  const stages = flattenStages(pipelines);

  let count = 0;
  for (const s of stages) {
    const [existing] = await db
      .select()
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.clientId, client.id),
          eq(pipelineStages.ghlStageId, s.stageId),
        ),
      )
      .limit(1);

    if (existing) {
      // Refresh names/order, but never overwrite a confirmed mapping.
      await db
        .update(pipelineStages)
        .set({
          ghlStageName: s.stageName,
          ghlPipelineName: s.pipelineName,
          ghlPipelineId: s.pipelineId,
          displayOrder: s.position,
          discoveredFromWebhook: false,
          updatedAt: new Date(),
        })
        .where(eq(pipelineStages.id, existing.id));
    } else {
      await db.insert(pipelineStages).values({
        clientId: client.id,
        ghlPipelineId: s.pipelineId,
        ghlPipelineName: s.pipelineName,
        ghlStageId: s.stageId,
        ghlStageName: s.stageName,
        displayOrder: s.position,
        // Suggestion only — surfaced as a pre-selected dropdown, not applied.
        canonicalStage: guessCanonicalStage(s.stageName) as never,
      });
    }
    count++;
  }
  return count;
}

export interface CreateClientInput {
  name: string;
  timezone: string;
  ghlLocationId?: string;
  ghlToken?: string;
}

export async function createClient(input: CreateClientInput): Promise<Client> {
  const slug = await uniqueSlug(input.name);
  const [row] = await db
    .insert(clients)
    .values({
      name: input.name,
      slug,
      timezone: input.timezone,
      ghlLocationId: input.ghlLocationId ?? null,
      ghlTokenEncrypted: input.ghlToken ? encrypt(input.ghlToken) : null,
      webhookToken: generateWebhookToken(),
    })
    .returning();
  return row;
}

export async function getClientBySlug(slug: string): Promise<Client | null> {
  const [row] = await db
    .select()
    .from(clients)
    .where(eq(clients.slug, slug))
    .limit(1);
  return row ?? null;
}

export async function getClientById(id: string): Promise<Client | null> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  return row ?? null;
}

export async function listClients(): Promise<Client[]> {
  return db.select().from(clients).orderBy(clients.name);
}
