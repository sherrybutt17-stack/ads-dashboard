import type { CanonicalStage } from "@/lib/stages";

/**
 * A client's funnel, built from its contacts' tags — the pure half.
 *
 * Given every contact in scope, when each mapped tag was first seen on it, and
 * what each tag means, this decides who is a lead and which steps each lead
 * reached when. No I/O: `./index.ts` loads the inputs and writes the result
 * into the same ledger tables pipeline clients use, so every screen reads it
 * the same way.
 *
 * The rules, which are also what the Connections page tells the operator:
 *
 *  - A contact is a lead when it carries ANY mapped tag, when it came from an ad
 *    (it has a campaign, click or lead-form id), or — with "every new contact"
 *    on — always. Which leads are PAID stays the job of the separate paid-lead
 *    rule, exactly as for a pipeline client.
 *  - A lead is counted on the day the contact arrived, whatever tag made it one.
 *  - Every other step is dated when its tag was first seen — and never before
 *    the lead itself: a tag already there when we first looked carries the
 *    contact's creation time, so it lands on the lead's own day.
 *  - Steps are kept once reached. A tag removed later does not un-count it,
 *    just as a pipeline card moved back does not.
 */

export interface TagFunnelContact {
  /** `contacts.id` */
  id: string;
  ghlContactId: string;
  /** Display name for the Leads list. */
  name: string | null;
  /** When the contact arrived in GoHighLevel (or, failing that, here). */
  leadAt: Date;
  /** Carries a campaign, click or lead-form id from an ad. */
  fromAd: boolean;
}

export interface TagObservation {
  contactId: string;
  /** Lowercased, as `contacts.tags` stores it. */
  tag: string;
  firstSeenAt: Date;
}

export interface TagStep {
  stage: CanonicalStage;
  at: Date;
}

export interface TagLead {
  contactId: string;
  ghlContactId: string;
  name: string | null;
  leadAt: Date;
  /** First arrival at each step reached; always starts with New lead. */
  steps: TagStep[];
  /** The step the lead is in now: the latest, the deepest on a tie. */
  current: TagStep;
  status: "open" | "won" | "lost";
}

/**
 * How deep each step is, to break ties between steps reached at the same
 * moment — common, since every tag that was already there when we first looked
 * is dated to the contact's arrival. Ending steps sort last.
 */
const DEPTH: Record<CanonicalStage, number> = {
  new_lead: 0,
  contacted: 1,
  appointment_booked: 2,
  no_show: 3,
  showed: 4,
  closed_won: 5,
  lost: 6,
  disqualified: 7,
};

export function projectTagLeads(
  contacts: readonly TagFunnelContact[],
  observations: readonly TagObservation[],
  map: ReadonlyMap<string, CanonicalStage>,
  opts: { everyContact: boolean },
): TagLead[] {
  // Per contact, the first time each MAPPED step's tags were seen.
  const reached = new Map<string, Map<CanonicalStage, number>>();
  for (const o of observations) {
    const stage = map.get(o.tag);
    if (!stage) continue;
    const t = o.firstSeenAt.getTime();
    if (!Number.isFinite(t)) continue;
    let byStage = reached.get(o.contactId);
    if (!byStage) reached.set(o.contactId, (byStage = new Map()));
    const prev = byStage.get(stage);
    if (prev === undefined || t < prev) byStage.set(stage, t);
  }

  const leads: TagLead[] = [];
  for (const c of contacts) {
    const byStage = reached.get(c.id);
    if (!opts.everyContact && !c.fromAd && !byStage) continue;

    const leadMs = c.leadAt.getTime();
    const steps: TagStep[] = [{ stage: "new_lead", at: new Date(leadMs) }];
    for (const [stage, t] of byStage ?? []) {
      if (stage === "new_lead") continue;
      steps.push({ stage, at: new Date(Math.max(t, leadMs)) });
    }
    steps.sort(
      (a, b) => a.at.getTime() - b.at.getTime() || DEPTH[a.stage] - DEPTH[b.stage],
    );

    const has = (s: CanonicalStage) => steps.some((x) => x.stage === s);
    leads.push({
      contactId: c.id,
      ghlContactId: c.ghlContactId,
      name: c.name,
      leadAt: new Date(leadMs),
      steps,
      current: steps[steps.length - 1],
      status: has("closed_won")
        ? "won"
        : has("lost") || has("disqualified")
          ? "lost"
          : "open",
    });
  }
  return leads;
}

/** The stand-in opportunity's GoHighLevel id: one per contact, never a real id. */
export function tagOpportunityId(ghlContactId: string): string {
  return `tag:${ghlContactId}`;
}

/** Normalise a tag the way `contacts.tags` stores it. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}
