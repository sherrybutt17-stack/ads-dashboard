import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, userClients, clients, type User } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/crypto";

/**
 * User accounts: staff (see everything) and client (scoped to specific clients
 * via `user_clients`). Passwords are scrypt-hashed; the plaintext is never
 * stored and never returned.
 */

export interface CreateUserInput {
  email: string;
  password: string;
  role: "staff" | "client";
  name?: string | null;
  /** Only meaningful for role === "client". */
  clientIds?: string[];
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const email = input.email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email,
        passwordHash: hashPassword(input.password),
        role: input.role,
        name: input.name?.trim() || null,
      })
      .returning();

    if (input.role === "client" && input.clientIds?.length) {
      await tx
        .insert(userClients)
        .values(input.clientIds.map((clientId) => ({ userId: user.id, clientId })))
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
  role: "staff" | "client";
  name: string | null;
  status: "active" | "disabled";
  lastLoginAt: Date | null;
  createdAt: Date;
  clients: Array<{ id: string; name: string; slug: string }>;
}

export async function listUsers(): Promise<UserView[]> {
  const us = await db.select().from(users).orderBy(users.createdAt);
  const links = await db
    .select({
      userId: userClients.userId,
      id: clients.id,
      name: clients.name,
      slug: clients.slug,
    })
    .from(userClients)
    .innerJoin(clients, eq(clients.id, userClients.clientId));

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

/** Replace a user's client grants wholesale. */
export async function setUserClients(
  userId: string,
  clientIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
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
