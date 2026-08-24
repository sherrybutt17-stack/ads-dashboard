import {
  DUPLICATE_WINDOW_DAYS,
  adjustedCostPerLead,
  type DuplicateGroup,
  type DuplicateReport,
} from "@/lib/metrics/duplicates";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/metrics/compute";

/**
 * The same person, entered twice.
 *
 * ── 🔴 Coverage renders before any finding, and that is the design ─────
 *
 * On the live book roughly one lead in eight carries a phone number or an email
 * address at all — the historical import never populated those columns — and
 * every match here is built from exactly those two fields. So "2 duplicates"
 * sitting alone on this card would be read as a statement about the pipeline
 * when it is a statement about the sliver of it that can be checked.
 *
 * The line naming the denominator is therefore not a caveat under the number;
 * it is above it, in the same type size, because at this coverage it is the
 * larger fact.
 *
 * ── The panel never offers to fix anything ────────────────────────────
 *
 * GoHighLevel owns contacts and has its own merge tool. A merge button here
 * would need write scope, would be irreversible, and would act on a match the
 * engine is explicit about not being certain of. Every row ends at "worth a
 * look in GHL".
 */

function Group({ group }: { group: DuplicateGroup }) {
  const first = group.leads[0];
  const shown = group.leads.slice(0, 4);

  return (
    <li
      className="border-t pt-2.5"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
          {first.name ?? "Unnamed lead"}
          <span className="ml-2 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
            {/*
             * The matched value is shown, not just the fact of a match. It is
             * what lets the reader dismiss a false positive in one glance
             * instead of opening two GHL records to find out.
             */}
            {group.match === "phone" ? first.phone : first.email}
          </span>
        </span>
        <span className="tnum text-[12px]" style={{ color: "var(--text-secondary)" }}>
          {group.leads.length} arrivals
          {group.kind === "returning" && (
            <span style={{ color: "var(--text-muted)" }}>
              {" "}
              · {formatNumber(Math.round(group.spanDays))} days apart
            </span>
          )}
        </span>
      </div>
      <ul className="mt-1 grid gap-0.5">
        {shown.map((l) => (
          <li key={l.id} className="tnum text-[11.5px]" style={{ color: "var(--text-muted)" }}>
            {l.createdAt.slice(0, 10)}
            {l.campaignName && <> · {l.campaignName}</>}
          </li>
        ))}
        {group.leads.length > shown.length && (
          <li className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
            +{group.leads.length - shown.length} more
          </li>
        )}
      </ul>
    </li>
  );
}

export function DuplicateLeads({
  report,
  spend,
  currency,
  costPerLead,
}: {
  report: DuplicateReport;
  spend: number;
  currency: string;
  costPerLead: number | null;
}) {
  const { groups, totalLeads, checkableLeads, redundantLeads, returningGroups } =
    report;

  const dupes = groups.filter((g) => g.kind === "duplicate");
  const returns = groups.filter((g) => g.kind === "returning");
  const adjusted = adjustedCostPerLead(spend, totalLeads, redundantLeads);
  const coverage = totalLeads > 0 ? checkableLeads / totalLeads : 0;

  return (
    <section className="card p-5" aria-label="Duplicate leads">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          The same person, more than once
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
          Leads sharing a phone number or an email address. Two within{" "}
          {DUPLICATE_WINDOW_DAYS} days is one person filling in the form twice;
          further apart is someone coming back.
        </p>
      </div>

      {/* ── Coverage, first and at full weight ───────────────────────── */}
      <p
        className="mt-4 rounded-[10px] border px-3 py-2.5 text-[13px] leading-relaxed"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface-1)",
          color: "var(--text-secondary)",
        }}
      >
        {checkableLeads === 0 ? (
          <>
            <strong style={{ color: "var(--text-primary)" }}>
              None of these leads can be checked.
            </strong>{" "}
            Not one of the {formatNumber(totalLeads)} in this range carries a
            phone number or an email address, so there is no way to tell whether
            any two of them are the same person. That is a gap in what was
            imported, not a finding about the leads.
          </>
        ) : (
          <>
            <strong style={{ color: "var(--text-primary)" }}>
              {formatNumber(checkableLeads)} of {formatNumber(totalLeads)} leads
              can be checked
            </strong>{" "}
            ({formatPercent(coverage, 0)}) — the rest carry neither a phone
            number nor an email address, so nothing can be matched against them.
            {dupes.length === 0
              ? " Among those that can be checked, no two are the same person."
              : ` Among those, ${formatNumber(redundantLeads)} ${redundantLeads === 1 ? "arrival is a repeat" : "arrivals are repeats"}.`}
          </>
        )}
      </p>

      {adjusted !== null && costPerLead !== null && (
        <p className="tnum mt-3 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {/*
           * Both numbers, never only the corrected one. Dropping repeats from
           * the denominator quietly is the same massaging the disqualified-lead
           * split refuses, and the honest version is to show what changes and
           * let the reader carry both.
           */}
          Cost per lead {formatCurrency(costPerLead, currency)} ·{" "}
          <span style={{ color: "var(--text-primary)" }}>
            {formatCurrency(adjusted, currency)} counting each person once
          </span>
          <span className="ml-1.5 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
            — a floor, since it can only correct the {formatPercent(coverage, 0)}{" "}
            that is checkable
          </span>
        </p>
      )}

      {dupes.length > 0 && (
        <div className="mt-4">
          <p className="text-[12.5px] font-medium" style={{ color: "var(--text-primary)" }}>
            Filled in more than once
          </p>
          <ul className="mt-1.5 grid gap-2.5">
            {dupes.slice(0, 8).map((g) => (
              <Group key={g.key} group={g} />
            ))}
          </ul>
          {dupes.length > 8 && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
              {formatNumber(dupes.length - 8)} more not shown.
            </p>
          )}
        </div>
      )}

      {returns.length > 0 && (
        <div className="mt-4">
          <p className="text-[12.5px] font-medium" style={{ color: "var(--text-primary)" }}>
            Came back
          </p>
          <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
            {/*
             * Framed as the good news it is. These are counted OUT of the
             * duplicate correction above — a returning customer is a second
             * genuine lead, and subtracting them would understate the pipeline.
             */}
            {formatNumber(returningGroups)}{" "}
            {returningGroups === 1 ? "person has" : "people have"} enquired more
            than once, more than {DUPLICATE_WINDOW_DAYS} days apart. Counted as
            separate leads, because they are.
          </p>
          <ul className="mt-1.5 grid gap-2.5">
            {returns.slice(0, 4).map((g) => (
              <Group key={g.key} group={g} />
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Matched on phone number or email address only — never on name, because
        two people with the same name are not evidence of anything. Nothing here
        changes any record: merging is done in GoHighLevel, which owns contacts.
      </p>
    </section>
  );
}
