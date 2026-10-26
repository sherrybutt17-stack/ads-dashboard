import { and, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "@/db";
import {
  contacts,
  opportunities,
  pipelineStages,
  stageTransitions,
  syncRuns,
  type Client,
  type PipelineStage,
} from "@/db/schema";
import { parseAttribution } from "./attribution";
import { isTransientGhlFailure, type CallLimits } from "./client";
import { normalizeStatus, parseDate } from "./normalize";
import { extractTags, getGhlClientAsync } from "./process";
import type { GhlContact, GhlOpportunity } from "./types";

/**
 * Import a client's GoHighLevel history — what the dashboard can know about
 * the time before its webhook went live.
 *
 * ── What GoHighLevel can give, and what it cannot ─────────────────────
 *
 * GHL keeps no stage history, so the path a lead took is gone for good. What
 * it does keep, and this imports:
 *
 *   · every CONTACT, with when it came in (`dateAdded`), its tags and both
 *     attribution touches — parsed exactly as the live path parses them, so a
 *     past lead counts as paid by the same rule as today's;
 *   · every OPPORTUNITY, with when it was created and the stage it is in now.
 *
 * From those it writes two kinds of ledger row, both `backfill_snapshot`:
 *
 *   · an INTAKE — arrival at the pipeline's New lead stage, at the
 *     opportunity's creation date. 🔴 The row the old snapshot never wrote:
 *     it recorded only the CURRENT stage, so a lead that came in March and was
 *     won in May counted as a May win and never as a March lead. Past months
 *     showed leads only for opportunities still parked in New lead — Modern
 *     Vision's 1,942 imported opportunities showed none (26 Oct 2026). The
 *     dedupe key matches `scripts/import-gg-ghl.ts`, which already wrote these
 *     for gg-ads, so re-importing there adds nothing.
 *   · a SNAPSHOT — arrival at the current stage, when it last moved.
 *
 * An intake is written only where the opportunity's own pipeline has a stage
 * mapped to New lead — the live path counts a lead the same way, and a
 * pipeline the operator mapped without one is telling us its opportunities
 * are not new leads (Brinton's 588 outbound-email prospects, 27 Oct 2026). It
 * is never written twice: not when the opportunity already has a New lead
 * row, nor when the webhook saw it being created.
 *
 * ── It fits the time limit, and resumes ───────────────────────────────
 *
 * The old snapshot made five database round trips per opportunity in one
 * request; Soroudi's 5,600 ran past the route's 300 s twice and stopped
 * "running" forever — and it paged by number, which GHL refuses past 10,000
 * records, so Soroudi's 17,796 could never finish. This pages by GHL's own
 * cursors, writes a page at a time — a few statements per 100 opportunities or
 * 500 contacts, each opportunities page in one transaction — and stops
 * starting pages after `budgetMs`, returning a cursor the next request carries
 * on from. A GoHighLevel call that hangs is abandoned at a deadline inside the
 * route's limit, and a GoHighLevel hiccup after pages were written pauses the
 * import there instead of failing it. Everything it writes is idempotent, so
 * a request cut off anywhere is safe to repeat.
 */

/** Stop starting new pages after this long; the route allows 300 s. */
const DEFAULT_BUDGET_MS = 200_000;
/**
 * No GoHighLevel call may still be running this long after the budget — so a
 * page started just inside it is written and answered before the route's
 * limit, which kills a request silently.
 */
const DEADLINE_AFTER_BUDGET_MS = 60_000;
/** One GoHighLevel call, at most; one that hangs is retried, not waited on. */
const CALL_TIMEOUT_MS = 30_000;
/** The access token must outlast the request, or every call after it expires is a 401. */
const TOKEN_MIN_VALIDITY_MS = 6 * 60 * 1000;
/** A webhook transition this close to creation means the live path saw the lead arrive. */
const OBSERVED_SLACK_MS = 24 * 60 * 60 * 1000;
/** An import still "running" this long after it started was cut off. */
const STALE_RUN = "15 minutes";
/** Far beyond any sub-account: a total in a tampered cursor stays an ordinary number. */
const MAX_TOTAL = 10_000_000;
/** `numeric(14, 2)` holds less than a trillion; a larger "deal value" is a typo, not a deal. */
const MAX_MONEY = 999_999_999_999;

export interface HistoryTotals {
  contacts: number;
  opportunities: number;
  /** Intake rows written: leads dated to when they came in. */
  leads: number;
  transitions: number;
  /** Records the database refused even after cleaning, and so left out. */
  skipped: number;
}

const ZERO: HistoryTotals = { contacts: 0, opportunities: 0, leads: 0, transitions: 0, skipped: 0 };

const count = z.number().int().min(0).max(MAX_TOTAL);
const Totals = z
  .object({ contacts: count, opportunities: count, leads: count, transitions: count, skipped: count })
  .strict();

/**
 * Where an import carries on. Built by this module and handed back by the
 * browser, so it is validated strictly. Tampering with it can change only
 * where this client's own import resumes and the running totals it reports —
 * never which client it reads or writes, and never what is written, since
 * every write is idempotent.
 */
const Cursor = z
  .object({
    v: z.literal(1),
    phase: z.enum(["contacts", "opportunities"]),
    /** GHL's `searchAfter` for the next contacts page. */
    after: z.array(z.union([z.string().max(200), z.number()])).max(4).optional(),
    /** GHL's `startAfter` + `startAfterId` for the next opportunities page. */
    oppAfter: z
      .object({
        startAfter: z.number().int().min(0),
        startAfterId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      })
      .strict()
      .optional(),
    totals: Totals,
  })
  .strict();

export type HistoryCursor = z.infer<typeof Cursor>;

export function encodeHistoryCursor(c: HistoryCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** The cursor a request carried, or null for anything that is not one. */
export function decodeHistoryCursor(raw: string): HistoryCursor | null {
  if (raw.length > 4000) return null;
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface HistoryResult {
  done: boolean;
  /** Pass back to carry on; null when done. */
  cursor: string | null;
  phase: "contacts" | "opportunities" | "done";
  /** So far, across every request of this import. */
  totals: HistoryTotals;
  /** What the operator should know or do, when done. */
  notes: string[];
}

/** Where the next request starts. */
type Position = Pick<HistoryCursor, "phase" | "after" | "oppAfter">;

export async function importGhlHistory(
  client: Client,
  opts: { cursor?: HistoryCursor | null; budgetMs?: number } = {},
): Promise<HistoryResult> {
  const started = Date.now();
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const over = () => Date.now() - started > budget;
  const limits: CallLimits = {
    timeoutMs: CALL_TIMEOUT_MS,
    ...(Number.isFinite(budget) ? { deadline: started + budget + DEADLINE_AFTER_BUDGET_MS } : {}),
  };
  const totals: HistoryTotals = { ...ZERO, ...opts.cursor?.totals };

  // An earlier request killed by the time limit never closed its run; say so, rather than "running" forever.
  await db
    .update(syncRuns)
    .set({
      status: "failed",
      finishedAt: new Date(),
      error: "Cut off before it finished — the request ran out of time. Importing again carries on safely.",
    })
    .where(
      and(
        eq(syncRuns.clientId, client.id),
        eq(syncRuns.kind, "ghl_backfill"),
        eq(syncRuns.status, "running"),
        lt(syncRuns.startedAt, sql`now() - ${STALE_RUN}::interval`),
      ),
    );

  const [run] = await db
    .insert(syncRuns)
    .values({ clientId: client.id, kind: "ghl_backfill", status: "running" })
    .returning({ id: syncRuns.id });

  const finish = async (result: HistoryResult) => {
    await db
      .update(syncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        rowsWritten: result.totals.transitions,
        meta: { phase: result.phase, done: result.done, ...result.totals },
      })
      .where(eq(syncRuns.id, run.id));
    return result;
  };
  /** Hand back where to carry on — null when GHL named a position no cursor can carry, so the caller keeps going. */
  const pause = (at: Position) => {
    const cursor = Cursor.safeParse({ v: 1, ...at, totals });
    if (!cursor.success) {
      console.warn(`[ghl] ${client.slug}: GoHighLevel's page position can't be carried in a cursor; continuing without a pause`);
      return null;
    }
    return finish({ done: false, phase: at.phase, totals, notes: [], cursor: encodeHistoryCursor(cursor.data) });
  };

  /** Where the next request would start, as of the last page this one wrote. Null until one is. */
  let resumeAt: Position | null = null;

  try {
    const ghl = await getGhlClientAsync(client, { minValidityMs: TOKEN_MIN_VALIDITY_MS });
    const locationId = client.ghlLocationId;
    if (!ghl || !locationId) throw new Error(await connectionProblem(client));

    // Pipelines first, on the first request: an opportunity in a pipeline we
    // have never listed could not be placed. Mappings already made are kept.
    if (!opts.cursor) {
      const { importPipelineStages } = await import("@/lib/clients");
      await importPipelineStages(client).catch((err: unknown) => {
        console.warn(`[ghl] pipelines not refreshed for ${client.slug}:`, err instanceof Error ? err.message : err);
      });
    }

    /* ---------------- contacts ---------------- */
    if (!opts.cursor || opts.cursor.phase === "contacts") {
      for await (const page of ghl.iterateContacts(locationId, { searchAfter: opts.cursor?.after, limits })) {
        const r = await upsertContacts(client.id, page.contacts);
        totals.contacts += r.written;
        totals.skipped += r.skipped;
        resumeAt = page.next ? { phase: "contacts", after: page.next as HistoryCursor["after"] } : { phase: "opportunities" };
        if (page.next && over()) {
          const paused = await pause(resumeAt);
          if (paused) return paused;
        }
      }
      if (resumeAt) resumeAt = { phase: "opportunities" };
    }

    /* ---------------- opportunities ---------------- */
    const stages = await stageIndex(client.id);
    const oppAfter = opts.cursor?.phase === "opportunities" ? opts.cursor.oppAfter : undefined;
    for await (const page of ghl.iterateOpportunityPages(locationId, { after: oppAfter, limits })) {
      const r = await importOpportunities(client.id, page.opportunities, stages);
      totals.opportunities += r.opportunities;
      totals.transitions += r.transitions;
      totals.leads += r.leads;
      totals.skipped += r.skipped;
      resumeAt = page.next ? { phase: "opportunities", oppAfter: page.next } : null;
      if (page.next && over()) {
        const paused = await pause(resumeAt!);
        if (paused) return paused;
      }
    }

    return finish({ done: true, phase: "done", cursor: null, totals, notes: await importNotes(client.id, totals, stages) });
  } catch (err) {
    /*
     * GoHighLevel busy, down, or too slow, after this request wrote pages:
     * hand back where they got to, and the next request carries on. Failing
     * instead threw away the position, and the next press started again.
     */
    if (resumeAt && isTransientGhlFailure(err)) {
      console.warn(`[ghl] ${client.slug}: history import paused on a GoHighLevel hiccup —`, err instanceof Error ? err.message : err);
      const paused = await pause(resumeAt);
      if (paused) return paused;
    }
    const failure = importFailure(err);
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: new Date(), error: failure.stored })
      .where(eq(syncRuns.id, run.id))
      .catch((e: unknown) => console.error(`[ghl] ${client.slug}: could not record the failed import (${sqlState(e) ?? "no code"})`));
    throw failure.thrown;
  }
}

