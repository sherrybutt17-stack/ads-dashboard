"use client";

import { useState } from "react";
import { DASH, formatNumber, formatPercent } from "@/lib/metrics/compute";
import {
  DIMENSION_BLURB,
  DIMENSION_CAVEAT,
  DIMENSION_LABEL,
  MIN_LEADS_FOR_RATE,
  type LeadSourceDimension,
  type LeadSourceReport,
} from "@/lib/metrics/lead-sources";
import { DataState } from "@/components/DataState";
import { Icon } from "@/components/Icon";

/**
 * Where leads actually come from — the page they were standing on, the form
 * that captured them, the mechanism GHL recorded.
 *
 * The sibling of `Breakdowns`, and deliberately built to look like it: same
 * card, same bar, same table rhythm. They answer adjacent halves of one
 * question — that panel is Meta's delivery segments, this one is the CRM's
 * capture points — and making them look like two unrelated features would hide
 * that they can be read together.
 *
 * The bar encodes LEADS, one hue, magnitude only. No categorical palette is
 * involved: every row is the same kind of thing, so giving rows different hues
 * would imply an identity distinction that does not exist.
 */

/** Rows before "show all". A busy account can carry dozens of URLs. */
const VISIBLE_ROWS = 8;

const ORDER: readonly LeadSourceDimension[] = ["page", "form", "medium"];

