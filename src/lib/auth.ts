import "server-only";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  verifySessionToken,
  SESSION_COOKIE,
  type SessionPayload,
} from "@/lib/session";

/**
 * Server-side session reader for pages and route handlers (node runtime).
 *
 * The edge proxy already enforces coarse path access from the signed token
 * alone. This adds a defence-in-depth DB check: a real user must still exist and
 * be active, so disabling an account takes effect on their very next page load
 * rather than only when the 30-day token expires.
 */
export async function getSessionUser(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const payload = await verifySessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!payload) return null;

  // The shared-password bootstrap staff has no DB row.
  if (payload.userId === "shared") return payload;

  const [u] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);
  if (!u || u.status !== "active") return null;
  return payload;
}

export function isStaff(session: SessionPayload | null): boolean {
  return session?.role === "staff";
}

/** Staff may access any client; a client user only their granted slugs. */
export function canAccessSlug(
  session: SessionPayload | null,
  slug: string,
): boolean {
  if (!session) return false;
  return session.role === "staff" || session.slugs.includes(slug);
}
