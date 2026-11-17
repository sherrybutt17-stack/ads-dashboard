/**
 * Stop every shared GoHighLevel sub-account ("Share this sub-account").
 *
 * 🔴 Run this BEFORE deploying any code older than migration 0035. Older code
 * ignores `share_counted`, so a member's copy of a shared sub-account left
 * behind would make that client count the WHOLE sub-account — the other
 * business's leads included. This deletes every member's copies (the holder
 * keeps the originals), re-splits nothing, and leaves every holder exactly as
 * it was before it shared.
 *
 *   npx tsx --env-file=<the .env with DATABASE_URL> scripts/unshare-all.ts
 *
 * Safe to run twice: a second run finds nothing to stop.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { stopSharing } from "@/lib/ghl/share-actions";

async function main() {
  const members = (
    (await db.execute(sql`
      SELECT c.id::text AS id, c.name
        FROM clients c
        JOIN ghl_installations i ON i.id = c.ghl_share_installation_id
       WHERE i.client_id IS DISTINCT FROM c.id
       ORDER BY c.name
    `)) as unknown as { rows: { id: string; name: string }[] }
  ).rows;
  if (members.length === 0) {
    console.log("No client shares a sub-account. Nothing to do.");
    return;
  }
  for (const m of members) {
    const r = await stopSharing(m.id, { userId: "script" });
    console.log(`Stopped sharing with ${m.name}${r.holderOnly ? " (its holder now shares with no one)" : ""}.`);
  }
  console.log("Done. Every member's copies are gone and every holder is back to how it was.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
