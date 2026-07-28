/**
 * One-off backfill: import Facebook-ad leads for the "gg-ads" client from the
 * Growth Guild Sales Pipeline in GoHighLevel.
 *
 * Run:
 *   GHL_TOKEN=pit-xxxx npx tsx --env-file=.env.local scripts/import-gg-ghl.ts
 *
 * What it does, idempotently (safe to re-run):
 *   1. Fixes the two broken GG stage mappings (In Conversation, Sale Closed).
 *   2. Sets the client's paid-lead tag to `metaadsleads`.
 *   3. Builds a normalize(name) -> {id,status} map from the Meta ad account.
 *   4. Pulls every GG-pipeline opportunity + its contact's attribution/tags.
 *   5. Classifies FB leads (attribution campaign matches a Meta campaign OR the
 *      metaadsleads tag) and upserts contacts + opportunities.
 *   6. Writes the append-only snapshot ledger: a new_lead intake transition at
 *      createdAt, plus a current-stage snapshot at lastStageChangeAt.
 */
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import {
  clients,
  pipelineStages,
  contacts,
  opportunities,
  stageTransitions,
} from "../src/db/schema";

const GHL_TOKEN = process.env.GHL_TOKEN;
const LOC = "XNlkPjklm0Sx1PwaTs6k";
const GG_PIPELINE = "YmHhybHqlzTCqIHm6chh";
const AD_ACCOUNT = "act_1259255795874625";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

const META_TOKEN = process.env.META_SYSTEM_USER_TOKEN!;
const META_SECRET = process.env.META_APP_SECRET!;
const META_V = process.env.META_API_VERSION || "v25.0";

if (!GHL_TOKEN) throw new Error("GHL_TOKEN env var is required");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const normName = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

async function ghl<T>(path: string): Promise<T> {
  const url = `https://services.leadconnectorhq.com${path}`;
  for (let a = 0; a < 5; a++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GHL_TOKEN}`,
        Version: "2021-07-28",
        Accept: "application/json",
        "User-Agent": UA,
      },
    });
    if (res.ok) return (await res.json()) as T;
    if ([429, 500, 502, 503].includes(res.status)) {
      await sleep(1200 * (a + 1));
      continue;
    }
    throw new Error(`GHL ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`GHL retries exhausted on ${path}`);
}

async function ghlPost<T>(path: string, body: unknown): Promise<T> {
  const url = `https://services.leadconnectorhq.com${path}`;
  for (let a = 0; a < 5; a++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GHL_TOKEN}`,
        Version: "2021-07-28",
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": UA,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as T;
    if ([429, 500, 502, 503].includes(res.status)) {
      await sleep(1200 * (a + 1));
      continue;
    }
    throw new Error(`GHL POST ${res.status} on ${path}`);
  }
  throw new Error(`GHL POST retries exhausted on ${path}`);
}

async function metaCampaigns(): Promise<
  Map<string, { id: string; name: string; status: string }>
> {
  const proof = crypto
    .createHmac("sha256", META_SECRET)
    .update(META_TOKEN)
    .digest("hex");
  const params = new URLSearchParams({
    fields: "id,name,effective_status",
    limit: "200",
    access_token: META_TOKEN,
    appsecret_proof: proof,
  });
  const res = await fetch(
    `https://graph.facebook.com/${META_V}/${AD_ACCOUNT}/campaigns?${params}`,
  );
  if (!res.ok) throw new Error(`Meta campaigns ${res.status}`);
  const data = (await res.json()) as {
    data: Array<{ id: string; name: string; effective_status: string }>;
  };
  const map = new Map<string, { id: string; name: string; status: string }>();
  for (const c of data.data) {
    map.set(normName(c.name), {
      id: c.id,
      name: c.name,
      status: c.effective_status,
    });
  }
  return map;
}

