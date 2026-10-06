import net from "node:net";

import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { Pool as PgPool } from "pg";
import * as schema from "./schema";

/**
 * Database connection — works with Neon, Supabase, or any plain Postgres.
 *
 * The driver is chosen from the connection string rather than configured, so
 * switching providers is only ever an env var change:
 *
 *   *.neon.tech          → @neondatabase/serverless (WebSocket driver)
 *   supabase / anything  → node-postgres
 *
 * Both give real transactions, which the webhook receiver requires — contact
 * upsert, opportunity upsert, and the stage-transition append must land
 * atomically or not at all.
 *
 * NOTE for Supabase: use the POOLER connection string (port 6543), not the
 * direct one (5432). Serverless functions open a connection per invocation and
 * will exhaust the direct connection limit under webhook load.
 */

/*
 * Node's happy-eyeballs (`autoSelectFamily`, on by default since Node 20) gives
 * each resolved address only 250ms to connect. A managed Postgres endpoint
 * resolves to six addresses and its TLS handshake takes ~2.7s from outside the
 * provider's own region, so every address blows the budget in turn: a pool
 * warming ten connections stalls for ~22s, and once the address list is
 * exhausted the query dies with `AggregateError [ETIMEDOUT]` — which surfaces
 * as "Failed query" on a page that opens several connections at once.
 *
 * Raising the per-attempt budget fixes both drivers, since the WebSocket
 * transport dials through the same socket path. Happy-eyeballs itself stays on,
 * so IPv6-to-IPv4 fallback still works; it just gets a realistic deadline.
 * Only ever raised, never lowered, so an explicit larger value is left alone.
 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;
if (net.getDefaultAutoSelectFamilyAttemptTimeout() < CONNECT_ATTEMPT_TIMEOUT_MS) {
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}

const globalForDb = globalThis as unknown as {
  db: ReturnType<typeof createDb> | undefined;
};

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
    );
  }

  const isNeon = /\.neon\.tech/i.test(url);

  if (isNeon) {
    return drizzleNeon(new NeonPool({ connectionString: url }), { schema });
  }

  return drizzlePg(
    new PgPool({
      connectionString: url,
      // Managed Postgres (Supabase, RDS, etc.) terminates TLS with a cert chain
      // Node does not ship a root for. The connection is still encrypted.
      ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 10,
    }),
    { schema },
  );
}

export const db = globalForDb.db ?? createDb();
if (process.env.NODE_ENV !== "production") globalForDb.db = db;

export { schema };
export type Database = typeof db;
