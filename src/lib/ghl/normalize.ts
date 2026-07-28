import type { NormalizedOpportunityEvent } from "./types";

/**
 * Pull the fields we need out of whichever payload shape arrived.
 *
 * Two senders, two shapes:
 *
 *  (a) Marketplace app webhooks — flat camelCase: `id`, `pipelineStageId`,
 *      `contactId`, `locationId`.
 *  (b) Workflow → Webhook (Outbound) — the workflow's contact context. Mostly
 *      snake_case, sometimes nests under `opportunity`/`location`, and the key
 *      set shifts with the trigger type.
 *
 * Rather than branch on sender, we probe an ordered list of candidate paths per
 * field and take the first that yields a value. This keeps working when GHL
 * changes a key spelling, which is a documented hazard here — GHL's own payload
 * has historically shipped a misspelled `pipleine_stage_id`, which is included
 * below deliberately, not by accident.
 */

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a dotted path, tolerating missing intermediates. */
function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function firstString(obj: unknown, paths: string[]): string | null {
  for (const p of paths) {
    const v = at(obj, p);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function firstNumber(obj: unknown, paths: string[]): number | null {
  for (const p of paths) {
    const v = at(obj, p);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

export function normalizeWebhookPayload(
  payload: unknown,
): NormalizedOpportunityEvent {
  const eventType = firstString(payload, [
    "type",
    "eventType",
    "event_type",
    "webhookType",
  ]);

  /*
   * The top-level `id` is overloaded: on an opportunity webhook it is the
   * OPPORTUNITY id, but on a ContactCreate/ContactUpdate webhook it is the
   * CONTACT id. Letting `opportunityId` fall back to `id` on a contact event
   * mis-keyed the row as an opportunity, so the event took the opportunity
   * branch, bailed on the missing stage id, and the contact/attribution
   * enrichment never ran. Route `id` to the correct field based on the type.
   */
  const isContactEvent =
    /contact/i.test(eventType ?? "") && !/opportunit/i.test(eventType ?? "");

  return {
    eventType,

    locationId: firstString(payload, [
      "locationId",
      "location_id",
      "location.id",
      "companyId",
    ]),

    opportunityId: firstString(payload, [
      "opportunityId",
      "opportunity_id",
      "opportunity.id",
      "opportunity._id",
      // Only trust top-level `id` as the opportunity when this is NOT a
      // contact-typed event.
      ...(isContactEvent ? [] : ["id"]),
    ]),

    contactId: firstString(payload, [
      "contactId",
      "contact_id",
      "contact.id",
      "opportunity.contactId",
      "opportunity.contact_id",
      // On a contact event, top-level `id` IS the contact.
      ...(isContactEvent ? ["id"] : []),
    ]),

    pipelineId: firstString(payload, [
      "pipelineId",
      "pipeline_id",
      "opportunity.pipelineId",
      "opportunity.pipeline_id",
      "pipeline.id",
    ]),

    pipelineStageId: firstString(payload, [
      "pipelineStageId",
      "pipeline_stage_id",
      "opportunity.pipelineStageId",
      "opportunity.pipeline_stage_id",
      "pipelineStage.id",
      // GHL has shipped this misspelling in workflow payloads. Intentional.
      "pipleine_stage_id",
      "pipleine_stage",
    ]),

    name: firstString(payload, [
      "name",
      "opportunity.name",
      "opportunity_name",
      "title",
    ]),

    status: firstString(payload, [
      "status",
      "opportunity.status",
      "opportunity_status",
    ]),

    monetaryValue: firstNumber(payload, [
      "monetaryValue",
      "monetary_value",
      "opportunity.monetaryValue",
      "opportunity.monetary_value",
      "value",
    ]),

    source: firstString(payload, ["source", "opportunity.source"]),

    /** The opportunity's CREATION date — never the time of this event. */
    dateAdded: firstString(payload, [
      "dateAdded",
      "date_added",
      "opportunity.createdAt",
      "createdAt",
    ]),

    envelopeTimestamp: firstString(payload, [
      "timestamp",
      "webhookPayload.timestamp",
      "eventTimestamp",
      "event_timestamp",
    ]),
  };
}

/** GHL statuses map 1:1 to our enum; anything unrecognised becomes null. */
export function normalizeStatus(
  status: string | null,
): "open" | "won" | "lost" | "abandoned" | null {
  if (!status) return null;
  const s = status.toLowerCase().trim();
  if (s === "open" || s === "won" || s === "lost" || s === "abandoned") return s;
  return null;
}

/** Tolerant date parse — returns null rather than an Invalid Date. */
export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
