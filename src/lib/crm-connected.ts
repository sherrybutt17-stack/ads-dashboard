import type { Client } from "@/db/schema";

/**
 * Whether this client has a CRM wired up — one test for every screen.
 *
 * A location id means GoHighLevel was installed; a first webhook means it has
 * spoken. Either counts: a quiet install is still a CRM, and dropping its
 * appointment and sales tiles would read as data loss.
 *
 * Its own module, free of the database client, so pure code such as the book
 * roll-up can share the test without opening a connection on import.
 */
export function crmConnected(client: Pick<Client, "ghlLocationId" | "firstWebhookAt">): boolean {
  return Boolean(client.ghlLocationId || client.firstWebhookAt);
}
