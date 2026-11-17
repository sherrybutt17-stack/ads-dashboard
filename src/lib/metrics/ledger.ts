import { sql, type SQL } from "drizzle-orm";
import { CANONICAL_STAGES, STAGE_LABELS } from "@/lib/stages";

/**
 * The funnel ledger, as every metric must read it.
 *
 * A client's funnel comes from ONE of two sets of rows in `stage_transitions`,
 * chosen by `clients.crm_mapping_mode`:
 *
 *   pipeline  GoHighLevel stage moves — every source except `tag`
 *   tags      rows built from the contact's tags — source `tag`, each hung on
 *             the lead's stand-in opportunity (`opportunities.from_tags`)
 *
 * Both sets are kept for every tags-mode client: GoHighLevel keeps sending stage
 * moves, and they keep being recorded, so switching a client back to pipeline
 * gives its old numbers back exactly. Reading BOTH would count a person twice —
 * once per card and once per tag — so every read goes through these two
 * relations instead of the bare tables. A query that names `stage_transitions`
 * or `opportunities` directly sees the wrong rows for a tags-mode client.
 *
 * Written as subqueries rather than views so nothing but a column has to exist
 * in the database for them to work, and so the PGlite harness needs no view.
 * Postgres flattens a plain subquery into the query around it, so the client
 * filter outside still reaches the indexes.
 *
 * Enums are compared as TEXT on purpose: naming an enum label the database
 * does not have yet rejects the whole statement, and these run on every page.
 * The join is LEFT, with a missing client read as pipeline, so a row is never
 * dropped for want of its client — the foreign key makes that impossible in
 * production, and the test harness inserts ledger rows without clients.
 *
 * ── Shared sub-accounts ────────────────────────────────────────────────
 *
 * A client that shares a GoHighLevel sub-account (`src/lib/ghl/share.ts`)
 * holds a FULL copy of it, and only the people the split gives it count:
 * `share_counted` is true on its copy of them and false on the rest. Every
 * relation here drops the false rows. NULL — every client that doesn't share —
 * reads as counted, so those clients' numbers cannot move. A query that reads
 * `contacts`, `opportunities` or `stage_transitions` directly would count the
 * whole sub-account for every client in the share, AND show one business's
 * lead names to the other's logins — `share-census.test.ts` guards against it.
 *
 * Transitions are dropped through their opportunity, not their contact: a
 * transition's contact_id can be NULL. The anti-join reads a partial index
 * holding only false rows, which is empty for clients that don't share.
 */
export const FUNNEL_TRANSITIONS: SQL = sql`(
  SELECT ftr.*
  FROM stage_transitions ftr
  LEFT JOIN clients fcl ON fcl.id = ftr.client_id
  WHERE (ftr.source::text = 'tag') = (COALESCE(fcl.crm_mapping_mode::text, 'pipeline') = 'tags')
    AND NOT EXISTS (
      SELECT 1 FROM opportunities fsx WHERE fsx.id = ftr.opportunity_id AND fsx.share_counted = false
    )
)`;

/** The opportunities that belong to a client's funnel — see `FUNNEL_TRANSITIONS`. */
export const FUNNEL_OPPORTUNITIES: SQL = sql`(
  SELECT fop.*
  FROM opportunities fop
  LEFT JOIN clients fcl ON fcl.id = fop.client_id
  WHERE fop.from_tags = (COALESCE(fcl.crm_mapping_mode::text, 'pipeline') = 'tags')
    AND fop.share_counted IS NOT FALSE
)`;

/**
 * The contacts that are this client's — every contact for a client that
 * doesn't share; only the people the split gives it for one that does. Every
 * read of `contacts` that is not a join from an already-filtered ledger row
 * goes through this. See `FUNNEL_TRANSITIONS`.
 */
export const FUNNEL_CONTACTS: SQL = sql`(
  SELECT fct.* FROM contacts fct WHERE fct.share_counted IS NOT FALSE
)`;

/**
 * Narrows outbound-call rows from `webhook_events` (aliased by `w`) to calls to
 * this client's own leads.
 *
 * Always drops calls to a contact whose copy here is not this client's. For a
 * client in a share it also requires a copy that IS this client's: every
 * delivery is copied to every client in the share, so a call to the other
 * business's lead must not count. A client that doesn't share keeps counting
 * calls to contacts we never stored — leads from before the app was installed —
 * exactly as before.
 */
export function SHARE_CALL_FILTER(w: SQL): SQL {
  return sql`
    AND NOT EXISTS (
      SELECT 1 FROM contacts fxc
       WHERE fxc.client_id = ${w}.client_id
         AND fxc.ghl_contact_id = ${w}.payload->>'contactId'
         AND fxc.share_counted = false
    )
    AND (
      NOT EXISTS (SELECT 1 FROM clients fsc WHERE fsc.id = ${w}.client_id AND fsc.ghl_share_installation_id IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM contacts fcc
         WHERE fcc.client_id = ${w}.client_id
           AND fcc.ghl_contact_id = ${w}.payload->>'contactId'
           AND fcc.share_counted IS NOT FALSE
      )
    )`;
}

/**
 * The step a tag lead is in now, stored on its stand-in opportunity as
 * `current_stage_ghl_id = 'tag:<step>'` because it has no pipeline stage row.
 * Every helper below needs the opportunity as `o` and its LEFT JOINed
 * `pipeline_stages` as `ps`.
 */
const TAG_STEP = sql`split_part(o.current_stage_ghl_id, ':', 2)`;

/** Current canonical stage, as text: the mapped pipeline stage, or the tag step. */
export const OPP_CANONICAL: SQL = sql`COALESCE(ps.canonical_stage::text, CASE WHEN o.from_tags THEN ${TAG_STEP} END)`;

/**
 * A fixed string from this file as an SQL literal. Inlined rather than bound,
 * because a bind parameter inside CASE or ARRAY[] has no type for Postgres to
 * infer; these are compile-time constants, never user input.
 */
const literal = (s: string) => sql.raw(`'${s.replace(/'/g, "''")}'`);

/** Current stage's display name. A tag lead shows the step it reached. */
export const OPP_STAGE_NAME: SQL = sql`COALESCE(ps.ghl_stage_name, CASE WHEN o.from_tags THEN CASE ${TAG_STEP} ${sql.join(
  CANONICAL_STAGES.map((s) => sql`WHEN ${literal(s)} THEN ${literal(STAGE_LABELS[s])}`),
  sql` `,
)} END END)`;

/** Current stage's pipeline name. Tag leads all sit in "Tags". */
export const OPP_PIPELINE_NAME: SQL = sql`COALESCE(ps.ghl_pipeline_name, CASE WHEN o.from_tags THEN 'Tags' END)`;

/** Sort position of the current stage. Tag steps follow the funnel's order. */
export const OPP_STAGE_ORDER: SQL = sql`COALESCE(ps.display_order, CASE WHEN o.from_tags THEN array_position(ARRAY[${sql.join(
  CANONICAL_STAGES.map((s) => literal(s)),
  sql`, `,
)}]::text[], ${TAG_STEP}) END)`;
