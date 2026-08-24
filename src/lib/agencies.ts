import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agencies, type Agency } from "@/db/schema";
import { slugify } from "@/lib/clients";

/**
 * Creating a tenant.
 *
 * Small on purpose. An agency is an identity and a boundary, not a
 * configuration object — everything else about it (branding, clients, users)
 * hangs off the row rather than living in it, so there is nothing to get wrong
 * here except the slug.
 */

/**
 * A slug nobody else holds.
 *
 * `agencies.slug` is uniquely indexed, so the loop is a courtesy that turns a
 * constraint violation into a working sign-up rather than a 500 on somebody's
 * first interaction with the product. The suffix counts from 2 because
 * "acme-1" reads like a mistake and "acme-2" reads like a second Acme.
 */
export async function uniqueAgencySlug(name: string): Promise<string> {
  const root = slugify(name) || "agency";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [taken] = await db
      .select({ id: agencies.id })
      .from(agencies)
      .where(eq(agencies.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  /*
   * Fifty collisions on one name means something pathological — a script, or a
   * name that slugifies to almost nothing. A random suffix always terminates,
   * where a longer loop only postpones the same question.
   */
  return `${root}-${Math.floor(Date.now() % 1_000_000).toString(36)}`;
}

export async function createAgency(name: string): Promise<Agency> {
  const [row] = await db
    .insert(agencies)
    .values({ name: name.trim(), slug: await uniqueAgencySlug(name) })
    .returning();
  return row;
}
