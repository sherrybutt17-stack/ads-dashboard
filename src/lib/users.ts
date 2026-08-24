import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { users, userClients, clients, type User, type UserRole } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/crypto";

/**
 * User accounts: staff (see everything) and client (scoped to specific clients
 * via `user_clients`). Passwords are scrypt-hashed; the plaintext is never
 * stored and never returned.
 */

export interface CreateUserInput {
  /**
   * The agency this login belongs to.
   *
   * Every user has one, superadmins included — see the column comment on
   * `users.agencyId` for why a nullable tenant turns a scoping bug into an
   * empty screen instead of an error.
   */
  agencyId: string;
  email: string;
  password: string;
  /**
   * 🔴 Callers must not pass this straight from a request body.
   *
   * `assignableRoles()` is the rule: an `agency` operator may create `agency`
   * and `client` logins and nothing else. Without that gate, an agency admin
   * POSTing `role: "staff"` mints an account that reads every tenant in the
   * database — a one-request privilege escalation out of their own tenancy,
   * through the ordinary "add a teammate" form.
   */
  role: UserRole;
  name?: string | null;
  /** Only meaningful for role === "client". */
  clientIds?: string[];
}


/**
 * Every id in `clientIds`, confirmed to belong to `agencyId`. Throws otherwise.
 *
 * ── Why this is refused at the source ─────────────────────────────────
 *
 * `agencyId` and `role` are both taken from the caller's session and gated —
 * roles by `assignableRoles`, the tenant by never being read from input. The
 * client ids were not: they arrive in the request body and went straight into
 * `user_clients`.
 *
 * That was not exploitable. `sessionMaySeeClient` compares tenants BEFORE it
 * consults the slug grant, and every `/c/[slug]` page resolves through
 * `getClientForSession`, so a foreign grant is inert. But the row is still
 * WRITTEN: invisible on the page that manages it (`listUsersForAgency` scopes
 * its join), and carried into the session token as a slug that can never be
 * used. Its harmlessness rests entirely on three downstream checks keeping
 * their current order forever — and a grant that cannot be created is a smaller
 * thing to protect than a grant that must never be honoured.
 *
 * 🔴 All-or-nothing, deliberately. Silently dropping the bad id would let the
 * form report success while granting less than the operator asked for, and the
 * gap would surface weeks later as a client who cannot see their own report.
 */
async function assertClientsInAgency(
  tx: { select: typeof db.select },
  agencyId: string,
  clientIds: string[],
): Promise<void> {
  if (clientIds.length === 0) return;
  const unique = [...new Set(clientIds)];
  const found = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.agencyId, agencyId), inArray(clients.id, unique)));
  if (found.length !== unique.length) {
    // One message for "not yours" and for "no such client", so the endpoint
    // cannot be walked to discover which client uuids are real.
    throw new Error("One or more clients do not belong to this agency");
  }
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const email = input.email.trim().toLowerCase();
  const clientIds = input.role === "client" ? (input.clientIds ?? []) : [];
  return db.transaction(async (tx) => {
    await assertClientsInAgency(tx as never, input.agencyId, clientIds);
    const [user] = await tx
      .insert(users)
      .values({
        agencyId: input.agencyId,
        email,
        passwordHash: hashPassword(input.password),
        role: input.role,
        name: input.name?.trim() || null,
      })
      .returning();

    if (clientIds.length) {
      await tx
        .insert(userClients)
        .values(clientIds.map((clientId) => ({ userId: user.id, clientId })))
        .onConflictDoNothing();
    }
    return user;
  });
}

/** Returns the user only if the email exists, is active, and the password matches. */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user || user.status !== "active") return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

/** By email, regardless of password. Used to bind the shared-password bootstrap. */
export async function getUserByEmail(email: string): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return user ?? null;
}

/**
 * A user, only if they belong to `agencyId`.
 *
 * Same shape and same reasoning as `getClientByIdForSession`: one null for
 * "no such user" and for "not yours", so the endpoint cannot be walked to
 * discover which uuids are real.
 */
export async function getUserInAgency(
  agencyId: string,
  id: string,
): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.agencyId, agencyId)))
    .limit(1);
  return user ?? null;
}

export async function getUserById(id: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

/** The client slugs a user may access (empty for a client with no grants). */
export async function allowedSlugsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: clients.slug })
    .from(userClients)
    .innerJoin(clients, eq(clients.id, userClients.clientId))
    .where(eq(userClients.userId, userId));
  return rows.map((r) => r.slug);
}

export async function touchLastLogin(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, userId));
}

export interface UserView {
  id: string;
  email: string;
  role: UserRole;
  name: string | null;
  status: "active" | "disabled";
  lastLoginAt: Date | null;
  createdAt: Date;
  clients: Array<{ id: string; name: string; slug: string }>;
}

/**
 * The users of ONE agency.
 *
 * 🔴 There is no `listUsers()`. It returned every login in the database and fed
 * the `/users` page, so the moment a second agency existed, one agency's admin
 * would see every other agency's staff — names, emails, roles, last-login
 * times, and which clients each of them holds. That is a better target list
 * than most of what this application protects.
 */
export async function listUsersForAgency(agencyId: string): Promise<UserView[]> {
  const us = await db
    .select()
    .from(users)
    .where(eq(users.agencyId, agencyId))
    .orderBy(users.createdAt);
  const links = await db
    .select({
      userId: userClients.userId,
      id: clients.id,
      name: clients.name,
      slug: clients.slug,
    })
    .from(userClients)
    .innerJoin(clients, eq(clients.id, userClients.clientId))
    // Scoped as well: a grant pointing at another agency's client would print
    // that client's name and slug on this page.
    .where(eq(clients.agencyId, agencyId));

  const byUser = new Map<string, Array<{ id: string; name: string; slug: string }>>();
  for (const l of links) {
    const list = byUser.get(l.userId) ?? [];
    list.push({ id: l.id, name: l.name, slug: l.slug });
    byUser.set(l.userId, list);
  }

  return us.map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    name: u.name,
    status: u.status,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    clients: byUser.get(u.id) ?? [],
  }));
}

export async function setUserPassword(
  userId: string,
  password: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: hashPassword(password), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function setUserStatus(
  userId: string,
  status: "active" | "disabled",
): Promise<void> {
  await db
    .update(users)
    .set({ status, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Replace a user's client grants wholesale.
 *
 * The agency is read from the TARGET USER rather than passed in — a caller that
 * forgot to supply it would otherwise skip the check entirely, and this is the
 * path an attacker reaches for second once creation is closed.
 */
export async function setUserClients(
  userId: string,
  clientIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ agencyId: users.agencyId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) throw new Error("User not found");
    // Before the delete, so a refused request leaves the existing grants intact
    // rather than clearing them and then failing.
    await assertClientsInAgency(tx as never, target.agencyId, clientIds);

    await tx.delete(userClients).where(eq(userClients.userId, userId));
    if (clientIds.length) {
      await tx
        .insert(userClients)
        .values(clientIds.map((clientId) => ({ userId, clientId })))
        .onConflictDoNothing();
    }
  });
}

export async function deleteUser(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

export async function countUsers(): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

/** Stamp an address as proved. Idempotent — re-verifying is not an error. */
export async function markEmailVerified(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}
