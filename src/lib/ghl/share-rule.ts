import { normalizeTag } from "@/lib/tag-funnel/project";

/**
 * Which client a person in a shared GoHighLevel sub-account counts for — the
 * pure half of "Share this sub-account". No I/O: `./share.ts` loads the
 * evidence from the holder's copy and writes the verdict onto every client's
 * copy of the person.
 *
 * The users decide, by tags: on the holder's Connections page they pick the
 * GHL tags that mark each client's leads, which client takes the leads that
 * carry no client's tag (or No one), and whether a lead stays with its client
 * after its tag is removed. Nothing else routes a lead — not an ad account, a
 * campaign, a pipeline or a source.
 *
 * The rules, which the panel also tells the users:
 *
 *  R1  One client's tag on the contact now → that client.
 *  R2  Two or more clients' tags now → the client it already counts for, while
 *      that client's tag is still on it. A lead that counts for none of them
 *      yet goes to the client whose tag was seen first; a tie (both seen at
 *      once) goes to the no-tag choice.
 *  R3  No client's tag now, the keep switch on, and a split tag in its history
 *      → it stays with the client it counts for, if that client's tag is in the
 *      history. A lead never placed by a tag goes to the client whose tag was
 *      seen last; a tie goes to the no-tag choice.
 *  R4  Otherwise → the no-tag choice (a client, or No one).
 *
 * R2 and R3 stick to the current owner rather than comparing dates, because
 * the history keeps only each tag's FIRST sighting: a corrected or reassigned
 * lead would otherwise flip back on a stale date. Given the same evidence the
 * answer is always the same, so the preview runs this function on the same
 * rows the save does.
 */

/** Why a person counts where it does. Stored on every copy as `share_reason`. */
export type ShareReason = "tag" | "first_tag" | "both_tags" | "kept" | "no_tag" | "unread";

export const SHARE_REASONS: readonly ShareReason[] = [
  "tag",
  "first_tag",
  "both_tags",
  "kept",
  "no_tag",
  "unread",
];

/** Reasons that mean a client's tag placed the person — the only ones that alert, and the only owners R2/R3 keep. */
export const PLACED_BY_TAG: ReadonlySet<ShareReason> = new Set<ShareReason>(["tag", "first_tag", "kept"]);

export interface ShareRules {
  /** Each client in the share and its split tags, normalised. A tag belongs to one client at most. */
  tags: ReadonlyMap<string, readonly string[]>;
  /** The client that takes leads with no client's tag; null = No one. */
  untagged: string | null;
  /** Keep a lead with its client after its tag is removed. */
  keepRemoved: boolean;
}

/** What the holder's copy says about one person. */
export interface SplitEvidence {
  /** The holder's `contacts.tags`; null = never read from GoHighLevel. */
  tags: readonly string[] | null;
  /** The holder's `contact_tag_history`: tag → when it was first seen. Other tags are ignored. */
  history: ReadonlyMap<string, Date>;
  /** The holder's `attribution_fetched_at`: when its tags were last read; null = never. */
  fetchedAt: Date | null;
  /** When the contact arrived (`ghl_created_at`, else `created_at`). */
  createdAt: Date;
  /** The client whose copy counts now with a reason in PLACED_BY_TAG, if any. */
  owner: string | null;
}

export interface SplitVerdict {
  /** The client the person counts for; null = no one. */
  clientId: string | null;
  reason: ShareReason;
}

/** tag → the client it belongs to. */
export function tagOwners(rules: Pick<ShareRules, "tags">): Map<string, string> {
  const out = new Map<string, string>();
  for (const [clientId, tags] of rules.tags) {
    for (const t of tags) if (!out.has(t)) out.set(t, clientId);
  }
  return out;
}

/**
 * When a split tag on the contact was seen, for ordering two clients' tags.
 *
 * Its history row when there is one. A current tag with no row — one we did
 * not watch arrive — is dated no earlier than the last read that could have
 * shown it, and strictly AFTER every split tag we did see arrive: a repaired or
 * imported tag must not jump the queue on its contact's creation date, nor tie
 * with a tag we know was there first.
 */
export function seenAt(
  tag: string,
  evidence: Pick<SplitEvidence, "history" | "fetchedAt" | "createdAt">,
  splitTags: ReadonlySet<string>,
): number {
  const own = evidence.history.get(tag);
  if (own) return own.getTime();
  let latest = (evidence.fetchedAt ?? evidence.createdAt).getTime();
  for (const [t, at] of evidence.history) {
    if (t !== tag && splitTags.has(t)) latest = Math.max(latest, at.getTime() + 1);
  }
  return latest;
}

function pickUnique(scores: Map<string, number>, best: (a: number, b: number) => boolean): string | "tie" {
  let winner: string | null = null;
  let score = 0;
  let tie = false;
  for (const [clientId, s] of scores) {
    if (winner === null || best(s, score)) {
      winner = clientId;
      score = s;
      tie = false;
    } else if (s === score) {
      tie = true;
    }
  }
  return tie || winner === null ? "tie" : winner;
}

