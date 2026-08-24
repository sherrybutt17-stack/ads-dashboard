/**
 * Recover attribution for native Instant Form leads, from their leadgen id.
 *
 * A Lead Ad form opens inside Facebook. There is no landing page, so there is
 * no URL, so none of the `utm_id` / `ad_id` parameter reading that attributes
 * every other lead can find anything — those leads arrive with no campaign and
 * stay that way however carefully the ads are tagged. The one thing they carry
 * is a leadgen id, and Meta will trade it back for the ad, ad set and campaign.
 *
 * This is a DIFFERENT job from `backfill-attribution.ts`, which re-parses
 * payloads already stored and fetches nothing. This one calls the Meta API.
 *
 *   npx tsx --env-file=.env.local scripts/repair-attribution.ts [--apply] [--slug=x]
 *
 * Dry run by default: it resolves, prints exactly what it would write, and
 * exits without touching a row.
 *
 * ── 🔴 Expect this to be refused, and read the message when it is ──────
 *
 * `GET /{leadgen_id}` needs `leads_retrieval`. The system user token this app
 * uses is provisioned `ads_read`. Reading a lead means reading what a person
 * typed into a form, and Meta gates that far more tightly than ad statistics.
 *
 * So the likely outcome of the first run is a permission error, and the script
 * is built to say so in as many words rather than reporting "0 repaired" — a
 * silent zero looks identical to "nothing needed repairing", and would send
 * someone to the wrong conclusion about their own data.
 *
 * ── Only ever fills ───────────────────────────────────────────────────
 *
 * A contact that already has a campaign id keeps it. A lead's originating ad
 * cannot change after the fact, so a second opinion is never worth writing, and
 * this staying strictly additive is what makes it safe to re-run.
 */
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "../src/db";
import { clients, contacts } from "../src/db/schema";
import { MetaClient } from "../src/lib/meta/client";
import {
  isBlockedByPermission,
  resolveLeadgen,
  type LeadgenAttribution,
} from "../src/lib/meta/leadgen";
import { decryptNullable } from "../src/lib/crypto";

const APPLY = process.argv.includes("--apply");
const SLUG = process.argv.find((a) => a.startsWith("--slug="))?.slice(7);

/**
 * Bounded per run.
 *
 * One serial API call per lead, and Meta's rate limits are per-account rather
 * than per-script. A run that walks ten thousand leads would spend the
 * account's whole hourly budget and stall the nightly insights sync behind it —
 * so the script does a slice, says how many are left, and can be run again.
 */
const MAX_PER_RUN = 500;

async function main() {
  const all = await db.select().from(clients);
  const targets = SLUG ? all.filter((c) => c.slug === SLUG) : all;
  if (targets.length === 0) {
    console.error(SLUG ? `No client with slug "${SLUG}".` : "No clients.");
    process.exit(1);
  }

  let totalPending = 0;
  let totalResolved = 0;
  let totalWritten = 0;

  for (const client of targets) {
    /*
     * Leads holding a leadgen id and missing at least one Meta id. The `or`
     * matters: a lead can have a campaign from some other path and still be
     * missing the ad, and ad-level reporting is the whole point of §1e.
     */
    const pending = await db
      .select({
        id: contacts.id,
        facebookLeadId: contacts.facebookLeadId,
        metaCampaignId: contacts.metaCampaignId,
        metaAdsetId: contacts.metaAdsetId,
        metaAdId: contacts.metaAdId,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.clientId, client.id),
          isNotNull(contacts.facebookLeadId),
          or(
            isNull(contacts.metaCampaignId),
            isNull(contacts.metaAdsetId),
            isNull(contacts.metaAdId),
          ),
        ),
      )
      .limit(MAX_PER_RUN);

    if (pending.length === 0) continue;
    totalPending += pending.length;

    console.log(
      `\n${client.name} (${client.slug}) — ${pending.length} lead${pending.length === 1 ? "" : "s"} with a leadgen id and missing attribution`,
    );

    const token =
      decryptNullable(client.metaTokenEncrypted) ??
      process.env.META_SYSTEM_USER_TOKEN;
    if (!token) {
      console.log("  skipped: no Meta token for this client");
      continue;
    }

    const ids = pending
      .map((p) => p.facebookLeadId)
      .filter((v): v is string => Boolean(v));

    const result = await resolveLeadgen(ids, {
      client: new MetaClient(token),
    });

    if (isBlockedByPermission(result)) {
      console.log(
        "  🔴 REFUSED — this token cannot read lead submissions.\n" +
          `     Meta said: ${result.failures[0]?.message}\n` +
          "     The scope needed is `leads_retrieval`, not `ads_read`. Until it is\n" +
          "     granted, native Instant Form leads cannot be attributed by any route —\n" +
          "     they carry no URL parameters, so there is nothing else to read.",
      );
      continue;
    }

    const byLeadId = new Map<string, LeadgenAttribution>(
      result.resolved.map((r) => [r.leadId, r]),
    );
    totalResolved += result.resolved.length;

    for (const row of pending) {
      const got = row.facebookLeadId ? byLeadId.get(row.facebookLeadId) : undefined;
      if (!got) continue;

      // Fill only. A value already present is never replaced.
      const patch: Record<string, string> = {};
      if (!row.metaCampaignId && got.campaignId) patch.metaCampaignId = got.campaignId;
      if (!row.metaAdsetId && got.adsetId) patch.metaAdsetId = got.adsetId;
      if (!row.metaAdId && got.adId) patch.metaAdId = got.adId;
      if (Object.keys(patch).length === 0) continue;

      console.log(
        `  ${row.id}  ${Object.entries(patch)
          .map(([k, v]) => `${k}=${v}`)
          .join("  ")}`,
      );

      if (APPLY) {
        await db.update(contacts).set(patch).where(eq(contacts.id, row.id));
        totalWritten++;
      }
    }

    const other = result.failures.filter((f) => f.reason !== "permission");
    if (other.length > 0) {
      console.log(
        `  ${other.length} could not be resolved (${[
          ...new Set(other.map((f) => f.reason)),
        ].join(", ")})`,
      );
    }
    if (pending.length === MAX_PER_RUN) {
      // Never let a cap read as completeness.
      console.log(
        `  ⚠️  hit the ${MAX_PER_RUN}-lead cap for this run; re-run to continue`,
      );
    }
  }

  if (totalPending === 0) {
    console.log(
      "\nNo leads carry a leadgen id.\n" +
        "That is expected until an Instant Form lead comes through the webhook —\n" +
        "`contacts.facebook_lead_id` is written by the GHL contact path and there is\n" +
        "no historical source for it.",
    );
    return;
  }

  console.log(
    `\n${totalResolved} resolved · ${APPLY ? `${totalWritten} written` : "dry run — nothing written"}`,
  );
  if (!APPLY) console.log("Re-run with --apply to write.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
