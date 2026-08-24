"use client";

import { useState } from "react";
import {
  MAX_LISTED,
  type AgingLead,
  type AgingReport,
  type StageAge,
} from "@/lib/metrics/aging";
import { formatCurrency, formatNumber } from "@/lib/metrics/compute";
import { Icon } from "@/components/Icon";

/**
 * Leads that have stopped moving — a call list, not a report.
 *
 * Everything here is measured against the client's own ledger rather than a
 * threshold somebody picked, and the two numbers it produces mean different
 * things on purpose:
 *
 * · **Overdue** — older than 90% of everything that ever moved on from this
 *   stage. Worth a phone call.
 * · **Gone quiet** — older than the longest stay that ever ended here. Nothing
 *   like it has come back; this is a data-hygiene job, and putting it in the
 *   call list is how a call list stops being opened.
 */

const days = (n: number) => `${Math.round(n)}d`;

function StageChip({ s, active, onClick }: { s: StageAge; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors"
      style={{
        background: active ? "var(--surface-1)" : "transparent",
        color: active
          ? "var(--text-primary)"
          : s.aging === 0
            ? "var(--text-muted)"
            : "var(--text-secondary)",
        boxShadow: active ? "var(--shadow-sm)" : undefined,
      }}
    >
      {s.label}
      {s.aging > 0 && (
        <span className="tnum ml-1.5" style={{ color: "var(--status-warning)" }}>
          {s.aging}
        </span>
      )}
    </button>
  );
}