export function decideSplit(evidence: SplitEvidence, rules: ShareRules): SplitVerdict {
  const owners = tagOwners(rules);
  const splitTags = new Set(owners.keys());

  // Split tags on the contact now. Never read: what the webhook log saw stands in.
  const present = new Set<string>();
  if (evidence.tags) {
    for (const t of evidence.tags) if (splitTags.has(t)) present.add(t);
  } else {
    for (const t of evidence.history.keys()) if (splitTags.has(t)) present.add(t);
  }

  // Clients whose tag is on it now, each with the earliest of its tags' sightings.
  const now = new Map<string, number>();
  for (const t of present) {
    const clientId = owners.get(t)!;
    const at = seenAt(t, evidence, splitTags);
    const prev = now.get(clientId);
    if (prev === undefined || at < prev) now.set(clientId, at);
  }

  // R1
  if (now.size === 1) return { clientId: [...now.keys()][0], reason: "tag" };

  // R2
  if (now.size > 1) {
    if (evidence.owner && now.has(evidence.owner)) return { clientId: evidence.owner, reason: "first_tag" };
    const first = pickUnique(now, (a, b) => a < b);
    return first === "tie"
      ? { clientId: rules.untagged, reason: "both_tags" }
      : { clientId: first, reason: "first_tag" };
  }

  // R3
  const remembered = [...evidence.history].filter(([t]) => splitTags.has(t));
  if (rules.keepRemoved && remembered.length > 0) {
    if (evidence.owner) {
      const ownerTags = new Set(rules.tags.get(evidence.owner) ?? []);
      if (remembered.some(([t]) => ownerTags.has(t))) return { clientId: evidence.owner, reason: "kept" };
    }
    const last = new Map<string, number>();
    for (const [t, at] of remembered) {
      const clientId = owners.get(t)!;
      last.set(clientId, Math.max(last.get(clientId) ?? -Infinity, at.getTime()));
    }
    const latest = pickUnique(last, (a, b) => a > b);
    return latest === "tie"
      ? { clientId: rules.untagged, reason: "both_tags" }
      : { clientId: latest, reason: "kept" };
  }

  // R4
  const unread = evidence.tags === null && remembered.length === 0;
  return { clientId: rules.untagged, reason: unread ? "unread" : "no_tag" };
}

/* ------------------------------------------------------------------ *
 * Validating what the users save
 * ------------------------------------------------------------------ */

export const MAX_SHARE_CLIENTS = 5;
export const MAX_TAGS_PER_CLIENT = 20;

export interface ShareRulesInput {
  clients: readonly { clientId: string; tags: readonly string[] }[];
  /** A client in the share, or null for No one. */
  untagged: string | null;
  keepRemoved: boolean;
}

export type ValidatedRules =
  | { ok: true; rules: ShareRules }
  | { ok: false; error: string };

/**
 * Check the rules the panel sends before anything is written.
 *
 * Tags are normalised the way `contacts.tags` stores them and must exist on
 * the sub-account's contacts — picked from the real list, never typed, so a
 * typo can't silently route nothing. Each tag belongs to one client.
 */
export function validateShareRules(
  input: ShareRulesInput,
  share: {
    /** Clients in the share (live ones), id → display name. */
    clients: ReadonlyMap<string, string>;
    /** Every tag on the holder's contacts, normalised. */
    knownTags: ReadonlySet<string>;
  },
): ValidatedRules {
  const tags = new Map<string, string[]>();
  const owner = new Map<string, string>();
  for (const c of input.clients) {
    const name = share.clients.get(c.clientId);
    if (name === undefined) return { ok: false, error: "That client doesn't share this sub-account." };
    if (tags.has(c.clientId)) return { ok: false, error: `${name} is listed twice.` };
    const mine: string[] = [];
    for (const raw of c.tags) {
      const t = normalizeTag(String(raw ?? ""));
      if (!t || mine.includes(t)) continue;
      if (!share.knownTags.has(t)) {
        return { ok: false, error: `No contact in this sub-account has the tag “${t}”. Pick tags from the list.` };
      }
      const taken = owner.get(t);
      if (taken !== undefined) {
        return {
          ok: false,
          error: `The tag “${t}” already belongs to ${share.clients.get(taken)}. A tag can belong to one client only.`,
        };
      }
      owner.set(t, c.clientId);
      mine.push(t);
    }
    if (mine.length > MAX_TAGS_PER_CLIENT) {
      return { ok: false, error: `${name} has more than ${MAX_TAGS_PER_CLIENT} tags. Keep the ones its leads really carry.` };
    }
    tags.set(c.clientId, mine);
  }
  // A client the panel left out keeps no tags.
  for (const id of share.clients.keys()) if (!tags.has(id)) tags.set(id, []);

  if (input.untagged !== null && !share.clients.has(input.untagged)) {
    return { ok: false, error: "Leads with no client's tag must go to a client in this share, or to no one." };
  }
  if (typeof input.keepRemoved !== "boolean") {
    return { ok: false, error: "Choose whether a lead stays with its client after its tag is removed." };
  }
  return { ok: true, rules: { tags, untagged: input.untagged, keepRemoved: input.keepRemoved } };
}

/** A client counts leads in the share only with a tag of its own, or as the no-tag choice. */
export function wouldCountLeads(rules: ShareRules, clientId: string): boolean {
  return (rules.tags.get(clientId)?.length ?? 0) > 0 || rules.untagged === clientId;
}
