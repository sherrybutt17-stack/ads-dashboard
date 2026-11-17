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
export function crmConnected(
  client: Pick<Client, "ghlLocationId" | "firstWebhookAt"> & Partial<Pick<Client, "ghlShareInstallationId">>,
): boolean {
  // A member of a shared sub-account has no location id of its own, but its
  // leads come from the holder's GoHighLevel connection.
  return Boolean(client.ghlLocationId || client.firstWebhookAt || client.ghlShareInstallationId);
}