// Simple concurrency pool.
async function pool<T, R>(
  items: T[],
  size: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

interface Opp {
  id: string;
  contactId?: string;
  contact?: { id?: string };
  name?: string;
  pipelineStageId?: string;
  status?: string;
  monetaryValue?: number;
  createdAt?: string;
  lastStageChangeAt?: string;
}

interface Att {
  campaign?: string;
  utmCampaign?: string;
  utmSource?: string;
  utmMedium?: string;
  utmContent?: string;
  utmTerm?: string;
  fbclid?: string;
  adId?: string;
  adGroupId?: string;
  [k: string]: unknown;
}

async function main() {
  // 1. resolve client
  const [client] = await db.select().from(clients).where(eq(clients.slug, "gg-ads"));
  if (!client) throw new Error("gg-ads client not found");
  console.log(`Client: ${client.slug} (${client.id})`);

  // 2. fix the two broken GG mappings
  const fixes: Array<[string, "contacted" | "closed_won"]> = [
    ["f714d583-0ca3-476d-b871-1b723265903b", "contacted"], // In Conversation
    ["1d8fc3cf-4ed8-4871-9936-7abb83737736", "closed_won"], // Sale Closed
  ];
  for (const [ghlStageId, canonical] of fixes) {
    await db
      .update(pipelineStages)
      .set({ canonicalStage: canonical })
      .where(
        and(
          eq(pipelineStages.clientId, client.id),
          eq(pipelineStages.ghlStageId, ghlStageId),
        ),
      );
  }
  console.log("Fixed GG stage mappings (In Conversation→contacted, Sale Closed→closed_won)");

  // 3. set paid-lead tag
  await db
    .update(clients)
    .set({ paidLeadTag: "metaadsleads", paidLeadFilter: "either" })
    .where(eq(clients.id, client.id));

  // stage map: ghlStageId -> {rowId, canonical}
  const stageRows = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.clientId, client.id));
  const stageByGhl = new Map(stageRows.map((s) => [s.ghlStageId, s]));
  const NEW_LEAD_GHL = "9cae3ba5-66ae-4fc5-874f-ccd41698a053"; // GG "New Lead"

  // 4. Meta campaign map
  const camp = await metaCampaigns();
  console.log(`Meta campaigns loaded: ${camp.size}`);

  // 5. fetch all GG opps
  const opps: Opp[] = [];
  for (let page = 1; page <= 30; page++) {
    const d = await ghl<{ opportunities?: Opp[] }>(
      `/opportunities/search?location_id=${LOC}&pipeline_id=${GG_PIPELINE}&limit=100&page=${page}&status=all`,
    );
    const batch = d.opportunities ?? [];
    if (batch.length === 0) break;
    opps.push(...batch);
    if (batch.length < 100) break;
  }
  console.log(`GG opportunities fetched: ${opps.length}`);

  // 6. fetch each opp's contact (attribution + tags)
  let fetched = 0;
  const contactCache = new Map<string, Record<string, unknown>>();
  const cids = [
    ...new Set(opps.map((o) => o.contactId ?? o.contact?.id).filter(Boolean) as string[]),
  ];
  await pool(cids, 8, async (cid) => {
    try {
      const d = await ghl<{ contact?: Record<string, unknown> }>(`/contacts/${cid}`);
      if (d.contact) contactCache.set(cid, d.contact);
    } catch {
      /* leave uncached; treated as non-FB */
    }
    if (++fetched % 200 === 0) console.log(`  contacts fetched: ${fetched}/${cids.length}`);
  });
  console.log(`Contacts fetched: ${contactCache.size}/${cids.length}`);

  // 7. classify + upsert
  const byCampaign = new Map<string, { name: string; status: string; leads: number }>();
  const byStage = new Map<string, number>();
  const byMonth = new Map<string, number>();
  let fbCount = 0;
  let taggedNoCampaign = 0;
  let transitionsWritten = 0;

  for (const o of opps) {
    const cid = o.contactId ?? o.contact?.id ?? null;
    const contact = cid ? contactCache.get(cid) : undefined;
    const att = (contact?.attributionSource ?? {}) as Att;
    const tags = Array.isArray(contact?.tags)
      ? (contact!.tags as string[]).map((t) => String(t).toLowerCase())
      : [];

    const campName = att.campaign || att.utmCampaign || null;
    const match = campName ? camp.get(normName(campName)) : undefined;
    const isTagged = tags.includes("metaadsleads");
    const isFb = Boolean(match) || isTagged;
    if (!isFb) continue;
    fbCount++;

    const metaCampaignId = match?.id ?? null;
    if (metaCampaignId) {
      const e = byCampaign.get(metaCampaignId) ?? {
        name: match!.name,
        status: match!.status,
        leads: 0,
      };
      e.leads++;
      byCampaign.set(metaCampaignId, e);
    } else {
      taggedNoCampaign++;
    }

    const stage = o.pipelineStageId ? stageByGhl.get(o.pipelineStageId) : undefined;
    byStage.set(stage?.ghlStageName ?? "?", (byStage.get(stage?.ghlStageName ?? "?") ?? 0) + 1);
    const createdAt = o.createdAt ? new Date(o.createdAt) : new Date();
    byMonth.set(o.createdAt?.slice(0, 7) ?? "?", (byMonth.get(o.createdAt?.slice(0, 7) ?? "?") ?? 0) + 1);

    // upsert contact
    let contactRowId: string | null = null;
    if (cid) {
      const cVals = {
        clientId: client.id,
        ghlContactId: cid,
        firstName: (contact?.firstNameRaw as string) ?? (contact?.firstName as string) ?? null,
        lastName: (contact?.lastNameRaw as string) ?? (contact?.lastName as string) ?? null,
        email: (contact?.email as string) ?? null,
        phone: (contact?.phone as string) ?? null,
        source: (contact?.source as string) ?? null,
        utmSource: att.utmSource ?? null,
        utmMedium: att.utmMedium ?? null,
        utmCampaign: campName,
        utmContent: att.utmContent ?? null,
        utmTerm: att.utmTerm ?? null,
        metaCampaignId,
        metaAdId: att.adId ?? null,
        metaAdsetId: att.adGroupId ?? null,
        fbclid: att.fbclid ?? null,
        tags,
        rawAttribution: att as Record<string, unknown>,
        attributionFetchedAt: new Date(),
        ghlCreatedAt: contact?.dateAdded ? new Date(contact.dateAdded as string) : createdAt,
        updatedAt: new Date(),
      };
      const [row] = await db
        .insert(contacts)
        .values(cVals)
        .onConflictDoUpdate({
          target: [contacts.clientId, contacts.ghlContactId],
          set: cVals,
        })
        .returning({ id: contacts.id });
      contactRowId = row?.id ?? null;
    }

    // upsert opportunity
    const changedAt = o.lastStageChangeAt ? new Date(o.lastStageChangeAt) : createdAt;
    const status =
      o.status && ["open", "won", "lost", "abandoned"].includes(o.status.toLowerCase())
        ? (o.status.toLowerCase() as "open" | "won" | "lost" | "abandoned")
        : null;
    const oVals = {
      clientId: client.id,
      ghlOpportunityId: o.id,
      contactId: contactRowId,
      ghlContactId: cid,
      name: o.name ?? null,
      ghlPipelineId: GG_PIPELINE,
      currentStageId: stage?.id ?? null,
      currentStageGhlId: o.pipelineStageId ?? null,
      status,
      monetaryValue: typeof o.monetaryValue === "number" ? String(o.monetaryValue) : null,
      ghlCreatedAt: createdAt,
      lastStageChangeAt: changedAt,
      updatedAt: new Date(),
    };
    const [opp] = await db
      .insert(opportunities)
      .values(oVals)
      .onConflictDoUpdate({
        target: [opportunities.clientId, opportunities.ghlOpportunityId],
        set: oVals,
      })
      .returning({ id: opportunities.id });
    if (!opp) continue;

    // 8. ledger — intake at createdAt (always), current-stage snapshot if different
    const intakeStage = stageByGhl.get(NEW_LEAD_GHL);
    const intakeTransitions: (typeof stageTransitions.$inferInsert)[] = [
      {
        clientId: client.id,
        opportunityId: opp.id,
        contactId: contactRowId,
        fromStageId: null,
        fromStageGhlId: null,
        fromCanonical: null,
        toStageId: intakeStage?.id ?? null,
        toStageGhlId: NEW_LEAD_GHL,
        toCanonical: "new_lead" as const,
        changedAt: createdAt,
        source: "backfill_snapshot" as const,
        dedupeKey: `${opp.id}:intake:${createdAt.toISOString()}`,
      },
    ];
    // current stage snapshot, only when it is not itself new_lead (avoid dup)
    if (stage && stage.canonicalStage && stage.canonicalStage !== "new_lead") {
      intakeTransitions.push({
        clientId: client.id,
        opportunityId: opp.id,
        contactId: contactRowId,
        fromStageId: null,
        fromStageGhlId: null,
        fromCanonical: null,
        toStageId: stage.id,
        toStageGhlId: stage.ghlStageId,
        toCanonical: stage.canonicalStage,
        changedAt,
        source: "backfill_snapshot" as const,
        dedupeKey: `${opp.id}:${stage.ghlStageId}:${changedAt.toISOString()}`,
      });
    }
    for (const t of intakeTransitions) {
      const ins = await db
        .insert(stageTransitions)
        .values(t)
        .onConflictDoNothing({ target: stageTransitions.dedupeKey })
        .returning({ id: stageTransitions.id });
      if (ins.length) transitionsWritten++;
    }
  }

  // report
  console.log("\n========== IMPORT SUMMARY ==========");
  console.log(`FB leads imported: ${fbCount}  (of ${opps.length} GG opps)`);
  console.log(`  attributed to a Meta campaign: ${fbCount - taggedNoCampaign}`);
  console.log(`  tag-only (no campaign match):  ${taggedNoCampaign}`);
  console.log(`stage_transitions written: ${transitionsWritten}`);
  console.log("\nBy campaign:");
  for (const [id, e] of [...byCampaign.entries()].sort((a, b) => b[1].leads - a[1].leads)) {
    console.log(`  ${e.leads.toString().padStart(4)}  [${e.status}] ${id}  ${e.name}`);
  }
  console.log("\nBy current stage:");
  for (const [s, n] of [...byStage.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${s}`);
  }
  console.log("\nBy month (intake):");
  for (const [m, n] of [...byMonth.entries()].sort()) {
    console.log(`  ${m}: ${n}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