/**
 * Why there is no GHL client to import with — in words an operator can act on.
 * "Client has no GHL connection" covered three different situations.
 */
async function connectionProblem(client: Client): Promise<string> {
  if (client.ghlAuthMethod === "oauth") {
    const { getInstallationForClient } = await import("./oauth");
    const installation = await getInstallationForClient(client.id).catch(() => null);
    if (installation && !installation.uninstalledAt) {
      return "GoHighLevel refused to renew this client's access. Reconnect it with Install on a sub-account, then import again.";
    }
  }
  return "GoHighLevel isn't connected for this client yet. Connect it with Install on a sub-account, then import.";
}

/* ------------------------------------------------------------------ *
 * Failures
 * ------------------------------------------------------------------ */

/**
 * The Postgres error code (SQLSTATE) behind a failed statement, wherever the
 * driver put it — drizzle wraps the driver's error as its `cause`. Node's own
 * codes (`EPIPE`, `ECONNRESET`) start with an E, which no SQLSTATE class does.
 */
function sqlState(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^(?:[0-9][0-9A-Z]|HV|P0|XX|F0)[0-9A-Z]{3}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** The database refused a value — a data exception or a broken constraint — rather than failing. */
function refusedValue(err: unknown): boolean {
  return /^2[123]/.test(sqlState(err) ?? "");
}

/**
 * What a failed import records, and what it throws on to the route.
 *
 * 🔴 Never the database's own words. A failed write throws drizzle's
 * `DrizzleQueryError`, whose message is the statement and every parameter —
 * a page of contacts' names, emails and phone numbers. It went into
 * `sync_runs.error`, and, being a plain `Error` to `safeFailure`, back to the
 * browser verbatim. GoHighLevel's errors and our own messages pass on as they
 * are: the route words the first, and the second is already worded.
 */
function importFailure(err: unknown): { stored: string; thrown: unknown } {
  const state = sqlState(err);
  if (state || (err && typeof err === "object" && ("query" in err || "params" in err))) {
    const message = `Couldn't save a page of the import${state ? ` (database code ${state})` : ""}. Import again to carry on — nothing is imported twice.`;
    return { stored: message, thrown: new Error(message) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { stored: message.slice(0, 500), thrown: err };
}

/* ------------------------------------------------------------------ *
 * Values the database can store
 * ------------------------------------------------------------------ */

/**
 * The same value, with every string made storable: no NUL characters, which
 * Postgres refuses in any text, and no unpaired surrogates — half an emoji,
 * cut off — which it refuses in jsonb. Keys too.
 *
 * 🔴 GoHighLevel passes on whatever a form received, and one such value failed
 * the whole page it was in — on every attempt, so the import could never get
 * past it.
 */
export function storable<T>(value: T, depth = 0): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "").toWellFormed() as T;
  if (value === null || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => storable(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[storable(k)] = storable(v, depth + 1);
  return out as T;
}

/** A deal value `numeric(14, 2)` can hold, or null. */
function money(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_MONEY ? String(v) : null;
}

/** Run a write so that, refused, it is undone alone: a savepoint inside a transaction. */
type Savepoint = <R>(write: () => Promise<R>) => Promise<R>;

/**
 * Rows a statement each, leaving out only the ones the database refuses — the
 * slow path, for a page whose one statement was refused even after cleaning.
 */
async function rowByRow<T, R>(
  rows: readonly T[],
  write: (batch: T[]) => Promise<R[]>,
  savepoint: Savepoint,
): Promise<{ written: R[]; skipped: number }> {
  const written: R[] = [];
  let skipped = 0;
  for (const row of rows) {
    try {
      written.push(...(await savepoint(() => write([row]))));
    } catch (err) {
      if (!refusedValue(err)) throw err;
      skipped++;
      console.warn(`[ghl] history import left out a record the database refused (code ${sqlState(err)})`);
    }
  }
  return { written, skipped };
}

/* ------------------------------------------------------------------ *
 * Contacts
 * ------------------------------------------------------------------ */

/** `COALESCE(excluded.col, table.col)`: a value GHL left out never blanks one we hold. */
function keep(col: AnyPgColumn): SQL {
  return sql`COALESCE(excluded.${sql.identifier(col.name)}, ${col})`;
}
function take(col: AnyPgColumn): SQL {
  return sql`excluded.${sql.identifier(col.name)}`;
}

/**
 * One page of contacts in one statement, with the values the webhook path
 * writes for a contact it fetched (`upsertContactFromEvent`): the same
 * attribution parsing, the same tag normalisation, and the same rule that a
 * value GHL omits never overwrites one already captured.
 */
async function upsertContacts(clientId: string, page: readonly GhlContact[]): Promise<{ written: number; skipped: number }> {
  const byId = new Map<string, GhlContact>();
  for (const raw of page) {
    const c = storable(raw);
    if (c?.id) byId.set(String(c.id), c);
  }
  if (byId.size === 0) return { written: 0, skipped: 0 };
  const now = new Date();
  const rows = [...byId.values()].map((remote) => {
    const attr = parseAttribution(remote);
    return {
      clientId,
      ghlContactId: String(remote.id),
      firstName: remote.firstName ?? null,
      lastName: remote.lastName ?? null,
      email: remote.email ?? null,
      phone: remote.phone ?? null,
      source: remote.source ?? null,
      utmSource: attr.utmSource,
      utmMedium: attr.utmMedium,
      utmCampaign: attr.utmCampaign,
      utmContent: attr.utmContent,
      utmTerm: attr.utmTerm,
      metaCampaignId: attr.metaCampaignId,
      metaAdsetId: attr.metaAdsetId,
      metaAdId: attr.metaAdId,
      googleCampaignId: attr.googleCampaignId,
      tiktokCampaignId: attr.tiktokCampaignId,
      gclid: attr.gclid,
      ttclid: attr.ttclid,
      fbclid: attr.fbclid,
      facebookLeadId: attr.facebookLeadId,
      tags: extractTags(remote),
      rawAttribution: {
        attributionSource: remote.attributionSource ?? null,
        lastAttributionSource: remote.lastAttributionSource ?? null,
      },
      attributionFetchedAt: now,
      ghlCreatedAt: parseDate(remote.dateAdded),
      updatedAt: now,
    };
  });
  const write = async (batch: typeof rows) =>
    db
      .insert(contacts)
      .values(batch)
      .onConflictDoUpdate({
        target: [contacts.clientId, contacts.ghlContactId],
        set: {
          firstName: keep(contacts.firstName),
          lastName: keep(contacts.lastName),
          email: keep(contacts.email),
          phone: keep(contacts.phone),
          source: keep(contacts.source),
          utmSource: keep(contacts.utmSource),
          utmMedium: keep(contacts.utmMedium),
          utmCampaign: keep(contacts.utmCampaign),
          utmContent: keep(contacts.utmContent),
          utmTerm: keep(contacts.utmTerm),
          metaCampaignId: keep(contacts.metaCampaignId),
          metaAdsetId: keep(contacts.metaAdsetId),
          metaAdId: keep(contacts.metaAdId),
          googleCampaignId: keep(contacts.googleCampaignId),
          tiktokCampaignId: keep(contacts.tiktokCampaignId),
          gclid: keep(contacts.gclid),
          ttclid: keep(contacts.ttclid),
          fbclid: keep(contacts.fbclid),
          facebookLeadId: keep(contacts.facebookLeadId),
          ghlCreatedAt: keep(contacts.ghlCreatedAt),
          // Current GHL state, as the webhook path writes them.
          tags: take(contacts.tags),
          rawAttribution: take(contacts.rawAttribution),
          attributionFetchedAt: take(contacts.attributionFetchedAt),
          updatedAt: take(contacts.updatedAt),
        },
      })
      .returning({ id: contacts.id });
  try {
    return { written: (await write(rows)).length, skipped: 0 };
  } catch (err) {
    if (!refusedValue(err)) throw err;
  }
  // No transaction around contacts: each row is its own statement already.
  const r = await rowByRow(rows, write, (f) => f());
  return { written: r.written.length, skipped: r.skipped };
}

/* ------------------------------------------------------------------ *
 * Opportunities
 * ------------------------------------------------------------------ */

interface StageIndex {
  byGhlId: Map<string, PipelineStage>;
  /** Each pipeline's first stage mapped to New lead — where an intake lands. */
  newLeadByPipeline: Map<string, PipelineStage>;
}

async function stageIndex(clientId: string): Promise<StageIndex> {
  const rows = await db.select().from(pipelineStages).where(eq(pipelineStages.clientId, clientId));
  const newLeadByPipeline = new Map<string, PipelineStage>();
  for (const s of rows) {
    if (s.canonicalStage !== "new_lead" || !s.ghlPipelineId) continue;
    const held = newLeadByPipeline.get(s.ghlPipelineId);
    const order = (x: PipelineStage) => x.displayOrder ?? Number.MAX_SAFE_INTEGER;
    if (!held || order(s) < order(held)) newLeadByPipeline.set(s.ghlPipelineId, s);
  }
  return { byGhlId: new Map(rows.map((s) => [s.ghlStageId, s])), newLeadByPipeline };
}

interface PageResult {
  opportunities: number;
  transitions: number;
  leads: number;
  skipped: number;
}

/**
 * One page of opportunities: link the contacts, upsert the opportunities, then
 * write the intake and snapshot rows — in one transaction, so an
 * opportunity's new state and the ledger rows recording it land together or
 * not at all. When the database refuses a value the page is written again a
 * row at a time, leaving out only what it refuses.
 */
async function importOpportunities(
  clientId: string,
  page: readonly GhlOpportunity[],
  stages: StageIndex,
): Promise<PageResult> {
  const byId = new Map<string, GhlOpportunity>();
  for (const raw of page) {
    const o = storable(raw);
    if (o?.id) byId.set(String(o.id), o);
  }
  const remotes = [...byId.values()];
  if (remotes.length === 0) return { opportunities: 0, transitions: 0, leads: 0, skipped: 0 };
  try {
    return await writeOpportunities(clientId, remotes, stages, false);
  } catch (err) {
    if (!refusedValue(err)) throw err;
    return writeOpportunities(clientId, remotes, stages, true);
  }
}

/**
 * The opportunity fields follow the snapshot's rules, kept from the code this
 * replaced: a value the response lacks never blanks one we hold, and a
 * response older than what we hold never moves the stage pointer back or
 * invents an arrival (the next webhook diffs against what we store).
 */
async function writeOpportunities(
  clientId: string,
  remotes: readonly GhlOpportunity[],
  stages: StageIndex,
  rowAtATime: boolean,
): Promise<PageResult> {
  return db.transaction(async (tx) => {
    const each = async <T, R>(rows: T[], write: (batch: T[]) => Promise<R[]>) =>
      rowAtATime ? rowByRow(rows, write, (f) => tx.transaction(() => f())) : { written: await write(rows), skipped: 0 };

    // Contacts: link the ones we hold, and hold the ones we don't, by id alone.
    const contactIdOf = (o: GhlOpportunity) => o.contactId ?? o.contact?.id ?? null;
    const wanted = [...new Set(remotes.map(contactIdOf).filter((x): x is string => Boolean(x)))];
    const contactRow = new Map<string, string>();
    if (wanted.length > 0) {
      const held = await tx
        .select({ id: contacts.id, ghlContactId: contacts.ghlContactId })
        .from(contacts)
        .where(and(eq(contacts.clientId, clientId), inArray(contacts.ghlContactId, wanted)));
      for (const c of held) contactRow.set(c.ghlContactId, c.id);
      const missing = wanted.filter((id) => !contactRow.has(id));
      if (missing.length > 0) {
        await tx
          .insert(contacts)
          .values(missing.map((ghlContactId) => ({ clientId, ghlContactId })))
          .onConflictDoNothing({ target: [contacts.clientId, contacts.ghlContactId] });
        const added = await tx
          .select({ id: contacts.id, ghlContactId: contacts.ghlContactId })
          .from(contacts)
          .where(and(eq(contacts.clientId, clientId), inArray(contacts.ghlContactId, missing)));
        for (const c of added) contactRow.set(c.ghlContactId, c.id);
      }
    }

    const existing = new Map(
      (
        await tx
          .select()
          .from(opportunities)
          .where(
            and(
              eq(opportunities.clientId, clientId),
              inArray(
                opportunities.ghlOpportunityId,
                remotes.map((o) => String(o.id)),
              ),
            ),
          )
      ).map((o) => [o.ghlOpportunityId, o]),
    );

    const now = new Date();
    const plans = remotes.map((remote) => {
      const stageGhlId = remote.pipelineStageId ?? null;
      const stage = stageGhlId ? stages.byGhlId.get(stageGhlId) : undefined;
      const ghlContactId = contactIdOf(remote);
      const contactId = (ghlContactId ? contactRow.get(ghlContactId) : undefined) ?? null;
      const dated = parseDate(remote.lastStageChangeAt) ?? parseDate(remote.createdAt);
      const changedAt = dated ?? now;
      const held = existing.get(String(remote.id));
      const storedChangedAt = held?.lastStageChangeAt ?? null;
      const isNewer = !storedChangedAt || changedAt.getTime() > storedChangedAt.getTime();
      const values = {
        clientId,
        ghlOpportunityId: String(remote.id),
        contactId: contactId ?? held?.contactId ?? null,
        ghlContactId: ghlContactId ?? held?.ghlContactId ?? null,
        name: remote.name ?? held?.name ?? null,
        ghlPipelineId: remote.pipelineId ?? held?.ghlPipelineId ?? null,
        currentStageId: isNewer ? (stage?.id ?? null) : (held?.currentStageId ?? stage?.id ?? null),
        currentStageGhlId: isNewer ? stageGhlId : (held?.currentStageGhlId ?? stageGhlId),
        status: normalizeStatus(remote.status ?? null) ?? held?.status ?? null,
        monetaryValue: money(remote.monetaryValue) ?? held?.monetaryValue ?? null,
        ghlCreatedAt: parseDate(remote.createdAt) ?? held?.ghlCreatedAt ?? null,
        lastStageChangeAt: isNewer ? changedAt : storedChangedAt,
        updatedAt: now,
      };
      // We hold a later stage change than this read: it says nothing new about where the opportunity is.
      const stale = Boolean(storedChangedAt && changedAt.getTime() < storedChangedAt.getTime());
      return { remote, stage, stageGhlId, contactId: values.contactId, changedAt, dated: Boolean(dated), stale, values };
    });

    const upserted = await each(
      plans.map((p) => p.values),
      async (batch) =>
        tx
          .insert(opportunities)
          .values(batch)
          .onConflictDoUpdate({
            target: [opportunities.clientId, opportunities.ghlOpportunityId],
            set: {
              contactId: take(opportunities.contactId),
              ghlContactId: take(opportunities.ghlContactId),
              name: take(opportunities.name),
              ghlPipelineId: take(opportunities.ghlPipelineId),
              currentStageId: take(opportunities.currentStageId),
              currentStageGhlId: take(opportunities.currentStageGhlId),
              status: take(opportunities.status),
              monetaryValue: take(opportunities.monetaryValue),
              ghlCreatedAt: take(opportunities.ghlCreatedAt),
              lastStageChangeAt: take(opportunities.lastStageChangeAt),
              updatedAt: take(opportunities.updatedAt),
            },
          })
          .returning({ id: opportunities.id, ghlOpportunityId: opportunities.ghlOpportunityId }),
    );
    const rowOf = new Map(upserted.written.map((w) => [w.ghlOpportunityId, w.id]));

    /*
     * What the ledger already holds for each, which decides what to write —
     * never the opportunity row alone: an import cut off between that row and
     * its ledger rows (the old one, killed by the time limit, was) left the
     * row saying "seen" for an arrival the ledger never got.
     *
     * `firstSeen` is when the webhook first WROTE a row for it, not that row's
     * `changed_at`: the live path backdates `changed_at` to GHL's last stage
     * change, so an opportunity first seen in October could look seen at its
     * creation in March — and lose its intake.
     */
    const ids = upserted.written.map((w) => w.id);
    const ledger = new Map(
      ids.length === 0
        ? []
        : (
            await tx
              .select({
                opportunityId: stageTransitions.opportunityId,
                hasLead: sql<boolean>`bool_or(${stageTransitions.toCanonical} = 'new_lead')`,
                firstSeen: sql<Date | null>`min(${stageTransitions.createdAt}) FILTER (WHERE ${stageTransitions.source} = 'webhook')`.mapWith(
                  stageTransitions.createdAt,
                ),
                lastMove: sql<Date | null>`max(${stageTransitions.changedAt}) FILTER (WHERE ${stageTransitions.dedupeKey} NOT LIKE '%:intake:%')`.mapWith(
                  stageTransitions.changedAt,
                ),
              })
              .from(stageTransitions)
              .where(and(eq(stageTransitions.clientId, clientId), inArray(stageTransitions.opportunityId, ids)))
              .groupBy(stageTransitions.opportunityId)
          ).map((r) => [r.opportunityId, { hasLead: Boolean(r.hasLead), firstSeen: r.firstSeen, lastMove: r.lastMove }]),
    );

    const rows: (typeof stageTransitions.$inferInsert)[] = [];
    for (const p of plans) {
      const oppId = rowOf.get(p.values.ghlOpportunityId);
      if (!oppId) continue;
      const known = ledger.get(oppId);

      // Intake: arrival as a lead, when GHL says the opportunity was created.
      const createdAt = parseDate(p.remote.createdAt);
      const pipelineId = p.values.ghlPipelineId ?? p.stage?.ghlPipelineId ?? null;
      const leadStage = pipelineId ? stages.newLeadByPipeline.get(pipelineId) : undefined;
      const sawCreation =
        known?.firstSeen && createdAt ? known.firstSeen.getTime() <= createdAt.getTime() + OBSERVED_SLACK_MS : false;
      const intake = Boolean(createdAt && leadStage && !known?.hasLead && !sawCreation);
      if (intake) {
        rows.push({
          clientId,
          opportunityId: oppId,
          contactId: p.contactId,
          fromStageId: null,
          fromStageGhlId: null,
          fromCanonical: null,
          toStageId: leadStage!.id,
          toStageGhlId: leadStage!.ghlStageId,
          toCanonical: "new_lead",
          changedAt: createdAt!,
          source: "backfill_snapshot",
          // As `scripts/import-gg-ghl.ts` writes it, so the two never double up.
          dedupeKey: `${oppId}:intake:${createdAt!.toISOString()}`,
        });
      }

      /*
       * Snapshot: arrival at the current stage — unless the ledger already
       * records this move or a later one, or the read is older than what we
       * hold. Never a second New lead row: that would count the lead in two
       * months. Undated, it is written only where the ledger has no move at
       * all, or each import would add another at its own "now".
       */
      if (!p.stageGhlId || p.stale) continue;
      if (known?.lastMove && (!p.dated || known.lastMove.getTime() >= p.changedAt.getTime())) continue;
      if (p.stage?.canonicalStage === "new_lead" && (intake || known?.hasLead)) continue;
      rows.push({
        clientId,
        opportunityId: oppId,
        contactId: p.contactId,
        // Deliberately null: we do not know where it came from.
        fromStageId: null,
        fromStageGhlId: null,
        fromCanonical: null,
        toStageId: p.stage?.id ?? null,
        toStageGhlId: p.stageGhlId,
        toCanonical: p.stage?.canonicalStage ?? null,
        changedAt: p.changedAt,
        source: "backfill_snapshot",
        dedupeKey: `${oppId}:${p.stageGhlId}:${p.changedAt.toISOString()}`,
      });
    }

    const inserted =
      rows.length === 0
        ? { written: [], skipped: 0 }
        : await each(rows, async (batch) =>
            tx
              .insert(stageTransitions)
              .values(batch)
              .onConflictDoNothing({ target: stageTransitions.dedupeKey })
              .returning({ dedupeKey: stageTransitions.dedupeKey }),
          );

    return {
      opportunities: upserted.written.length,
      transitions: inserted.written.length,
      leads: inserted.written.filter((r) => r.dedupeKey.includes(":intake:")).length,
      skipped: upserted.skipped + inserted.skipped,
    };
  });
}

/* ------------------------------------------------------------------ *
 * What the operator should know
 * ------------------------------------------------------------------ */

/**
 * The reasons imported history would still not show, from what is stored now
 * — so each is a thing the operator can fix, named where it is fixed.
 *
 * 🔴 None of them says to remap a stage that is already mapped. Turning a
 * mapped stage into New lead relabels every arrival there as a new lead, so an
 * opportunity that came in as a lead elsewhere and moved on to it would count
 * as a lead twice. The notes name what is missing and leave which stage it is
 * to the operator.
 */
async function importNotes(clientId: string, totals: HistoryTotals, stages: StageIndex): Promise<string[]> {
  const notes: string[] = [];
  const fmt = (n: number) => n.toLocaleString("en-US");
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  if (totals.skipped > 0) {
    notes.push(
      `${fmt(totals.skipped)} ${plural(totals.skipped, "record", "records")} couldn't be saved — GoHighLevel sent values the database can't store — and ${plural(totals.skipped, "was", "were")} left out.`,
    );
  }

  // Opportunities held, per pipeline, and how many sit in a stage nobody has mapped.
  const held = (
    await db
      .select({
        pipeline: opportunities.ghlPipelineId,
        n: sql<number>`count(*)::int`,
        unmapped: sql<number>`(count(*) FILTER (WHERE ${pipelineStages.canonicalStage} IS NULL))::int`,
      })
      .from(opportunities)
      .leftJoin(pipelineStages, eq(pipelineStages.id, opportunities.currentStageId))
      .where(eq(opportunities.clientId, clientId))
      .groupBy(opportunities.ghlPipelineId)
  )
    .map((r) => ({ pipeline: r.pipeline, n: Number(r.n), unmapped: Number(r.unmapped) }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const opps = held.reduce((sum, r) => sum + r.n, 0);

  if (opps === 0) {
    if (totals.contacts > 0) {
      notes.push(
        `GoHighLevel holds ${fmt(totals.contacts)} contacts for this sub-account but no pipeline opportunities. ` +
          "The dashboard counts a lead when an opportunity enters a stage mapped to New lead, so these contacts don't show as leads.",
      );
    }
    return notes;
  }

  const pipelines = new Map<string, { name: string | null; mapped: number }>();
  for (const s of stages.byGhlId.values()) {
    if (!s.ghlPipelineId) continue;
    const p = pipelines.get(s.ghlPipelineId) ?? { name: s.ghlPipelineName ?? null, mapped: 0 };
    if (s.canonicalStage) p.mapped++;
    pipelines.set(s.ghlPipelineId, p);
  }
  const mappedIn = (id: string | null) => (id ? (pipelines.get(id)?.mapped ?? 0) : 0);
  const named = (rows: typeof held) =>
    rows
      .slice(0, 3)
      .map((r) => `“${(r.pipeline && pipelines.get(r.pipeline)?.name) || "an unlisted pipeline"}” (${fmt(r.n)})`)
      .join(", ") + (rows.length > 3 ? `, and ${rows.length - 3} more` : "");

  if (![...pipelines.values()].some((p) => p.mapped > 0)) {
    notes.push(
      `No pipeline stages are mapped yet, so ${plural(opps, "the imported opportunity isn't", `the ${fmt(opps)} imported opportunities aren't`)} on the dashboard. ` +
        "Map them under Map pipeline stages — the stage new leads arrive in as New lead — then import again.",
    );
    return notes;
  }

  if (stages.newLeadByPipeline.size === 0) {
    notes.push(
      `No stage is mapped to New lead, so ${plural(opps, "the imported opportunity doesn't count as a lead", `none of the ${fmt(opps)} imported opportunities count as leads`)}. ` +
        "Under Map pipeline stages, map the stage new leads arrive in to New lead, then import again.",
    );
  } else {
    // Mapped, but with nowhere for a lead to arrive: in the funnel, never as leads.
    const unled = held.filter((r) => r.pipeline && mappedIn(r.pipeline) > 0 && !stages.newLeadByPipeline.has(r.pipeline));
    if (unled.length > 0) {
      const one = unled.length === 1;
      notes.push(
        `${named(unled)} ${one ? "has" : "have"} no stage mapped to New lead, so ${one ? "its" : "their"} opportunities count in their stages but not as leads. ` +
          `If new leads arrive in ${one ? "it" : "one of them"}, map the stage they arrive in to New lead, then import again.`,
      );
    }
  }

  const blank = held.filter((r) => mappedIn(r.pipeline) === 0);
  if (blank.length > 0) {
    const one = blank.length === 1;
    notes.push(
      `${named(blank)} ${one ? "has" : "have"} no stages mapped, so ${one ? "its" : "their"} opportunities aren't on the dashboard. ` +
        `Map ${one ? "its" : "their"} stages under Map pipeline stages if ${one ? "it" : "they"} should be, then import again.`,
    );
  }

  // In a mapped pipeline, but parked in a stage nobody mapped: remapping relabels them, no import needed.
  const waiting = held.filter((r) => mappedIn(r.pipeline) > 0).reduce((sum, r) => sum + r.unmapped, 0);
  if (waiting > 0) {
    notes.push(
      `${fmt(waiting)} ${plural(waiting, "opportunity sits in a stage that isn't", "opportunities sit in stages that aren't")} mapped yet, so the stage ${plural(waiting, "it is", "they are")} in now doesn't count. ` +
        `Map ${plural(waiting, "it", "those stages")} under Map pipeline stages — no need to import again.`,
    );
  }
  return notes;
}
