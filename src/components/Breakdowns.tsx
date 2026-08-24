"use client";

import { useState } from "react";
import { DASH, formatCurrency, formatNumber, formatPercent } from "@/lib/metrics/compute";
import type { BreakdownGroup, Breakdowns as BreakdownData } from "@/lib/metrics/queries";
import type { SegmentBenchmark } from "@/lib/metrics/benchmark";
import type { BreakdownKey } from "@/db/schema";
import { DataState, PipeNotice, type DataStateProps } from "@/components/DataState";
import { Icon } from "@/components/Icon";

/**
 * Where the money actually went — by region, placement, device, age and gender.
 *
 * The reason this is worth building for a local service business: clicks forty
 * miles outside the service area are usually the single largest silent waste in
 * an account, and nothing at campaign level can reveal them.
 *
 * 🔴 **The segments do not add up to the account total, and that is correct.**
 * Meta withholds any segment whose audience falls below its privacy threshold.
 * A reader who sums the age rows, finds them short of the headline spend and
 * concludes the dashboard is broken is exactly the failure this component is
 * built to prevent — so the shortfall is rendered as its own row, in the table,
 * labelled, rather than left to be discovered by subtraction.
 */

const LABEL: Record<BreakdownKey, string> = {
  region: "Region",
  placement: "Placement",
  device: "Device",
  age: "Age",
  gender: "Gender",
};

const BLURB: Record<BreakdownKey, string> = {
  region:
    "Spend outside the service area is the most common silent waste in a local account.",
  placement: "Which surface the ad ran on — feed, stories, reels, and where.",
  device: "What people were holding when they saw it.",
  age: "Which age brackets the budget actually reached.",
  gender: "How the budget split by gender.",
};

/** How many rows to show before "show all". Region can run to dozens. */
const VISIBLE_ROWS = 8;