export function LeadSources({ data }: { data: LeadSourceReport }) {
  const [dimension, setDimension] = useState<LeadSourceDimension>("page");
  const [expanded, setExpanded] = useState(false);

  const group = data.groups.find((g) => g.dimension === dimension) ?? data.groups[0];
  const rows = expanded ? group.rows : group.rows.slice(0, VISIBLE_ROWS);
  const hidden = group.rows.length - rows.length;

  // Scaled to the largest ROW, not to the attributed total — otherwise one
  // dominant page renders every other bar as an unreadable sliver.
  const max = group.rows.reduce((m, r) => Math.max(m, r.leads), 0);

  const coverage =
    data.totalLeads > 0 ? group.attributedLeads / data.totalLeads : 0;

  return (
    <section className="card overflow-hidden" aria-label="Which pages and forms bring leads">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Which pages and forms bring leads
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            Leads that arrived in this range, and how many of them went on to book.
          </p>
        </div>

        {/* Filters in one row above the table, per the interaction spec. */}
        <div
          className="flex rounded-md p-0.5"
          style={{ background: "var(--surface-2)" }}
          role="tablist"
          aria-label="Group leads by"
        >
          {ORDER.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={d === dimension}
              onClick={() => {
                setDimension(d);
                setExpanded(false);
              }}
              className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={
                d === dimension
                  ? { background: "var(--surface-1)", color: "var(--text-primary)" }
                  : { color: "var(--text-muted)" }
              }
            >
              {DIMENSION_LABEL[d]}
            </button>
          ))}
        </div>
      </div>

      {group.attributedLeads === 0 ? (
        <div className="border-t px-5 pb-5" style={{ borderColor: "var(--border)" }}>
          <div className="pt-5">
            <DataState
              title={
                data.totalLeads === 0
                  ? "No leads in this period"
                  : "No lead carries capture details in this period"
              }
              detail={
                data.totalLeads === 0
                  ? "Nothing arrived in this date range."
                  : `All ${formatNumber(data.totalLeads)} leads here predate attribution capture, so the page and form they came through was never recorded. Newer leads carry it.`
              }
              tone="neutral"
              size="compact"
            />
          </div>
        </div>
      ) : (
        <div className="border-t px-5 py-4" style={{ borderColor: "var(--border)" }}>
          <div className="mb-3">
            <h3 className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
              {DIMENSION_LABEL[dimension]}
            </h3>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
              {DIMENSION_BLURB[dimension]}
            </p>
            {DIMENSION_CAVEAT[dimension] && (
              /*
               * Rendered above the table, in the warning tone, because it
               * changes how every row below it should be read. Under the table
               * it would be met after the conclusion it exists to prevent.
               */
              <p
                className="mt-1.5 flex items-start gap-1.5 text-[11px]"
                style={{ color: "var(--status-warning)" }}
              >
                <span className="mt-px shrink-0">
                  <Icon name="alert" size={11} />
                </span>
                <span>{DIMENSION_CAVEAT[dimension]}</span>
              </p>
            )}
          </div>

          <table className="w-full text-[12px]">
            {/*
              A real <caption> rather than a note underneath, so a screen reader
              meets the two caveats BEFORE the rows they qualify — the same
              reasoning as the breakdowns panel next door.
            */}
            <caption
              className="caption-bottom pt-2 text-left text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              Book % is left as {DASH} below {MIN_LEADS_FOR_RATE} leads — three
              leads and three bookings is 100% and means nothing. Counts every
              lead, paid or not, so this total is larger than the cost panels
              above, which count only leads matched to ad spend.
            </caption>
            <thead>
              <tr style={{ color: "var(--text-muted)" }}>
                <th className="pb-1.5 text-left text-[10px] font-semibold uppercase tracking-wider">
                  {DIMENSION_LABEL[dimension]}
                </th>
                <th className="pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider">
                  Leads
                </th>
                <th className="hidden pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider sm:table-cell">
                  Appts
                </th>
                <th className="pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider">
                  Book %
                </th>
                <th className="hidden pb-1.5 text-right text-[10px] font-semibold uppercase tracking-wider sm:table-cell">
                  Won
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.value} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="py-1.5 pr-2">
                    <span
                      className="block max-w-[260px] truncate"
                      title={
                        r.isResidual
                          ? "These leads were captured with attribution, but not through a page of ours — a manual entry, a calendar booking or a DM. A real group, not missing data."
                          : r.title
                      }
                      style={{
                        color: r.isResidual ? "var(--text-muted)" : "var(--text-primary)",
                      }}
                    >
                      {r.value}
                    </span>
                    <div
                      className="mt-1 h-1 rounded-full"
                      style={{ background: "var(--surface-2)" }}
                      aria-hidden="true"
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${max > 0 ? Math.max(2, (r.leads / max) * 100) : 0}%`,
                          background: "var(--seq-450)",
                        }}
                      />
                    </div>
                  </td>
                  <td
                    className="tnum py-1.5 text-right align-top"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {formatNumber(r.leads)}
                  </td>
                  <td
                    className="tnum hidden py-1.5 text-right align-top sm:table-cell"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {formatNumber(r.appts)}
                  </td>
                  <td
                    className="tnum py-1.5 text-right align-top"
                    style={{ color: "var(--text-secondary)" }}
                    title={
                      r.bookRate === null
                        ? `${formatNumber(r.appts)} of ${formatNumber(r.leads)} booked — too few leads to state as a rate.`
                        : undefined
                    }
                  >
                    {r.bookRate === null ? DASH : formatPercent(r.bookRate, 0)}
                  </td>
                  <td
                    className="tnum hidden py-1.5 text-right align-top sm:table-cell"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {formatNumber(r.won)}
                  </td>
                </tr>
              ))}
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

          {/*
            🔴 Coverage, stated as coverage — never as a row in the table.

            The unattributed leads are overwhelmingly the historical import: no
            phone, no email, never worked. Ranked beside a real landing page
            they would hand that page credit for the difference between a lead
            and a spreadsheet row — the confound `quality.ts` documents in full.
            So the number is shown, prominently, and given no rate and no rank.
          */}
          {data.unattributedLeads > 0 && (
            <div
              className="mt-3 flex items-start gap-1.5 border-t pt-3 text-[11px]"
              style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
            >
              <span className="mt-px shrink-0">
                <Icon name="help" size={11} />
              </span>
              <span>
                Based on{" "}
                <span className="tnum" style={{ color: "var(--text-secondary)" }}>
                  {formatNumber(group.attributedLeads)}
                </span>{" "}
                of {formatNumber(data.totalLeads)} leads ({formatPercent(coverage, 0)}).
                The other{" "}
                <span className="tnum">{formatNumber(data.unattributedLeads)}</span>{" "}
                carry no capture details at all — almost entirely the historical
                import, which arrived before this was recorded. They are left out
                of the table rather than shown as a source, because they are older
                and were largely never worked: ranked against a real page they
                would make it look several times better than it is.
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
