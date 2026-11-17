import { sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, type Client } from "@/db/schema";
import { eq } from "drizzle-orm";
import { rereadContact } from "./process";
import { fullSplit, liveMembers, loadShare, mirrorEvents, syncShare, type Share } from "./share";
import { dispatchShareAlerts } from "./share-actions";

/**
 * The hourly repair for shared GoHighLevel sub-accounts.
 *
 * Everything on the live path is allowed to fail softly — a delivery's copy or
 * split, a forced re-read, a lock that timed out — because this puts it right
 * within the hour, and until then new rows wait uncounted rather than counted
 * twice. Runs from the hourly reports cron, inside a time budget, and never
 * throws: it returns counts only, because that route's output lands in public
 * workflow logs.
 *
 * Per share:
 *   a. settle re-reads — contacts whose last read may predate their latest tag
 *      update, and recent contacts never read at all;
 *   b. mirror repair — rows a member's copy is missing or behind on, rows never
 *      split, cards disagreeing with their person;
 *   c. gap fill — current tags missing from the holder's tag history;
 *   d. a full split when the rules changed since the last one completed;
 *   f. event copies of the last day the live path may have missed;
 *   g. alerts for anyone a repair placed by a tag.
 * And once overall:
 *   e. the invariant — a client that doesn't share holds no stamped rows of its
 *      own installation (left by a delivery that overlapped Stop sharing, or
 *      an unfinished link).
 */

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

export interface SweepSummary {
  shares: number;
  reread: number;
  repaired: number;
  gapsFilled: number;
  resplit: number;
  reset: number;
  alerts: number;
  errors: number;
  /** Work left for the next run because the budget ran out. */
  deferred: number;
}

const SETTLE_MINUTES = 10;
/** Single re-reads per share per run; the rest wait an hour (health says so). */
const MAX_REREADS = 100;
const REPAIR_BATCH = 200;

