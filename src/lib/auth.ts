import "server-only";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { allowedSlugsForUser } from "@/lib/users";
import {
  verifySessionToken,
  SESSION_COOKIE,
  type SessionPayload,
} from "@/lib/session";

/**
 * Server-side session reader for pages and route handlers (node runtime).
 *
 * The edge proxy enforces coarse path access from the signed token alone (no DB
 * on the hot path). This is the authoritative check: it re-reads the user's
 * status, ROLE and client grants from the database rather than trusting the
 * token's baked-in claims — so a demotion (staff→client) or a revoked client
 * grant takes effect on the very next request, not only when the up-to-30-day
 * token expires. Any handler doing a real authorization decision must call this,
 * not read the token directly.
 */
export async function getSessionUser(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const payload = await verifySessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!payload) return null;

  // The shared-password bootstrap staff has no DB row.
  if (payload.userId === "shared") return payload;

  const [u] = await db
    .select({ status: users.status, role: users.role })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);
  if (!u || u.status !== "active") return null;

  // Authorization from the DB, not the token: role changes and grant
  // revocations are honoured immediately.
  const slugs = u.role === "client" ? await allowedSlugsForUser(payload.userId) : [];
  return { userId: payload.userId, role: u.role, slugs };
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
