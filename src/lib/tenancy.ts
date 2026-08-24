import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";

/**
 * Tenant resolution — the small, boring queries every scoped check needs.
 *
 * It stays small on purpose. The scoped accessors themselves ended up next to
 * the tables they read — `getClientForSession` and friends in `clients.ts` —
 * because an accessor that returns a `Client` belongs with the other client
 * queries. What lives here is the part that had no home: the lookup a caller
 * needs when it holds an id and must ask whose it is before acting on it.
 *
 * Nothing here is an authorization decision. These functions answer "whose is
 * this row" so a caller can compare; they never decide whether the caller is
 * allowed to ask.
 */

/**
 * Which agency owns a client, or null if there is no such client.
 *
 * Null is a real answer and callers must handle it — a caller that treats a
 * missing client as "no tenant" and proceeds is exactly the shape of an IDOR.
 */
export async function agencyIdForClient(clientId: string): Promise<string | null> {
  const [row] = await db
    .select({ agencyId: clients.agencyId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  return row?.agencyId ?? null;
}
