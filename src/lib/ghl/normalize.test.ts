import { describe, it, expect } from "vitest";
import { normalizeWebhookPayload, normalizeStatus, parseDate } from "./normalize";

/**
 * Reading whichever payload shape GHL happened to send.
 *
 * ── Why this one is worth being thorough about ────────────────────────
 *
 * It is the first thing that touches an inbound webhook, and webhooks are the
 * only source of the one dataset in this system that cannot be rebuilt: GHL has
 * no stage-transition history API, so a transition we fail to read is gone
 * permanently. A field this function returns as null does not raise an error —
 * it makes the event bail quietly a few steps later, and the day's funnel
 * history is simply absent.
 *
 * Two senders send two shapes (flat camelCase from the marketplace app,
 * shifting snake_case from workflow webhooks), so every field probes an ordered
 * list of candidate paths. That design is only safe if the ORDER is right and
 * the fallbacks do not fire when they shouldn't — which is exactly what these
 * assert.
 */

/** A marketplace-app opportunity webhook: flat, camelCase. */
const appEvent = {
  type: "OpportunityStageUpdate",
  id: "opp_ABCDEFGH1234567890",
  locationId: "loc_1234567890ABCDEF",
  contactId: "con_1234567890ABCDEF",
  pipelineId: "pip_1234567890ABCDEF",
  pipelineStageId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  name: "Jane Doe",
  status: "open",
  monetaryValue: 2500,
  dateAdded: "2026-07-01T10:00:00.000Z",
};

