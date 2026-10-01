import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  users,
  userClients,
  clients,
  BOOTSTRAP_AGENCY_ID,
  type User,
  type UserRole,
} from "@/db/schema";
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
  /**
   * Omit to create an INVITE: the login gets a random password nobody knows
   * and an unconfirmed address, and the person sets their own password through
   * an invite link (`lib/invites.ts`), which also confirms the address.
   *
   * Supplied, the account is usable at once and its address is stamped
   * confirmed — see `emailVerifiedAt` below for why that is not a shortcut.
   */
  password?: string;
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
        passwordHash: hashPassword(input.password || unusablePassword()),
        role: input.role,
        name: input.name?.trim() || null,
        /*
         * 🔴 Stamped when a password is supplied, and this is the fix for a
         * lockout rather than a convenience.
         *
         * Sign-in refuses any account whose address is unconfirmed, and this
         * used to leave the column null — so every login made on the Users page
         * was refused with "confirm your email" and had no link to confirm it
         * with. Because making the first account also retires the shared
         * password, following the setup instructions locked the whole team out.
         *
         * A login made by an operator who typed in the person's password was
         * made by someone who knows them: the same reasoning that let the
         * tenancy migration stamp every hand-made account that predated it. An
         * invite (no password) stays unconfirmed until the person proves the
         * inbox by accepting it.
         */
        emailVerifiedAt: input.password ? new Date() : null,
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

/** Names of the dashboards a client login opens — for the invite email. */
export async function allowedClientNamesForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: clients.name })
    .from(userClients)
    .innerJoin(clients, eq(clients.id, userClients.clientId))
    .where(eq(userClients.userId, userId))
    .orderBy(clients.name);
  return rows.map((r) => r.name);
}

/**
 * How to name the person sending an invite, or null to name the agency instead.
 *
 * Null for the first-run shared session, which has no row and no name — and for
 * a login with no name set, because an email address in "x@y.com set up a login
 * for you" reads like spam where the agency's name does not.
 */
export async function inviterNameFor(userId: string): Promise<string | null> {
  if (userId === "shared") return null;
  const u = await getUserById(userId);
  return u?.name?.trim() || null;
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
  /** Invited and not yet set up — see `isPendingInvite` in `lib/invites.ts`. */
  pending: boolean;
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
    // Spelled out rather than imported: `invites.ts` imports this module.
    pending: !u.emailVerifiedAt && !u.lastLoginAt,
    clients: byUser.get(u.id) ?? [],
  }));
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

/**
 * How many team logins have ever been usable — the shared password's
 * first-run test.
 *
 * 🔴 Not a count of rows, and the difference is three lockouts.
 *
 * The shared password admits an anonymous session only while the team has no
 * other way in. Counting ROWS answered a different question, and got it wrong
 * in every direction that matters:
 *
 *   · An invite is a row. Inviting yourself retired the shared password before
 *     you had accepted — lose the link, and nobody could get back in.
 *   · `/signup` is public and creates a row. Any visitor creating an agency
 *     switched the shared password off for the team that runs this deployment.
 *   · A CLIENT is a row. A client accepting their invite before anyone on the
 *     team had accepted theirs left the only working login one that cannot
 *     open the Users page — the "make a client login first and you are locked
 *     out" trap, moved from creation to acceptance rather than removed.
 *
 * So the line is: a confirmed address (somebody completed set-up and can sign
 * in with their own password) on a login that can run THIS deployment's own
 * agency — a platform role, or an `agency` operator of the bootstrap agency.
 * Clients and other agencies' operators never count: neither gives the team a
 * way back in.
 *
 * Disabled logins still count, deliberately. Disabling everyone must not
 * reopen an anonymous, unrevocable, see-everything door; the way back from that
 * is `DASHBOARD_BOOTSTRAP_EMAIL`, which binds the password to a named person.
 */
export async function countActivatedOperators(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        isNotNull(users.emailVerifiedAt),
        or(
          inArray(users.role, ["staff", "superadmin"]),
          and(eq(users.role, "agency"), eq(users.agencyId, BOOTSTRAP_AGENCY_ID)),
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * A password nobody knows, for a login that has been invited but not set up.
 *
 * Hashed like any other, so `verifyCredentials` needs no special case — there is
 * simply no input that matches. 32 random bytes: not guessable, and never
 * stored or shown in plain form anywhere.
 */
function unusablePassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Give an invite a fresh random password, which kills every link sent for it.
 *
 * Invite links are signed over the password hash, so this is what "send a new
 * invite" means mechanically: the old link — lost, forwarded, sitting in the
 * wrong inbox — stops verifying the moment this runs.
 *
 * 🔴 Only for a login that has never been set up. Run against a working account
 * it would silently lock its owner out; the WHERE clause refuses rather than
 * trusting every caller to have checked first.
 */
export async function rotateInvite(userId: string): Promise<User | null> {
  const [user] = await db
    .update(users)
    .set({ passwordHash: hashPassword(unusablePassword()), updatedAt: new Date() })
    .where(
      and(
        eq(users.id, userId),
        sql`${users.emailVerifiedAt} IS NULL`,
        sql`${users.lastLoginAt} IS NULL`,
      ),
    )
    .returning();
  return user ?? null;
}

/**
 * Set a password through an invite or password link, and confirm the address.
 *
 * 🔴 Compare-and-set on the hash the link was verified against.
 *
 * The link is single-use because its signature covers the current hash — but
 * "verify, then write" leaves a gap: two submits of the same link racing (a
 * double-click, a second tab) both verify before either writes, and the second
 * silently replaces the first person's password. Requiring the hash to be the
 * one that was verified makes the write itself the single-use check. Returns
 * false when the link lost that race, i.e. it has already been used.
 *
 * The address is confirmed because the link reached the inbox it was sent to.
 * An existing confirmation date is kept, not overwritten.
 */
export async function setPasswordFromLink(
  user: Pick<User, "id" | "passwordHash">,
  password: string,
): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({
      passwordHash: hashPassword(password),
      emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)))
    .returning({ id: users.id });
  return rows.length === 1;
}

/** Stamp an address as proved. Idempotent — re-verifying is not an error. */
export async function markEmailVerified(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}
