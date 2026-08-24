/**
 * The same person, entered twice.
 *
 * ── 🔴 Coverage is the finding. The duplicate count is secondary ───────
 *
 * On the live database **1,411 of 1,605 contacts carry neither a phone number
 * nor an email address** — not because those people withheld them, but because
 * the historical import never populated the columns. Every dedup key this or
 * any other tool could use is built from exactly those two fields.
 *
 * So a panel reporting "3 duplicates found" would be true and would be read as
 * "there are 3 duplicates", when the honest statement is "there are 3 among the
 * 12% of leads we are able to check at all". That gap is not a caveat to put in
 * a footnote — at this coverage it is the larger fact, and `coverage` is
 * therefore a required field on the report rather than an optional extra.
 *
 * The same reasoning rules out inferring identity from name alone. Two people
 * called "J Smith" are not evidence of anything, and a panel that said they were
 * would burn the credibility of the ones that are real.
 *
 * ── A re-submission and a returning customer are not the same event ────
 *
 * Two leads sharing a phone number three days apart is one person filling in the
 * form twice, and it inflates the lead count and understates cost per lead.
 * The same two leads eleven months apart is a customer who came back — which is
 * a *good* outcome, is not a data problem, and must not be reported as one.
 *
 * The only thing separating them is elapsed time, so the split is explicit and
 * the threshold is named. Anything past it is reported under its own heading
 * rather than dropped, because "this campaign brings back previous customers"
 * is worth knowing and nothing else in the product surfaces it.
 *
 * ── Nothing here writes ────────────────────────────────────────────────
 *
 * GoHighLevel is the system of record for contacts and has its own merge tool.
 * An automatic merge from this side would need `contacts.write`, would be
 * irreversible, and would be acting on a match this file is explicit about not
 * being certain of. This reports; a person decides.
 */

/** Days within which two identical contacts are a re-submission, not a return. */
export const DUPLICATE_WINDOW_DAYS = 30;

export type MatchKind = "phone" | "email";
export type GroupKind = "duplicate" | "returning";

export interface DuplicateLead {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  /** ISO instant the lead arrived. */
  createdAt: string;
  campaignName: string | null;
}

export interface DuplicateGroup {
  key: string;
  match: MatchKind;
  kind: GroupKind;
  /** Oldest first. */
  leads: DuplicateLead[];
  /** Whole days between the first and last arrival in the group. */
  spanDays: number;
}

export interface DuplicateReport {
  groups: DuplicateGroup[];
  /** Leads in the window, whether or not they can be checked. */
  totalLeads: number;
  /** Leads carrying a usable phone or email. */
  checkableLeads: number;
  /** Extra arrivals beyond the first in each `duplicate` group. */
  redundantLeads: number;
  /** Groups whose repeat arrival is far enough out to be a returning customer. */
  returningGroups: number;
}

/**
 * A phone number reduced to something comparable.
 *
 * Digits only, then the North American country code dropped when present, so
 * `+1 (555) 010-0100`, `555-010-0100` and `15550100100` are one key.
 *
 * 🔴 Deliberately NOT a general international normaliser. Doing this properly
 * needs a country and a library carrying every national numbering plan; doing
 * it half-properly — say, always dropping a leading digit — would merge
 * genuinely different numbers in every country whose subscriber numbers are not
 * ten digits. This book is a US med-spa book, so the one rule that matters is
 * implemented and the rest is left alone rather than guessed at.
 *
 * Anything under 7 digits is rejected outright: extensions, partial entries and
 * placeholder values like `0000` would otherwise all collide into one enormous
 * false group.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length < 7) return null;
  /*
   * A run of one repeated digit is a placeholder, not a number. `0000000000`
   * and `1111111111` appear in real CRM data and would otherwise form the
   * largest "duplicate" group in the book.
   */
  if (/^(\d)\1+$/.test(digits)) return null;
  return digits;
}

