/**
 * The canonical funnel stages, their labels, and the happy path.
 *
 * ── Why this is not in `db/schema.ts` ─────────────────────────────────
 *
 * These constants are needed by BOTH the query layer and the browser — the
 * funnel component labels its stages, and the setup wizard offers them in the
 * mapping dropdowns. When they lived in `db/schema.ts`, importing `STAGE_LABELS`
 * into a `"use client"` component pulled the entire schema module — and
 * `drizzle-orm/pg-core` with it — into the client bundle.
 *
 * 🔴 That shipped every table and column name to the browser, including
 * `ghl_token_encrypted`, `password_hash`, `token_hash` and `webhook_token`. No
 * values leaked, only structure, but this application has client-role logins:
 * people outside the agency can open devtools. Handing them a map of where the
 * credentials live is a needless gift, and the bundle carried 80K of ORM
 * metadata that the browser had no use for.
 *
 * So the values live here, in a module with no dependencies at all, and
 * `db/schema.ts` builds its pgEnum FROM this list rather than the other way
 * round. One source of truth, and the enum cannot drift from the labels.
 *
 * Anything added here must also be added to the database enum, which happens
 * automatically — `canonicalStageEnum` is declared as
 * `pgEnum("canonical_stage", CANONICAL_STAGES)`.
 */

/**
 * The eight canonical funnel stages. Fixed across all clients — every client's
 * own GHL stage names are mapped onto these via `pipelineStages`, which is what
 * lets one metrics engine serve every tenant.
 *
 * `disqualified` is never a real prospect — wrong number, spam, out of service
 * area.
 *
 * 🔴 **Deliberately NOT folded into `lost`.** `lost` means "a genuine prospect
 * we could not close", and it belongs in the close-rate denominator: failing to
 * close real prospects is a sales problem worth measuring. A wrong number was
 * never winnable, so counting it as `lost` makes close rate look worse than
 * reality and buries the actual signal — that the ads are attracting the wrong
 * people, which is a targeting problem with a completely different fix.
 *
 * Populated entirely by the sales team's existing habit of moving junk to a
 * "Wrong Number / Disqualified" stage in GHL. The webhook already records stage
 * transitions, so this needs no write path, no new GHL permission, and no
 * dashboard-side mutation — and the ledger supplies its timestamps and history
 * for free.
 */
export const CANONICAL_STAGES = [
  "new_lead",
  "contacted",
  "appointment_booked",
  "showed",
  "no_show",
  "closed_won",
  "lost",
  "disqualified",
] as const;

export type CanonicalStage = (typeof CANONICAL_STAGES)[number];

/**
 * The stages a client MUST map before their funnel means anything.
 *
 * `disqualified` is excluded deliberately. Plenty of pipelines have no junk
 * stage, and not having one is a legitimate way to run a CRM rather than a
 * misconfiguration — so requiring it would turn every existing client's health
 * check amber the moment this shipped, for a stage they never had and may never
 * want. It stays offered in the mapping UI and absent from the requirement.
 */
export const REQUIRED_CANONICAL_STAGES: CanonicalStage[] = CANONICAL_STAGES.filter(
  (s) => s !== "disqualified",
);

/** Display order + labels. `no_show`, `lost` and `disqualified` are exits. */
export const STAGE_LABELS: Record<CanonicalStage, string> = {
  new_lead: "New Lead",
  contacted: "Contacted",
  appointment_booked: "Appointment Booked",
  showed: "Showed",
  no_show: "No Show",
  closed_won: "Closed / Won",
  lost: "Lost",
  disqualified: "Disqualified",
};

/**
 * The happy path, in order. Drop-off between consecutive pairs is the funnel.
 *
 * `disqualified` is deliberately absent, like `no_show` and `lost`: it is an
 * exit, not a step. Putting it in the path would imply leads flow *through* it.
 */
export const FUNNEL_PATH: CanonicalStage[] = [
  "new_lead",
  "contacted",
  "appointment_booked",
  "showed",
  "closed_won",
];

/**
 * Best-guess canonical stage from a GHL stage name.
 *
 * ── This is a SUGGESTION, and the distinction is load-bearing ──────────
 *
 * It exists to save an operator from working forty-seven dropdowns by hand, not
 * to decide anything. Nothing may write its result to `pipeline_stages`
 * unattended: a wrong mapping does not error, does not look broken, and simply
 * reattributes every future lead to the wrong stage — the funnel stays
 * plausible and is quietly false. So it returns null for anything ambiguous —
 * a bare "Closed", "Cancelled" (a cancelled appointment and a cancelled deal
 * are different stages), "Customer" — and lets a human answer.
 *
 * ── Why it lives here ─────────────────────────────────────────────────
 *
 * There were two of these, one on the server (persisted into the mapping at
 * import) and one in the wizard (offered as a fill button), and they disagreed
 * on seven of sixteen real stage names — including which of `lost` and
 * `disqualified` junk belongs in. The server's ran first and won, so the
 * wizard's better answer was never reachable: its fill button skips any row
 * that already has a value.
 *
 * 🔴 Neither could ever return `disqualified`. Both predate the stage, and both
 * actively steered "Disqualified" / "DQ" / "Unqualified" into `lost` — the
 * exact fold that stage was added to prevent (see CANONICAL_STAGES above: junk
 * in the close-rate denominator makes sales look bad and hides a targeting
 * problem). This module has no dependencies, so one copy can serve both the
 * browser and the server.
 *
 * Order matters throughout: "no show" contains "show", junk must be tested
 * before `lost`, and "Showed — Attended Appt" contains "appt".
 */
export function suggestCanonicalStage(name: string | null): CanonicalStage | null {
  const n = (name ?? "").toLowerCase().trim();
  if (!n) return null;

  // Before every "show" rule.
  if (/no[\s-]?show|did ?n'?o?t? ?show|missed (appt|appointment)/.test(n)) {
    return "no_show";
  }
  // Before `lost`. "Unqualified" is read as junk rather than a prospect we
  // failed to close — it describes the lead, not the outcome.
  if (/disqualif|unqualif|(^|\W)dq(\W|$)|wrong number|spam|junk|test lead|out of (the )?area/.test(n)) {
    return "disqualified";
  }
  if (/closed[\s/_-]*won|sale[s]?[\s/_-]*closed|deal[\s_-]*won|(^|\W)won(\W|$)|(^|\W)sold(\W|$)|purchased|customer won/.test(n)) {
    return "closed_won";
  }
  if (/closed[\s/_-]*lost|(^|\W)lost(\W|$)|not interested|(^|\W)dead(\W|$)|dead lead/.test(n)) {
    return "lost";
  }
  // Before `appointment_booked`, so "Showed - Attended Appt" is not read as a
  // booking. Nothing here matches a bare "Consultation Booked".
  if (/showed|show(ed)? up|attended|consult[^.]*\b(complete|done|attended)/.test(n)) {
    return "showed";
  }
  if (/appointment|appt|booked|scheduled|(consult|meeting)[^.]*\b(book|schedul)/.test(n)) {
    return "appointment_booked";
  }
  if (/new lead|(^|\W)lead in|new inquiry|new enquiry|new opportunity|opt[\s-]?in|(^|\W)fb leads?(\W|$)/.test(n)) {
    return "new_lead";
  }
  if (/contact|conversation|reached|engaged|follow[\s-]?up|nurtur|texted|replied|responded|call[\s-]?\d|call back|attempt/.test(n)) {
    return "contacted";
  }
  return null;
}