export async function sweepShares(opts: { budgetMs?: number; now?: Date } = {}): Promise<SweepSummary> {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? 20_000);
  const left = () => deadline - Date.now();
  const out: SweepSummary = {
    shares: 0,
    reread: 0,
    repaired: 0,
    gapsFilled: 0,
    resplit: 0,
    reset: 0,
    alerts: 0,
    errors: 0,
    deferred: 0,
  };

  try {
    out.reset = await resetStrayStamps();
  } catch (err) {
    out.errors++;
    console.error("[share-sweep] invariant reset failed:", err instanceof Error ? err.message : err);
  }

  let installations: string[] = [];
  try {
    // Oldest-repaired first: the share whose holder was touched longest ago.
    installations = rows<{ id: string }>(
      await db.execute(sql`
        SELECT c.ghl_share_installation_id::text AS id, min(c.updated_at) AS touched
          FROM clients c
         WHERE c.ghl_share_installation_id IS NOT NULL
         GROUP BY c.ghl_share_installation_id
         ORDER BY touched
      `),
    ).map((r) => r.id);
  } catch (err) {
    out.errors++;
    console.error("[share-sweep] could not list shares:", err instanceof Error ? err.message : err);
    return out;
  }

  for (const installationId of installations) {
    if (left() <= 0) {
      out.deferred++;
      continue;
    }
    try {
      const share = await loadShare(db, installationId);
      if (!share) continue;
      out.shares++;
      await sweepOne(share, deadline, out);
    } catch (err) {
      out.errors++;
      console.error("[share-sweep] a share was not repaired:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}

async function sweepOne(share: Share, deadline: number, out: SweepSummary): Promise<void> {
  const I = share.installationId;
  const H = share.holder.id;
  const placed: { clientId: string; ghlContactId: string }[] = [];

  // a. Settle re-reads, through the holder's own GoHighLevel connection.
  const waiting = rows<{ gid: string }>(
    await db.execute(sql`
      WITH updates AS (
        SELECT COALESCE(payload->>'contactId', payload->>'contact_id', payload->>'id') AS gid, max(received_at) AS at
          FROM webhook_events
         WHERE client_id = ${H} AND event_type = 'ContactTagUpdate' AND received_at > now() - interval '7 days'
         GROUP BY 1
      )
      SELECT u.gid FROM updates u
        JOIN contacts h ON h.client_id = ${H} AND h.ghl_contact_id = u.gid
       WHERE u.at < now() - make_interval(mins => ${SETTLE_MINUTES})
         AND (h.attribution_fetched_at IS NULL OR h.attribution_fetched_at < u.at + make_interval(mins => ${SETTLE_MINUTES}))
      UNION
      SELECT h.ghl_contact_id FROM contacts h
       WHERE h.client_id = ${H} AND h.tags IS NULL AND h.created_at > now() - interval '7 days'
      LIMIT ${MAX_REREADS + 1}
    `),
  ).map((r) => r.gid);
  if (waiting.length > MAX_REREADS) out.deferred++;
  const toRead = waiting.slice(0, MAX_REREADS);
  if (toRead.length > 0) {
    const [holder] = await db.select().from(clients).where(eq(clients.id, H)).limit(1);
    const read: string[] = [];
    for (const gid of toRead) {
      if (Date.now() > deadline) {
        out.deferred++;
        break;
      }
      if (holder && (await rereadContact(holder as Client, gid).catch(() => false))) read.push(gid);
    }
    out.reread += read.length;
    if (read.length > 0) placed.push(...(await syncShare(I, { ghlContactIds: read })).placed);
  }

  // b. Mirror repair, newest first.
  const members = liveMembers(share).map((m) => m.id);
  let previous = "";
  for (;;) {
    if (Date.now() > deadline) {
      out.deferred++;
      break;
    }
    const stale = rows<{ gid: string }>(
      await db.execute(sql`
        SELECT h.ghl_contact_id AS gid
          FROM contacts h
         WHERE h.client_id = ${H}
           AND (
             h.share_reason IS NULL
             OR EXISTS (
               SELECT 1 FROM unnest(${sql.param(members)}::uuid[]) AS m(id)
                WHERE NOT EXISTS (SELECT 1 FROM contacts c
                                   WHERE c.client_id = m.id AND c.ghl_contact_id = h.ghl_contact_id
                                     AND c.updated_at = h.updated_at))
             OR EXISTS (SELECT 1 FROM opportunities o
                         WHERE o.share_installation_id = ${I} AND o.ghl_contact_id = h.ghl_contact_id
                           AND o.share_counted IS DISTINCT FROM (
                             SELECT c.share_counted FROM contacts c
                              WHERE c.client_id = o.client_id AND c.ghl_contact_id = o.ghl_contact_id))
           )
         ORDER BY h.updated_at DESC
         LIMIT ${REPAIR_BATCH}
      `),
    ).map((r) => r.gid);
    if (stale.length === 0) break;
    // A batch the repair cannot change would come back forever: stop, and say so.
    const key = stale.join("|");
    if (key === previous) {
      out.errors++;
      break;
    }
    previous = key;
    placed.push(...(await syncShare(I, { ghlContactIds: stale })).placed);
    out.repaired += stale.length;
    if (stale.length < REPAIR_BATCH) break;
  }

  // c. Gap fill: a current tag with no history row, dated as one we did not watch arrive.
  if (Date.now() < deadline) {
    const filled = rows<{ gid: string }>(
      await db.execute(sql`
        WITH ins AS (
          INSERT INTO contact_tag_history (contact_id, client_id, tag, first_seen_at, exact)
          SELECT h.id, h.client_id, t.tag,
                 CASE WHEN held.latest IS NULL THEN COALESCE(h.ghl_created_at, h.created_at)
                      ELSE GREATEST(COALESCE(h.attribution_fetched_at, h.ghl_created_at, h.created_at),
                                    held.latest + interval '1 millisecond') END,
                 false
            FROM contacts h
            CROSS JOIN LATERAL (SELECT max(x.first_seen_at) AS latest FROM contact_tag_history x WHERE x.contact_id = h.id) held
            CROSS JOIN LATERAL unnest(h.tags) AS t(tag)
           WHERE h.client_id = ${H} AND t.tag <> ''
             AND NOT EXISTS (SELECT 1 FROM contact_tag_history x WHERE x.contact_id = h.id AND x.tag = t.tag)
          ON CONFLICT (contact_id, tag) DO NOTHING
          RETURNING contact_id
        )
        SELECT DISTINCT h.ghl_contact_id AS gid FROM ins JOIN contacts h ON h.id = ins.contact_id
      `),
    ).map((r) => r.gid);
    out.gapsFilled += filled.length;
    for (let i = 0; i < filled.length && Date.now() < deadline; i += REPAIR_BATCH) {
      placed.push(...(await syncShare(I, { ghlContactIds: filled.slice(i, i + REPAIR_BATCH) })).placed);
    }
  }

  // d. Rules changed since the last full split.
  if (share.splitVersion < share.version && Date.now() < deadline) {
    const r = await fullSplit(I, { deadline });
    placed.push(...r.placed);
    out.resplit++;
    if (!r.complete) out.deferred++;
  }

  // f. Event copies of the last day.
  if (Date.now() < deadline) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ghl-share:${I}`}, 0))`);
      for (const m of members) {
        await mirrorEvents(tx, { holderId: H, memberId: m, installationId: I }, {
          since: new Date(Date.now() - 26 * 3_600_000),
        });
      }
    });
  }

  // g. Alerts for anyone a repair placed — the usual guards keep it to fresh leads, once.
  out.alerts += await dispatchShareAlerts(placed);
}

/**
 * A client that doesn't share must hold no row stamped with its own
 * installation: the share columns go back to NULL, so it counts exactly as
 * before. Frozen copies from a sub-account that moved agencies are left alone
 * — their stamps were nulled at the move, and their flags are history.
 */
async function resetStrayStamps(): Promise<number> {
  const [c] = rows<{ n: number }>(
    await db.execute(sql`
      WITH fixed AS (
        UPDATE contacts x SET share_installation_id = NULL, share_counted = NULL, share_reason = NULL
          FROM clients k JOIN ghl_installations i ON i.client_id = k.id
         WHERE x.client_id = k.id AND k.ghl_share_installation_id IS NULL
           AND x.share_installation_id = i.id
        RETURNING 1
      )
      SELECT COUNT(*)::int AS n FROM fixed
    `),
  );
  const [o] = rows<{ n: number }>(
    await db.execute(sql`
      WITH fixed AS (
        UPDATE opportunities x SET share_installation_id = NULL, share_counted = NULL
          FROM clients k JOIN ghl_installations i ON i.client_id = k.id
         WHERE x.client_id = k.id AND k.ghl_share_installation_id IS NULL
           AND x.share_installation_id = i.id
        RETURNING 1
      )
      SELECT COUNT(*)::int AS n FROM fixed
    `),
  );
  return Number(c?.n ?? 0) + Number(o?.n ?? 0);
}