/**
 * An email reduced to something comparable.
 *
 * Lowercased and trimmed, and nothing else.
 *
 * 🔴 Two normalisations that look obvious are deliberately absent:
 *
 * · **Plus-addressing is not stripped.** `jane+spa@x.com` and `jane@x.com`
 *   usually reach one mailbox — but "usually" is doing real work there, and the
 *   output of this file is a claim that two records are the same PERSON, shown
 *   to someone who may act on it in GHL. Where the evidence is a convention
 *   rather than a fact, the pair is left unmatched.
 * · **Gmail dot-folding is not applied.** It is correct for Gmail and wrong
 *   everywhere else, and nothing here knows which provider is behind a custom
 *   domain.
 *
 * Both errors are misses rather than false claims, which is the right direction
 * for a panel whose suggested action is "go and merge these two people".
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  // One `@`, something on each side, and a dot in the domain. Enough to reject
  // the free-text that lands in this column without pretending to validate.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return null;
  return v;
}

const DAY_MS = 86_400_000;

export function buildDuplicates(
  leads: readonly DuplicateLead[],
  opts: { totalLeads: number; windowDays?: number } = { totalLeads: 0 },
): DuplicateReport {
  const windowDays = opts.windowDays ?? DUPLICATE_WINDOW_DAYS;

  const byKey = new Map<string, { match: MatchKind; leads: DuplicateLead[] }>();
  let checkable = 0;

  for (const lead of leads) {
    const phone = normalizePhone(lead.phone);
    const email = normalizeEmail(lead.email);
    if (!phone && !email) continue;
    checkable++;

    /*
     * 🔴 One key per lead, phone first — not one per identifier.
     *
     * Filing a lead under both its phone and its email would report the same
     * pair twice whenever both match, and the two rows would look like two
     * separate problems. Phone wins because it is the field this book actually
     * has: it is present on more contacts than email, and it is the one a
     * receptionist types.
     */
    const [match, value]: [MatchKind, string] = phone
      ? ["phone", phone]
      : ["email", email!];

    const key = `${match}:${value}`;
    const bucket = byKey.get(key) ?? { match, leads: [] };
    bucket.leads.push(lead);
    byKey.set(key, bucket);
  }

  const groups: DuplicateGroup[] = [];
  let redundant = 0;
  let returning = 0;

  for (const [key, bucket] of byKey) {
    if (bucket.leads.length < 2) continue;

    const sorted = [...bucket.leads].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const first = Date.parse(sorted[0].createdAt);
    const last = Date.parse(sorted[sorted.length - 1].createdAt);
    /*
     * An unparseable timestamp reads as a zero span, which files the group as a
     * duplicate. That is the safe direction: a duplicate is shown to a person
     * for judgement, whereas mislabelling it "returning customer" would file a
     * data problem under good news and nobody would look at it again.
     */
    const spanDays =
      Number.isFinite(first) && Number.isFinite(last)
        ? Math.max(0, (last - first) / DAY_MS)
        : 0;

    const kind: GroupKind = spanDays <= windowDays ? "duplicate" : "returning";
    if (kind === "duplicate") redundant += sorted.length - 1;
    else returning++;

    groups.push({ key, match: bucket.match, kind, leads: sorted, spanDays });
  }

  /*
   * Duplicates before returns, then by size, then most recent first. The
   * ordering is the reading order: the thing that needs fixing, largest first.
   */
  groups.sort(
    (a, b) =>
      Number(b.kind === "duplicate") - Number(a.kind === "duplicate") ||
      b.leads.length - a.leads.length ||
      b.leads[b.leads.length - 1].createdAt.localeCompare(
        a.leads[a.leads.length - 1].createdAt,
      ),
  );

  return {
    groups,
    totalLeads: opts.totalLeads,
    checkableLeads: checkable,
    redundantLeads: redundant,
    returningGroups: returning,
  };
}

/**
 * What cost per lead becomes once re-submissions stop being counted twice.
 *
 * Returns `null` rather than a number when there is nothing to correct, so the
 * panel can stay silent instead of printing two identical figures side by side
 * and inviting the reader to hunt for the difference.
 */
export function adjustedCostPerLead(
  spend: number,
  leads: number,
  redundant: number,
): number | null {
  if (redundant <= 0 || spend <= 0) return null;
  const unique = leads - redundant;
  if (unique <= 0) return null;
  return spend / unique;
}