describe("normalizeWebhookPayload — the marketplace shape", () => {
  it("reads a flat camelCase opportunity event", () => {
    const n = normalizeWebhookPayload(appEvent);

    expect(n.opportunityId).toBe("opp_ABCDEFGH1234567890");
    expect(n.contactId).toBe("con_1234567890ABCDEF");
    expect(n.pipelineStageId).toBe("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    expect(n.monetaryValue).toBe(2500);
    expect(n.eventType).toBe("OpportunityStageUpdate");
  });
});

describe("normalizeWebhookPayload — the workflow shape", () => {
  it("reads snake_case keys", () => {
    const n = normalizeWebhookPayload({
      event_type: "opportunity_stage_changed",
      opportunity_id: "opp_1",
      location_id: "loc_1",
      contact_id: "con_1",
      pipeline_id: "pip_1",
      pipeline_stage_id: "stage-uuid",
      monetary_value: "1750.50",
    });

    expect(n.opportunityId).toBe("opp_1");
    expect(n.pipelineStageId).toBe("stage-uuid");
    // Workflow payloads send numbers as strings.
    expect(n.monetaryValue).toBe(1750.5);
  });

  it("reads values nested under `opportunity` and `location`", () => {
    const n = normalizeWebhookPayload({
      type: "OpportunityUpdate",
      location: { id: "loc_nested" },
      opportunity: {
        id: "opp_nested",
        contactId: "con_nested",
        pipelineStageId: "stage_nested",
        monetaryValue: 99,
        status: "won",
      },
    });

    expect(n.locationId).toBe("loc_nested");
    expect(n.opportunityId).toBe("opp_nested");
    expect(n.contactId).toBe("con_nested");
    expect(n.pipelineStageId).toBe("stage_nested");
    expect(n.status).toBe("won");
  });

  it("🔴 honours GHL's shipped misspelling of the stage key", () => {
    /*
     * `pipleine_stage_id` is in the candidate list on purpose, not by accident.
     * GHL has shipped this typo in workflow payloads, and without it the stage
     * id reads null — the event bails, and that transition is unrecoverable.
     */
    const n = normalizeWebhookPayload({
      type: "opportunity_stage_changed",
      opportunity_id: "opp_1",
      pipleine_stage_id: "stage-typo",
    });
    expect(n.pipelineStageId).toBe("stage-typo");
  });

  it("prefers the correctly-spelled key when both are present", () => {
    const n = normalizeWebhookPayload({
      pipeline_stage_id: "correct",
      pipleine_stage_id: "typo",
    });
    // Order matters: the typo is a last resort, never a winner.
    expect(n.pipelineStageId).toBe("correct");
  });
});

/* ------------------------------------------------------------------ *
 * The overloaded top-level `id`
 * ------------------------------------------------------------------ */

describe("normalizeWebhookPayload — `id` means different things", () => {
  it("🔴 treats top-level `id` as the OPPORTUNITY on an opportunity event", () => {
    const n = normalizeWebhookPayload({ type: "OpportunityCreate", id: "opp_1" });
    expect(n.opportunityId).toBe("opp_1");
    expect(n.contactId).toBeNull();
  });

  it("🔴 treats top-level `id` as the CONTACT on a contact event", () => {
    /*
     * The bug this prevents: letting `opportunityId` fall back to `id` on a
     * ContactCreate mis-keyed the row as an opportunity, so the event took the
     * opportunity branch, bailed on the missing stage id, and the contact and
     * attribution enrichment never ran — losing the campaign id that makes paid
     * CPL meaningful.
     */
    for (const type of ["ContactCreate", "ContactUpdate", "contact_create"]) {
      const n = normalizeWebhookPayload({ type, id: "con_1" });
      expect(n.contactId).toBe("con_1");
      expect(n.opportunityId).toBeNull();
    }
  });

  it("🔴 an event naming BOTH is treated as an opportunity event", () => {
    // The guard is `contact` AND NOT `opportunit`, so a type mentioning both
    // keeps `id` on the opportunity — which is what such a payload means.
    const n = normalizeWebhookPayload({
      type: "OpportunityContactUpdate",
      id: "opp_1",
      contactId: "con_1",
    });
    expect(n.opportunityId).toBe("opp_1");
    expect(n.contactId).toBe("con_1");
  });

  it("falls back to the opportunity reading when there is no type at all", () => {
    // Workflow payloads do not always carry one. Opportunity is the right
    // default: it is the shape that carries a stage id, which is the whole
    // reason we are listening.
    const n = normalizeWebhookPayload({ id: "opp_1", pipeline_stage_id: "s1" });
    expect(n.opportunityId).toBe("opp_1");
    expect(n.eventType).toBeNull();
  });

  it("an explicit id always beats the top-level one", () => {
    const n = normalizeWebhookPayload({
      type: "OpportunityUpdate",
      id: "top_level",
      opportunityId: "explicit",
    });
    expect(n.opportunityId).toBe("explicit");
  });
});

/* ------------------------------------------------------------------ *
 * Value coercion
 * ------------------------------------------------------------------ */

describe("normalizeWebhookPayload — coercion", () => {
  it("🔴 stringifies numeric ids rather than dropping them", () => {
    // A sender that sends an id as a JSON number must not produce a null id —
    // that would silently discard the event.
    const n = normalizeWebhookPayload({ type: "OpportunityUpdate", id: 12345 });
    expect(n.opportunityId).toBe("12345");
  });

  it("trims whitespace and skips blank candidates", () => {
    const n = normalizeWebhookPayload({
      opportunityId: "   ",
      opportunity_id: "  opp_real  ",
    });
    // A whitespace-only value is not a value; it must fall through to the next
    // candidate rather than winning as an empty id.
    expect(n.opportunityId).toBe("opp_real");
  });

  it("reads a numeric monetary value from either a number or a string", () => {
    expect(normalizeWebhookPayload({ monetaryValue: 0 }).monetaryValue).toBe(0);
    expect(normalizeWebhookPayload({ monetary_value: "42.5" }).monetaryValue).toBe(42.5);
    expect(normalizeWebhookPayload({ value: "1000" }).monetaryValue).toBe(1000);
  });

  it("🔴 keeps a zero monetary value rather than treating it as absent", () => {
    // 0 is a real deal value. Falling through on it would pick up a stale
    // amount from a later candidate path.
    const n = normalizeWebhookPayload({ monetaryValue: 0, value: 9999 });
    expect(n.monetaryValue).toBe(0);
  });

  it("rejects unparseable and non-finite numbers", () => {
    expect(normalizeWebhookPayload({ monetaryValue: "abc" }).monetaryValue).toBeNull();
    expect(normalizeWebhookPayload({ monetaryValue: NaN }).monetaryValue).toBeNull();
    expect(normalizeWebhookPayload({ monetaryValue: Infinity }).monetaryValue).toBeNull();
    expect(normalizeWebhookPayload({ monetaryValue: "" }).monetaryValue).toBeNull();
  });

  it("does not mistake a nested object for a scalar", () => {
    const n = normalizeWebhookPayload({ status: { value: "won" } });
    expect(n.status).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Robustness — the receiver must never throw
 * ------------------------------------------------------------------ */

describe("normalizeWebhookPayload — hostile and malformed input", () => {
  it("🔴 returns all-nulls instead of throwing", () => {
    /*
     * The receiver persists the raw payload and returns 200 fast, precisely so
     * a parse failure cannot cause GHL to retry-storm us. A throw here would
     * defeat that, turning one malformed event into a dozen redeliveries.
     */
    for (const junk of [null, undefined, "", "a string", 42, [], [1, 2, 3], true]) {
      const n = normalizeWebhookPayload(junk);
      expect(n.opportunityId).toBeNull();
      expect(n.pipelineStageId).toBeNull();
      expect(n.monetaryValue).toBeNull();
    }
  });

  it("tolerates a path whose intermediate is missing or the wrong type", () => {
    expect(normalizeWebhookPayload({ opportunity: null }).opportunityId).toBeNull();
    expect(normalizeWebhookPayload({ opportunity: "nope" }).opportunityId).toBeNull();
    expect(normalizeWebhookPayload({ opportunity: [] }).opportunityId).toBeNull();
  });

  it("🔴 reads only from its own closed list of paths", () => {
    /*
     * The candidate paths are hardcoded, so a payload cannot steer where `at()`
     * looks — which is what makes walking dotted paths over untrusted JSON safe
     * here. Asserted by feeding a payload made entirely of plausible-looking
     * keys that are NOT on the list: every field must come back null rather
     * than something being picked up by resemblance.
     */
    const n = normalizeWebhookPayload({
      oppId: "nope",
      stageId: "nope",
      opportunity_stage: "nope",
      contact: { identifier: "nope" },
    });

    expect(n.opportunityId).toBeNull();
    expect(n.contactId).toBeNull();
    expect(n.pipelineStageId).toBeNull();
  });

  it("🔴 reads OWN properties only, never the prototype chain", () => {
    /*
     * An object literal's `__proto__` key really does set the prototype, so
     * this payload inherits `opportunityId`. `at()` must not see it.
     *
     * Production cannot construct this — the payload arrives via `JSON.parse`,
     * where `__proto__` is an ordinary own key and the prototype is left alone
     * (asserted below, because that fact is the whole reason this was never a
     * live vulnerability). The guard exists so the module's safety does not
     * depend on nothing else in the process polluting `Object.prototype`, given
     * the field names probed here are exactly the generic ones such an attack
     * would set.
     */
    const polluted = { __proto__: { opportunityId: "injected", name: "injected" } };
    const n = normalizeWebhookPayload(polluted);
    expect(n.opportunityId).toBeNull();
    expect(n.name).toBeNull();

    const viaJson = JSON.parse('{"__proto__": {"opportunityId": "injected"}}');
    expect(Object.getPrototypeOf(viaJson)).toBe(Object.prototype);
    expect(normalizeWebhookPayload(viaJson).opportunityId).toBeNull();
  });

  it("returns every field of the interface, always", () => {
    const n = normalizeWebhookPayload({});
    for (const k of [
      "eventType", "locationId", "opportunityId", "contactId", "pipelineId",
      "pipelineStageId", "name", "status", "monetaryValue", "source",
      "dateAdded", "envelopeTimestamp",
    ]) {
      expect(n).toHaveProperty(k);
    }
  });
});

/* ------------------------------------------------------------------ *
 * dateAdded — the field most likely to be misread
 * ------------------------------------------------------------------ */

describe("normalizeWebhookPayload — timestamps", () => {
  it("🔴 dateAdded is the opportunity's CREATION date, not this event's time", () => {
    /*
     * The single most consequential misreading available here. GHL's
     * opportunity webhook carries no event timestamp at all — `dateAdded` is
     * when the opportunity was created. Using it as the transition time would
     * stamp every stage change with the lead's creation date, collapsing a
     * month of funnel history onto whichever day the lead arrived.
     */
    const n = normalizeWebhookPayload({
      ...appEvent,
      dateAdded: "2026-07-01T10:00:00.000Z",
      timestamp: "2026-07-20T18:30:00.000Z",
    });

    expect(n.dateAdded).toBe("2026-07-01T10:00:00.000Z");
    // The envelope time is kept separately, never conflated with it.
    expect(n.envelopeTimestamp).toBe("2026-07-20T18:30:00.000Z");
  });
});

/* ------------------------------------------------------------------ *
 * normalizeStatus / parseDate
 * ------------------------------------------------------------------ */

describe("normalizeStatus", () => {
  it("maps the four known statuses, case- and space-insensitively", () => {
    for (const [input, expected] of [
      ["open", "open"], ["WON", "won"], ["  Lost ", "lost"], ["Abandoned", "abandoned"],
    ] as const) {
      expect(normalizeStatus(input)).toBe(expected);
    }
  });

  it("🔴 returns null for anything unrecognised rather than passing it through", () => {
    // The column is a Postgres enum; an unmapped string throws on write and
    // loses the event.
    for (const junk of ["", "  ", "closed", "OPEN_DEAL", "win", null]) {
      expect(normalizeStatus(junk)).toBeNull();
    }
  });
});

describe("parseDate", () => {
  it("parses an ISO timestamp", () => {
    expect(parseDate("2026-07-20T18:30:00.000Z")?.toISOString()).toBe(
      "2026-07-20T18:30:00.000Z",
    );
  });

  it("🔴 returns null instead of an Invalid Date", () => {
    /*
     * An Invalid Date is truthy and only reveals itself when written — as
     * `RangeError` from the driver, mid-transaction, taking the whole event
     * with it.
     */
    for (const junk of ["", null, undefined, "not-a-date", "0000-00-00"]) {
      expect(parseDate(junk)).toBeNull();
    }
  });
});
