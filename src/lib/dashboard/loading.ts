import { SECTION_BY_ID, type SectionId } from "./registry";

/**
 * Which queries a hidden section is allowed to skip.
 *
 * ── Why this is an allowlist and not `dataKeys` ───────────────────────
 *
 * The registry already records which pieces of `DashboardData` each section
 * reads, and deriving "skip everything no visible section names" from it is one
 * line. It is also wrong, and wrong in a way that ships looking fine.
 *
 * `dataKeys` documents what a section READS. It does not capture that
 * `page.tsx` builds its campaign colour map from the union of `data.campaigns`
 * and `data.leads`, and hands it to the pipeline explorer as well as the
 * campaign table. Derive the skip set mechanically and a client who hides the
 * campaign table gets an explorer where every campaign is a raw 17-digit id.
 * Nobody would connect those two events.
 *
 * So skipping is opt-in, one line per section, and everything not named here
 * always loads. A new section costs nothing by being absent from this table —
 * it just does not save a query until someone has checked that it can.
 *
 * ── What is deliberately NOT skippable, and why ───────────────────────
 *
 * · **campaigns / leadsByCampaign / funnelByCampaign** — campaign NAMES, read
 *   by the pipeline explorer and the keep/kill engine regardless of whether the
 *   campaign table itself is shown. This is the trap above.
 * · **leads** — same union, plus the pipeline explorer's own rows. One capped
 *   query; not worth the risk.
 * · **extendedDaily** — feeds the trend chart, the anomaly detector AND the
 *   insight strip. Three sections, one query, already shared.
 * · **current / previous / leadBreakdown** — the headline numbers and the
 *   lead-source note, both of which are `required: true` and cannot be hidden.
 */
export const SKIPPABLE: Partial<Record<SectionId, string>> = {
  heatmap: "heatmap",
  speed_to_lead: "speedToLead",
  speed_outcome: "speedOutcome",
  aging: "aging",
  uncalled: "uncalled",
  maturation: "maturation",
  channels: "channels",
  call_timing: "callTiming",
  lead_quality: "quality",
  lead_sources: "leadSources",
  forecast: "forecast",
  budget_pacing: "pacing",
  budget_delivery: "budgetHistory",
  duplicates: "duplicates",
};

/**
 * Should this section's query run?
 *
 * 🔴 `undefined` means load everything, and that is the important case rather
 * than a convenience default. The report route, the share-link route, the
 * present deck and the PDF renderer all assemble their own section lists and
 * must never inherit a client's dashboard preferences — a client who hid the
 * funnel on their own screen has not thereby removed it from the board pack the
 * agency sends. Only `/c/[slug]` passes a set.
 *
 * It has exactly one exception, spelled out at the branch below: a STAFF-ONLY
 * section is not loaded for a caller that named no sections, because every such
 * caller renders from a fixed list that cannot contain one.
 */
export function wants(
  visible: ReadonlySet<SectionId> | undefined,
  section: SectionId,
): boolean {
  // Not skippable: always loads, whoever is asking. See the note above.
  if (!(section in SKIPPABLE)) return true;

  if (!visible) {
    /*
     * 🔴 The one exception to "undefined means everything", and it is about
     * cost rather than privacy.
     *
     * Every surface that passes no set is client-facing or derived from one —
     * the share link, the PDF renderer, the CSV export, the summary route —
     * and each renders from its own fixed list (`REPORT_SECTIONS` and friends)
     * which by construction excludes staff-only sections. So loading a
     * staff-only section's queries for them buys a value that is guaranteed to
     * be discarded: budget pacing alone is five queries on every share view.
     *
     * Privacy is NOT what this rests on. Those surfaces already cannot render
     * these sections, and if that ever changed this line would be the wrong
     * place to notice.
     */
    return !SECTION_BY_ID[section]?.staffOnly;
  }

  return visible.has(section);
}