function LeadRow({ lead, campaignNames }: { lead: AgingLead; campaignNames: Record<string, string> }) {
  const over = lead.daysInStage - lead.thresholdDays;
  return (
    <div
      className="flex items-center justify-between gap-3 border-t py-2.5"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-[13px]"
            style={{ color: "var(--text-primary)" }}
          >
            {lead.name ?? "Unnamed lead"}
          </span>
          {/*
           * 🔴 Three states, not two. `false` is "nobody has ever called this
           * person", which is the most actionable row on the panel. `null` is
           * "the lead predates call tracking, so we do not know" — printing
           * that as never-called would put every historical lead at the top of
           * the list on a fact we do not have.
           */}
          {lead.everCalled === false && (
            <span
              className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide uppercase"
              style={{
                background: "color-mix(in srgb, var(--status-critical) 14%, transparent)",
                color: "var(--status-critical)",
              }}
            >
              never called
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
          {lead.ghlStageName ?? lead.stageLabel}
          {lead.campaignId && campaignNames[lead.campaignId]
            ? ` · ${campaignNames[lead.campaignId]}`
            : ""}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {lead.value !== null && lead.value > 0 && (
          <span className="tnum text-[12px]" style={{ color: "var(--text-secondary)" }}>
            {formatCurrency(lead.value)}
          </span>
        )}
        <span className="text-right">
          <span
            className="tnum block text-[13px] font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {days(lead.daysInStage)}
          </span>
          {/* The overdue amount, not just the age — an 18-day-old lead means
              nothing without the 5-day bar it is being judged against. */}
          <span className="tnum block text-[10.5px]" style={{ color: "var(--status-warning)" }}>
            +{days(over)} over
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * What the bar actually is, stated where it is used.
 *
 * The conditioning matters and is easy to misread: this is not "leads take 5
 * days", it is "of the leads that ever moved on, 90% had moved by day 5". The
 * ones still sitting are not in that figure — they are what it is being used to
 * find.
 */
function ThresholdNote({ s }: { s: StageAge }) {
  /*
   * 🔴 When almost nothing ever leaves a stage, the leads in it are not the
   * finding — the stage is. Found on live data: an Appointment Booked column
   * holding 48 leads flagged 46 of them, which reads as forty-six follow-up
   * calls and is really one sentence about a CRM nobody is updating. The bar
   * itself is meaningless there, because the handful of completed stays it was
   * measured from are the few that cancelled quickly.
   */
  if (s.stalled) {
    return (
      <p className="text-xs leading-relaxed" style={{ color: "var(--status-warning)" }}>
        Only {formatNumber(s.movers)} lead
        {s.movers === 1 ? " has" : "s have"} ever moved on from{" "}
        {s.label.toLowerCase()}, against {formatNumber(s.sitting)} sitting there
        now — so this is not {formatNumber(s.aging)} people to chase, it is a
        stage nothing leaves. Either the next step is not being recorded in
        GoHighLevel, or nobody is working this column. Fix that and these numbers
        become meaningful; until then the bar below is measured from the few that
        did move, which were mostly the ones that fell through quickly.
      </p>
    );
  }

  if (!s.measured) {
    return (
      <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Only {formatNumber(s.movers)} lead{s.movers === 1 ? " has" : "s have"} ever
        moved on from {s.label.toLowerCase()}, which is not enough to say what
        normal looks like here — so this uses a starting figure of{" "}
        {days(s.thresholdDays)} until the ledger can answer for itself.
      </p>
    );
  }
  return (
    <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
      Of the {formatNumber(s.movers)} leads that have ever moved on from{" "}
      {s.label.toLowerCase()}, 9 in 10 did so within {days(s.thresholdDays)} — so
      anything older is in the slowest tenth of what comes back. This is not how
      long leads take in general; leads still sitting are exactly what it is
      being used to find.
      {s.hopelessDays !== null && s.cold > 0 && (
        <>
          {" "}
          <span style={{ color: "var(--text-secondary)" }}>
            {formatNumber(s.cold)} more {s.cold === 1 ? "has" : "have"} been here
            longer than any lead that ever moved on ({days(s.hopelessDays)}). Those
            are a cleanup job rather than a call list, so they are counted and not
            listed.
          </span>
        </>
      )}
    </p>
  );
}

export function StageAgingPanel({
  data,
  campaignNames,
}: {
  data: AgingReport;
  campaignNames: Record<string, string>;
}) {
  const withAging = data.stages.filter((s) => s.aging > 0);
  const stalledStages = withAging.filter((s) => s.stalled);
  const actionable = withAging
    .filter((s) => !s.stalled)
    .reduce((n, s) => n + s.aging, 0);
  const [stage, setStage] = useState<string | null>(null);
  /*
   * Opens on the deepest stage that is actually a call list. A stalled stage
   * has the most rows and the least to do about them, so defaulting to it would
   * greet every reader with the one tab that is not a task.
   */
  const preferred = withAging.filter((s) => !s.stalled);
  const selected =
    stage ??
    (preferred[preferred.length - 1] ?? withAging[withAging.length - 1])?.stage ??
    null;
  const shown = selected ? data.leads.filter((l) => l.stage === selected) : data.leads;
  const selectedStage = data.stages.find((s) => s.stage === selected);

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Leads that have stopped moving
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
          Measured against how long leads normally sit in each stage here — not a
          fixed number of days
        </p>
      </div>
      {data.totalAging > 0 && (
        <div
          className="flex flex-wrap gap-1 rounded-[9px] p-0.5"
          style={{ background: "var(--surface-2)" }}
          role="group"
          aria-label="Stage"
        >
          {withAging.map((s) => (
            <StageChip
              key={s.stage}
              s={s}
              active={s.stage === selected}
              onClick={() => setStage(s.stage)}
            />
          ))}
        </div>
      )}
    </div>
  );

  /* --- Empty states, each naming its own cause ------------------------- */

  if (data.totalSitting === 0) {
    return (
      <section className="card p-5">
        {header}
        <p className="mt-5 text-sm" style={{ color: "var(--text-secondary)" }}>
          {data.unmapped > 0
            ? `${formatNumber(data.unmapped)} open ${data.unmapped === 1 ? "lead sits" : "leads sit"} in a GHL stage that is not mapped to anything, so none of them can be aged. Map those stages in Setup and this fills in immediately — the dates are already stored.`
            : data.undated > 0
              ? `${formatNumber(data.undated)} open ${data.undated === 1 ? "lead has" : "leads have"} no recorded date for when they entered their stage, so their age is unknown rather than zero. This fills in as they move.`
              : "No open leads are sitting in a stage they are expected to leave."}
        </p>
      </section>
    );
  }

  if (data.totalAging === 0) {
    return (
      <section className="card p-5">
        {header}
        <div className="mt-5 flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0" style={{ color: "var(--status-good)" }}>
            <Icon name="check" size={14} />
          </span>
          <div>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              {/* Real reassurance, and it names its denominator — "nothing is
                  overdue" is worth nothing without "out of how many". */}
              Nothing is overdue. All {formatNumber(data.totalSitting)} open leads
              are inside the time this pipeline normally takes at their stage.
            </p>
            {data.totalCold > 0 && (
              <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                {formatNumber(data.totalCold)} older{" "}
                {data.totalCold === 1 ? "lead has" : "leads have"} been sitting
                longer than anything that has ever moved on. They are not on this
                list because nothing like them comes back — worth archiving rather
                than calling.
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card p-5">
      {header}

      <div
        className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-[10px] p-3.5"
        style={{ background: "var(--surface-2)" }}
      >
        {/*
         * The headline counts only the stages where the number means "people to
         * chase". A stalled stage's leads are counted in the table and excluded
         * here, because leading with "60 overdue leads" when 46 of them are one
         * unused CRM column is the kind of impressive-looking, useless number
         * this product exists to stop printing.
         */}
        <span className="tnum text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
          {formatNumber(actionable)}
        </span>
        <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
          open lead{actionable === 1 ? "" : "s"} of{" "}
          <span className="tnum">{formatNumber(data.totalSitting)}</span> have sat
          longer than nine in ten that ever moved on
          {stalledStages.length > 0 && (
            <>
              , not counting{" "}
              <span className="tnum">{formatNumber(data.totalAging - actionable)}</span>{" "}
              in{" "}
              {stalledStages.map((s) => s.label.toLowerCase()).join(" and ")}, where
              nothing ever moves on at all
            </>
          )}
        </span>
      </div>

      <div className="mt-4 max-h-[420px] overflow-y-auto">
        {shown.map((l) => (
          <LeadRow key={l.opportunityId} lead={l} campaignNames={campaignNames} />
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {data.notListed > 0 && (
          /* 🔴 Never a silent truncation. A list that quietly stops at forty
             reads as "that is all of them", which is the same lie as a blank
             chart reading as a zero. */
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Showing the first {MAX_LISTED} of {formatNumber(data.totalAging)},
            deepest stage first — a lead that booked and drifted is a warmer call
            than one that filled in a form in March.
          </p>
        )}
        {selectedStage && <ThresholdNote s={selectedStage} />}
        {(data.unmapped > 0 || data.undated > 0) && (
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {data.unmapped > 0 && (
              <>
                {formatNumber(data.unmapped)} open lead
                {data.unmapped === 1 ? " sits" : "s sit"} in an unmapped GHL stage
                and cannot be aged at all.{" "}
              </>
            )}
            {data.undated > 0 && (
              <>
                {formatNumber(data.undated)} {data.undated === 1 ? "has" : "have"} no
                date for when they entered their stage.
              </>
            )}
          </p>
        )}
      </div>
    </section>
  );
}
