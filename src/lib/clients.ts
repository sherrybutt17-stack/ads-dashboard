import { customAlphabet } from "nanoid";
import { and, eq, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { clients, pipelineStages, type Client } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { sessionMaySeeClient, type UnscopedReason } from "@/lib/client-scope";
import { clientScopeFilter } from "@/lib/client-scope-sql";
import type { SessionPayload } from "@/lib/session";
import { GhlClient, flattenStages } from "@/lib/ghl/client";
import { appBaseUrlOr } from "@/lib/app-url";

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
  const base = appBaseUrlOr("http://localhost:3000");
  return `${base}/api/webhooks/crm/${client.webhookToken}`;
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
        /*
         * 🔴 Deliberately NULL. This used to persist a name-based guess.
         *
         * Nothing downstream can tell a guess from a mapping an operator
         * confirmed — there is no column for it — so the guess WAS the mapping:
         * the funnel counted it, `unmappedCanonical` came back empty, and the
         * "stage mapping complete" health check went green without a human
         * having looked. On the OAuth install path nobody is even at the
         * keyboard, so a client could be fully "mapped" by regex alone.
         *
         * It also silently outranked the better suggester: the wizard's fill
         * button skips any row that already has a value, so the operator was
         * shown this guess pre-selected as though it were settled.
         *
         * The suggestion still reaches them — `suggestCanonicalStage` runs in
         * the wizard, where accepting it is an action someone takes.
         */
        canonicalStage: null,
      });
    }
    count++;
  }
  return count;
}

export interface CreateClientInput {
  /**
   * The agency this client belongs to. Required, and taken from the caller's
   * session rather than from the request body — a client whose tenant is
   * supplied by whoever is asking is not scoped at all.
   */
  agencyId: string;
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
      agencyId: input.agencyId,
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

/* ------------------------------------------------------------------ *
 * Reading a client — scoped, and unscoped-but-named
 * ------------------------------------------------------------------ *
 *
 * 🔴 There is no `getClientById(id)` and no `listClients()`. That is the point.
 *
 * Before this, every one of the ~40 places that loads a client did so with no
 * tenant in the query, and safety came entirely from `staffGuard()` upstream —
 * which, in a world with one agency, is the same thing. In a world with two it
 * means any handler reachable with a guessed uuid reads across the boundary,
 * and the mistake is invisible: the call site looks exactly like a correct one.
 *
 * So the unscoped versions are DELETED rather than deprecated. The compiler now
 * refuses the unsafe call instead of a reviewer having to notice it. Where a
 * lookup legitimately has no session behind it — a webhook routed by its token,
 * a share link, a cron — `getClientUnscoped` takes a typed reason and is
 * allowlisted by `client-scope.test.ts`, so the escape hatch is a short list
 * somebody can read rather than the default.
 */

/** The client at `slug`, if this session may see it; null otherwise. */
export async function getClientForSession(
  session: SessionPayload | null,
  slug: string,
): Promise<Client | null> {
  return scoped(session, eq(clients.slug, slug));
}

/** The client at `id`, if this session may see it; null otherwise. */
export async function getClientByIdForSession(
  session: SessionPayload | null,
  id: string,
): Promise<Client | null> {
  return scoped(session, eq(clients.id, id));
}

async function scoped(
  session: SessionPayload | null,
  where: SQL | undefined,
): Promise<Client | null> {
  if (!session) return null;
  const [row] = await db
    .select()
    .from(clients)
    .where(and(where, clientScopeFilter(session)))
    .limit(1);
  if (!row) return null;
  /*
   * 🔴 One return value for "no such client" and for "not yours".
   *
   * A handler that could tell them apart is an existence oracle: walk uuids or
   * guess slugs, and a 403 says "real, someone else's" while a 404 says "not
   * real". Client slugs are guessable — they are derived from the business name
   * — so this would enumerate the platform's customer list. Callers get null
   * and answer 404 either way.
   */
  return sessionMaySeeClient(session, row) ? row : null;
}

/** Every client this session may see, alphabetically. */
export async function listClientsForSession(
  session: SessionPayload | null,
): Promise<Client[]> {
  if (!session) return [];
  const rows = await db
    .select()
    .from(clients)
    .where(clientScopeFilter(session))
    .orderBy(clients.name);
  // Still filtered in memory. See `clientScopeFilter` — the SQL narrows, this decides.
  return rows.filter((c) => sessionMaySeeClient(session, c));
}

/**
 * A client, with the tenant check deliberately skipped.
 *
 * `reason` is a closed union rather than a comment, so the set of paths that
 * bypass scoping can be enumerated by grep and is asserted as an allowlist by
 * `client-scope.test.ts`. It is unused at runtime — its whole job is to make
 * the bypass impossible to write absent-mindedly.
 */
export async function getClientUnscoped(
  id: string,
  reason: UnscopedReason,
): Promise<Client | null> {
  void reason;
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  return row ?? null;
}

/** As `getClientUnscoped`, by slug. */
export async function getClientBySlugUnscoped(
  slug: string,
  reason: UnscopedReason,
): Promise<Client | null> {
  void reason;
  const [row] = await db
    .select()
    .from(clients)
    .where(eq(clients.slug, slug))
    .limit(1);
  return row ?? null;
}

/** Every client, for jobs that run without a user. See `UnscopedReason`. */
export async function listClientsUnscoped(reason: UnscopedReason): Promise<Client[]> {
  void reason;
  return db.select().from(clients).orderBy(clients.name);
}