export function Breakdowns({
  data,
  currency,
  emptyState,
}: {
  data: BreakdownData;
  currency: string;
  emptyState?: DataStateProps | null;
}) {
  const populated = data.groups.filter((g) => !g.missing);

  return (
    <section className="card overflow-hidden">
      <div className="px-5 py-4">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Where the money went
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
          Spend split by audience segment, across the whole account.
        </p>
      </div>

      {populated.length === 0 ? (
        <div className="border-t px-5 pb-5" style={{ borderColor: "var(--border)" }}>
          <div className="pt-5">
            <DataState
              {...(emptyState ??
                (data.everSynced
                  ? {
                      title: "No segmented delivery in this period",
                      detail:
                        "Breakdowns are syncing — nothing was delivered in this date range.",
                      tone: "neutral" as const,
                    }
                  : {
                      /*
                       * Same distinction the creative grid draws: breakdown
                       * reporting starts from the date it was switched on, and a
                       * range before that has real spend and genuinely no
                       * segment rows. "No delivery" would be false.
                       */
                      title: "No breakdown data for this range",
                      detail:
                        "Audience breakdowns start from the first sync that collected them. Totals above are unaffected; pick a more recent range.",
                      tone: "neutral" as const,
                    }))}
              size="compact"
            />
          </div>
        </div>
      ) : (
        <>
          {emptyState && (
            <div className="px-5 pb-1">
              <PipeNotice {...emptyState} />
            </div>
          )}
          <div className="grid gap-px border-t lg:grid-cols-2" style={{ borderColor: "var(--border)", background: "var(--border)" }}>
            {populated.map((g) => (
              <BreakdownPanel
                key={g.key}
                group={g}
                currency={currency}
                singleDay={data.singleDay}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function BreakdownPanel({
  group,
  currency,
  singleDay,
}: {
  group: BreakdownGroup;
  currency: string;
  singleDay: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? group.segments : group.segments.slice(0, VISIBLE_ROWS);
  const hidden = group.segments.length - rows.length;

  // Bars are scaled to the largest SEGMENT, not to total spend — otherwise a
  // breakdown with one dominant segment renders every other bar as a sliver.
  const max = group.segments.reduce((m, s) => Math.max(m, s.spend), 0);

  const gapShare =
    group.unsegmentedSpend > 0 && group.segmentedSpend + group.unsegmentedSpend > 0
      ? group.unsegmentedSpend / (group.segmentedSpend + group.unsegmentedSpend)
      : 0;

  return (
    <div className="p-5" style={{ background: "var(--surface-1)" }}>
      <div className="mb-3">
        <h3 className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          {LABEL[group.key]}
        </h3>
        <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {BLURB[group.key]}
        </p>
      </div>

      <table className="w-full text-[12px]">
        {/*
          A real <caption>, not a paragraph after the table: it associates the
          note with the table for a screen reader, which reads it BEFORE the
          rows — so the second line inside the CP-Lead cells is explained before
          it is met rather than after.

          The second sentence is the load-bearing one. Most rows in a real panel
          carry no marker, because most segments hold too few leads to say
          anything, and a column of blanks with no explanation reads as a bug.
        */}
        {group.cpLead !== null && (
          <caption
            className="caption-bottom pt-2 text-left text-[10px]"
            style={{ color: "var(--text-muted)" }}
            title="Measured against the average of the segments listed here, not against the whole account — Meta withholds segments below its privacy threshold, and it withholds a different share in each panel, so an account-wide figure would judge the same segment differently depending on which panel it appeared in."
          >
            CP-Lead compared against this panel&rsquo;s average of{" "}
            <span className="tnum">{formatCurrency(group.cpLead, currency)}</span>.
            Segments holding too few leads to call are left unmarked.
          </caption>
        )}
        <thead>
          <tr style={{ color: "var(--text-muted)" }}>
            <th className="pb-1.5 text-left text-[10px] font-semibold uppercase tracking-wider">
              {LABEL[group.key]}
            </th>
            <th className="pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider">
              Spend
            </th>
            <th className="hidden pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider sm:table-cell">
              Leads
            </th>
            <th className="pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider">
              CP-Lead
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.value} className="border-t" style={{ borderColor: "var(--border)" }}>
              <td className="py-1.5 pr-2">
                <div className="flex items-center gap-2">
                  <span
                    className="max-w-[150px] truncate"
                    style={{
                      color:
                        s.value.toLowerCase() === "unknown"
                          ? "var(--text-muted)"
                          : "var(--text-primary)",
                    }}
                    title={
                      s.value.toLowerCase() === "unknown"
                        ? "Meta could not classify these impressions. Kept separate rather than folded into a real segment, which would overstate it."
                        : s.value
                    }
                  >
                    {s.value}
                  </span>
                </div>
                <div
                  className="mt-1 h-1 rounded-full"
                  style={{ background: "var(--surface-2)" }}
                  aria-hidden="true"
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${max > 0 ? Math.max(2, (s.spend / max) * 100) : 0}%`,
                      background: "var(--seq-450)",
                    }}
                  />
                </div>
              </td>
              <td className="tnum py-1.5 text-right align-top" style={{ color: "var(--text-primary)" }}>
                {formatCurrency(s.spend, currency)}
                {s.shareOfSegmented !== null && (
                  <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    {formatPercent(s.shareOfSegmented, 0)}
                  </div>
                )}
              </td>
              <td
                className="tnum hidden py-1.5 text-right align-top sm:table-cell"
                style={{ color: "var(--text-secondary)" }}
              >
                {formatNumber(s.leads)}
              </td>
              <td className="tnum py-1.5 text-right align-top" style={{ color: "var(--text-secondary)" }}>
                {s.cpLead === null ? DASH : formatCurrency(s.cpLead, currency)}
                <BenchmarkChip
                  benchmark={s.benchmark}
                  panelCpLead={group.cpLead}
                  currency={currency}
                />
              </td>
            </tr>
          ))}

          {/*
            The reconciliation row. Meta suppresses segments below its privacy
            threshold, so these rows genuinely do not sum to account spend. Shown
            IN the table, as a row, because a footnote below a table of numbers is
            read by nobody and the arithmetic not working is the first thing a
            careful reader notices.
          */}
          {group.unsegmentedSpend > 0 && (
            <tr className="border-t" style={{ borderColor: "var(--border)" }}>
              <td className="py-1.5 pr-2" style={{ color: "var(--text-muted)" }}>
                <span
                  className="flex items-center gap-1"
                  title="Meta withholds any segment whose audience falls below its privacy threshold. This is the spend those hidden segments account for — it is expected, not an error."
                >
                  <Icon name="help" size={11} />
                  Not broken out by Meta
                </span>
              </td>
              <td className="tnum py-1.5 text-right align-top" style={{ color: "var(--text-muted)" }}>
                {formatCurrency(group.unsegmentedSpend, currency)}
                <div className="text-[10px]">{formatPercent(gapShare, 0)}</div>
              </td>
              <td className="hidden sm:table-cell" />
              <td />
            </tr>
          )}
        </tbody>
      </table>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-[11px] underline underline-offset-2"
          style={{ color: "var(--text-muted)" }}
        >
          Show {formatNumber(hidden)} more
        </button>
      )}
      {expanded && group.segments.length > VISIBLE_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2 text-[11px] underline underline-offset-2"
          style={{ color: "var(--text-muted)" }}
        >
          Show fewer
        </button>
      )}

      {!singleDay && (
        <p className="mt-2 text-[10px]" style={{ color: "var(--text-muted)" }}>
          Reach is not shown per segment across a date range — one person seen on
          two placements would be counted twice.
        </p>
      )}
    </div>
  );
}

/**
 * The verdict line under a segment's cost per lead.
 *
 * 🔴 **Direction respects the metric's polarity.** Cost per lead falls when
 * things go well, so a segment BELOW the panel average is green and one above
 * is red — the opposite of what a naive "up is good" delta would paint, and the
 * exact inversion that would turn the most efficient region in the account red.
 *
 * Never colour alone: the sign carries the direction and the words carry the
 * finding, so the row still reads on a monochrome print, in forced-colors mode,
 * and to a reader who cannot separate the two hues.
 *
 * "vs avg" is repeated on every marked row rather than left to the caption
 * because the cell one column to the left already shows a bare percentage — the
 * segment's share of spend. Two unlabelled percentages side by side, meaning
 * different things, is the spreadsheet failure this product replaced.
 */
function BenchmarkChip({
  benchmark,
  panelCpLead,
  currency,
}: {
  benchmark: SegmentBenchmark;
  panelCpLead: number | null;
  currency: string;
}) {
  if (benchmark.verdict === "none") return null;

  if (benchmark.verdict === "no_leads") {
    return (
      <div
        className="text-[10px] font-medium"
        style={{ color: "var(--delta-bad)" }}
        title={
          `This segment spent money and produced no leads at all, so it has no cost per lead to show — ` +
          `which is why the figure above is blank rather than large. At the panel's average of ` +
          `${formatCurrency(panelCpLead, currency)} that spend would have bought about ` +
          `${Math.round(benchmark.expectedLeads)} leads.`
        }
      >
        no leads
      </div>
    );
  }

  const costlier = benchmark.verdict === "costlier";
  return (
    <div
      className="tnum text-[10px] font-medium"
      style={{ color: costlier ? "var(--delta-bad)" : "var(--delta-good)" }}
      title={
        `${costlier ? "Dearer" : "Cheaper"} per lead than the average of the segments in this panel ` +
        `(${formatCurrency(panelCpLead, currency)}), by more than this segment's lead count could ` +
        `explain by chance.`
      }
    >
      {costlier ? "+" : "−"}
      {formatPercent(Math.abs(benchmark.gap), 0)} vs avg
    </div>
  );
}
