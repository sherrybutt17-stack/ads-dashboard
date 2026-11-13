import { describe, it, expect } from "vitest";
import type { CanonicalStage } from "@/lib/stages";
import {
  normalizeTag,
  projectTagLeads,
  tagOpportunityId,
  type TagFunnelContact,
  type TagObservation,
} from "./project";

/**
 * Who is a lead, and which steps they reached when — the rules the
 * Connections page states, one story per test.
 */

const at = (iso: string) => new Date(iso);

const contact = (id: string, leadAt: string, extra: Partial<TagFunnelContact> = {}): TagFunnelContact => ({
  id,
  ghlContactId: `g-${id}`,
  name: `Person ${id}`,
  leadAt: at(leadAt),
  fromAd: false,
  ...extra,
});

const seen = (contactId: string, tag: string, when: string): TagObservation => ({
  contactId,
  tag,
  firstSeenAt: at(when),
});

const MAP = new Map<string, CanonicalStage>([
  ["meta", "new_lead"],
  ["booked", "appointment_booked"],
  ["showed", "showed"],
  ["won", "closed_won"],
  ["location denied", "disqualified"],
]);

const project = (
  contacts: TagFunnelContact[],
  observations: TagObservation[],
  opts = { everyContact: false },
) => projectTagLeads(contacts, observations, MAP, opts);

describe("projectTagLeads — who is a lead", () => {
  it("counts a contact carrying a mapped lead tag, on the day it arrived", () => {
    const [lead] = project([contact("a", "2026-11-01T10:00:00Z")], [seen("a", "meta", "2026-11-01T10:00:05Z")]);
    expect(lead.steps).toEqual([{ stage: "new_lead", at: at("2026-11-01T10:00:00Z") }]);
    expect(lead.current.stage).toBe("new_lead");
    expect(lead.status).toBe("open");
  });

  it("ignores a contact whose tags are all unmapped", () => {
    expect(project([contact("a", "2026-11-01T10:00:00Z")], [seen("a", "lasik", "2026-11-01T10:00:00Z")])).toEqual([]);
  });

  it("counts a contact that came from an ad, with no tag at all", () => {
    const leads = project([contact("a", "2026-11-01T10:00:00Z", { fromAd: true })], []);
    expect(leads).toHaveLength(1);
    expect(leads[0].steps.map((s) => s.stage)).toEqual(["new_lead"]);
  });

  it("counts every contact when every new contact is a lead", () => {
    const leads = project(
      [contact("a", "2026-11-01T10:00:00Z"), contact("b", "2026-11-02T10:00:00Z")],
      [],
      { everyContact: true },
    );
    expect(leads.map((l) => l.contactId)).toEqual(["a", "b"]);
  });

  it("treats a tag mapped to a later step as making a lead too", () => {
    const [lead] = project([contact("a", "2026-11-01T10:00:00Z")], [seen("a", "booked", "2026-11-03T09:00:00Z")]);
    expect(lead.steps.map((s) => s.stage)).toEqual(["new_lead", "appointment_booked"]);
  });
});

describe("projectTagLeads — when each step happened", () => {
  it("dates a later step from when its tag was first seen", () => {
    const [lead] = project(
      [contact("a", "2026-11-01T10:00:00Z")],
      [seen("a", "meta", "2026-11-01T10:00:00Z"), seen("a", "booked", "2026-11-04T15:30:00Z")],
    );
    expect(lead.steps).toEqual([
      { stage: "new_lead", at: at("2026-11-01T10:00:00Z") },
      { stage: "appointment_booked", at: at("2026-11-04T15:30:00Z") },
    ]);
    expect(lead.current).toEqual({ stage: "appointment_booked", at: at("2026-11-04T15:30:00Z") });
  });

  it("never dates a step before the lead itself", () => {
    const [lead] = project([contact("a", "2026-11-05T00:00:00Z")], [seen("a", "booked", "2026-11-01T00:00:00Z")]);
    expect(lead.steps[1]).toEqual({ stage: "appointment_booked", at: at("2026-11-05T00:00:00Z") });
  });

  it("takes the earliest of several tags meaning the same step", () => {
    const map = new Map<string, CanonicalStage>([
      ["booked", "appointment_booked"],
      ["consult booked", "appointment_booked"],
    ]);
    const [lead] = projectTagLeads(
      [contact("a", "2026-11-01T00:00:00Z")],
      [seen("a", "booked", "2026-11-06T00:00:00Z"), seen("a", "consult booked", "2026-11-03T00:00:00Z")],
      map,
      { everyContact: false },
    );
    expect(lead.steps).toEqual([
      { stage: "new_lead", at: at("2026-11-01T00:00:00Z") },
      { stage: "appointment_booked", at: at("2026-11-03T00:00:00Z") },
    ]);
  });

  it("puts the deepest step last when several share the lead's own moment", () => {
    // Tags already there when first looked at all carry the creation time.
    const [lead] = project(
      [contact("a", "2026-11-01T00:00:00Z")],
      [
        seen("a", "won", "2026-11-01T00:00:00Z"),
        seen("a", "booked", "2026-11-01T00:00:00Z"),
        seen("a", "showed", "2026-11-01T00:00:00Z"),
      ],
    );
    expect(lead.steps.map((s) => s.stage)).toEqual(["new_lead", "appointment_booked", "showed", "closed_won"]);
    expect(lead.current.stage).toBe("closed_won");
    expect(lead.status).toBe("won");
  });

  it("marks a disqualified lead closed, but still a lead", () => {
    const [lead] = project(
      [contact("a", "2026-11-01T00:00:00Z")],
      [seen("a", "meta", "2026-11-01T00:00:00Z"), seen("a", "location denied", "2026-11-02T00:00:00Z")],
    );
    expect(lead.steps.map((s) => s.stage)).toEqual(["new_lead", "disqualified"]);
    expect(lead.status).toBe("lost");
  });
});

describe("helpers", () => {
  it("gives each contact one stand-in id that no GoHighLevel id can equal", () => {
    expect(tagOpportunityId("AbC123")).toBe("tag:AbC123");
  });

  it("normalises tags the way contacts store them", () => {
    expect(normalizeTag("  Location Denied ")).toBe("location denied");
  });
});
