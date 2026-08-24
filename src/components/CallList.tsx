import {
  MAX_LISTED,
  type CallListRow,
  type UncalledKind,
  type UncalledReport,
} from "@/lib/metrics/uncalled";
import { formatCurrency, formatNumber } from "@/lib/metrics/compute";
import { Icon } from "@/components/Icon";

/**
 * Call these people.
 *
 * The only panel on this dashboard whose output is a task rather than a fact,
 * which changes what it has to get right. Nothing here is a percentage or a
 * trend; it is a list of names somebody rings this afternoon, and a single wrong
 * name — a lead a colleague already booked — costs more credibility than a
 * mis-rounded conversion rate ever could.
 *
 * So the panel is arranged around what it is *not* claiming:
 *
 * · everyone shown has a phone number and has never been phoned
 * · everyone shown arrived at least a full working day ago, counted on the days
 *   this client actually makes calls
 * · everyone already dealt with — booked, closed, or written off — is counted
 *   below the list, not inside it
 * · everyone whose call history predates the CRM connection is counted too, and
 *   never described as uncalled
 *
 * The four counts under the list exist because each of them is a lead somebody
 * might otherwise go looking for and fail to find.
 */

const KIND_LABEL: Record<UncalledKind, string> = {
  replied: "replied, never called",
  untouched: "no contact at all",
  messaged: "messaged, not called",
};

const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Mon–Fri" when the days are contiguous, otherwise the days themselves. */
function describeWeek(days: readonly number[]): string {
  if (days.length === 0) return "";
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  return contiguous && days.length > 2
    ? `${WEEKDAY[days[0]]}–${WEEKDAY[days[days.length - 1]]}`
    : days.map((d) => WEEKDAY[d]).join(", ");
}

function Row({
  row,
  campaignNames,
}: {
  row: CallListRow;
  campaignNames: Record<string, string>;
}) {
  const urgent = row.kind === "replied";
  return (
    <div
      className="flex items-center justify-between gap-3 border-t py-2.5"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px]" style={{ color: "var(--text-primary)" }}>
            {row.name ?? "Unnamed lead"}
          </span>
          <span
            className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide uppercase"
            style={{
              background: urgent
                ? "color-mix(in srgb, var(--status-critical) 14%, transparent)"
                : "var(--surface-2)",
              color: urgent ? "var(--status-critical)" : "var(--text-muted)",
            }}
          >
            {KIND_LABEL[row.kind]}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
          {/*
           * The number is the point of the row. Nothing else here is worth
           * anything if the reader has to open another tab to find it.
           */}
          <span className="tnum" style={{ color: "var(--text-secondary)" }}>
            {row.phone}
          </span>
          {" · "}
          {row.noOpportunity
            ? "no opportunity created"
            : (row.ghlStageName ?? row.stageLabel ?? "unmapped stage")}
          {row.campaignId && campaignNames[row.campaignId]
            ? ` · ${campaignNames[row.campaignId]}`
            : ""}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <span className="tnum block text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          {row.calendarDays}d
        </span>
        {/*
         * Both numbers, because they are different and the panel judges by the
         * second. "6 days ago" is what a person understands; "4 working days"
         * is what put them on the list, and a reader who sees only the first
         * over a weekend will think the panel cannot count.
         */}
        <span className="tnum block text-[10.5px]" style={{ color: "var(--text-muted)" }}>
          {row.workingDaysWaiting} working
        </span>
      </div>
    </div>
  );
}

export function CallListPanel({
  data,
  currency,
  campaignNames,
}: {
  data: UncalledReport;
  currency: string;
  campaignNames: Record<string, string>;
}) {
  const header = (
    <div>
      <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Call these people
      </h2>
      <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
        Leads nobody has phoned, at least a working day after they arrived
      </p>
    </div>
  );

  /* --- No call visibility at all --------------------------------------- */

  if (data.trackingStartedAt === null) {
    return (
      <section className="card p-5">
        {header}
        <p className="mt-5 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {/*
           * 🔴 The distinction the whole panel rests on. Every lead here has a
           * blank call time, and printing that as "nobody has called any of
           * them" would be the source spreadsheet's `SHOWN = 0 forever` rebuilt
           * faithfully: a confident zero standing in for an absence of data.
           */}
          No outbound calls have ever been recorded for this client, so there is
          nothing to compare against —{" "}
          <span className="tnum">{formatNumber(data.preTracking)}</span> leads
          have a blank call time and that means <em>unknown</em>, not{" "}
          <em>uncalled</em>. This fills in from the first call GoHighLevel
          reports.
        </p>
      </section>
    );
  }

  const since = new Date(data.trackingStartedAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  /* --- Nothing to call -------------------------------------------------- */

  if (data.callable === 0) {
    /*
     * 🔴 Two different empty states, because a green tick is a claim.
     *
     * Found on live data: this client's paid pipeline is fully called, and ten
     * other leads have been sitting unphoned for days. A check mark over
     * "everything has been called", with those ten counted in small text
     * underneath, is the reassuring-summary-with-the-problem-in-a-footnote
     * shape this product exists to replace. The tick appears only when there is
     * genuinely nobody to ring.
     */
    const clear = data.outsideFilter === 0;
    return (
      <section className="card p-5">
        {header}
        <div className="mt-5 flex items-start gap-2.5">
          <span
            className="mt-0.5 shrink-0"
            style={{ color: clear ? "var(--status-good)" : "var(--status-warning)" }}
          >
            {/* Amber, not green and not red: people are going unphoned, which
                is a problem — just not one these particular numbers own. */}
            <Icon name={clear ? "check" : "alert"} size={14} />
          </span>
          <div>
            <p className="text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {clear ? (
                <>Every lead that has been here longer than a working day has been phoned.</>
              ) : (
                <>
                  <span className="tnum" style={{ color: "var(--text-primary)" }}>
                    {formatNumber(data.outsideFilter)}
                  </span>{" "}
                  lead{data.outsideFilter === 1 ? "" : "s"} in the pipeline{" "}
                  {data.outsideFilter === 1 ? "has" : "have"} never been phoned —
                  none of them attributed to the ads, so they are counted here
                  rather than listed. Every <em>paid</em> lead older than a working
                  day has been called.
                </>
              )}
            </p>
            <Footnotes data={data} since={since} suppressOutside={!clear} />
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
        <span className="tnum text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
          {formatNumber(data.callable)}
        </span>
        <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
          lead{data.callable === 1 ? "" : "s"} nobody has phoned
          {data.wastedSpend !== null && (
            <>
              {" — "}
              {/*
               * The line only this dashboard can write. Every reporting tool in
               * the category has either the spend or the call record; this one
               * has both, and their product is the sentence that gets read out.
               */}
              <strong className="tnum">
                {formatCurrency(data.wastedSpend, currency)}
              </strong>{" "}
              of leads
            </>
          )}
          {data.replied > 0 && (
            <>
              .{" "}
              <span style={{ color: "var(--status-critical)" }}>
                <strong className="tnum">{formatNumber(data.replied)}</strong> of them
                wrote in and are waiting on a reply.
              </span>
            </>
          )}
        </span>
      </div>

      <div className="mt-4 max-h-[420px] overflow-y-auto">
        {data.rows.map((r) => (
          <Row key={r.contactId} row={r} campaignNames={campaignNames} />
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {data.notListed > 0 && (
          /* 🔴 Never a silent truncation — a list that quietly stops at
             twenty-five reads as "that is all of them". */
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Showing the first {MAX_LISTED} of {formatNumber(data.callable)}. Newest
            first, because whether someone still answers falls away fast — the
            lead from yesterday is a better call than the one from last month.
          </p>
        )}
        <Footnotes data={data} since={since} />
      </div>
    </section>
  );
}

/**
 * Everything the list deliberately does not contain.
 *
 * Each line is a lead somebody might go looking for. Left out, the panel is
 * quietly wrong about the size of the problem in whichever direction happens to
 * flatter it; spelled out, the reader can see exactly what was counted.
 */
function Footnotes({
  data,
  since,
  suppressOutside = false,
}: {
  data: UncalledReport;
  since: string;
  /** The empty state already leads with that number; repeating it reads as two. */
  suppressOutside?: boolean;
}) {
  const week = data.workingDays ? describeWeek(data.workingDays) : null;

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {(data.progressed > 0 || data.closedWithoutCall > 0) && (
        <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {data.progressed > 0 && (
            <>
              {/*
               * Genuinely interesting rather than housekeeping: leads booking
               * themselves without a phone call says the booking flow works,
               * and it is invisible on every other panel here.
               */}
              <span className="tnum">{formatNumber(data.progressed)}</span> uncalled{" "}
              {data.progressed === 1 ? "lead has" : "leads have"} booked or been seen
              without anyone phoning them, so they are not on the list.{" "}
            </>
          )}
          {data.closedWithoutCall > 0 && (
            <>
              <span className="tnum">{formatNumber(data.closedWithoutCall)}</span>{" "}
              {data.closedWithoutCall === 1 ? "was" : "were"} closed, lost or
              disqualified without a call.
            </>
          )}
        </p>
      )}

      {data.noPhone > 0 && (
        <p className="text-xs leading-relaxed" style={{ color: "var(--status-warning)" }}>
          {/* A different problem with a different fix — and one that gets worse
              silently, because a lead with no number never generates a
              complaint from anybody. */}
          <span className="tnum">{formatNumber(data.noPhone)}</span>{" "}
          {data.noPhone === 1 ? "lead has" : "leads have"} no phone number on the
          record and cannot be called at all. That is usually a lead form without
          a phone field, or an Instant Form that does not ask for one.
        </p>
      )}

      {data.outsideFilter > 0 && !suppressOutside && (
        <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {/*
           * 🔴 The rest of the dashboard is paid-only and says so. This panel is
           * a task list, and printing a short one while people sit unphoned
           * outside the filter would be true and useless at the same time.
           */}
          A further <span className="tnum">{formatNumber(data.outsideFilter)}</span>{" "}
          uncalled {data.outsideFilter === 1 ? "lead is" : "leads are"} outside the
          paid-lead filter these numbers use, so they are not listed above — but
          somebody still has to call them.
        </p>
      )}

      <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {/*
         * The method, in the one place it can be checked. If the working week is
         * wrong the reader knows it at a glance, which is worth more than any
         * amount of internal validation.
         */}
        Counted in working days
        {week ? (
          <>
            {" "}
            (
            <span style={{ color: "var(--text-secondary)" }}>{week}</span>, from when
            this team actually makes calls)
          </>
        ) : (
          " — too few calls recorded to tell which days this team works, so every day counts for now"
        )}
        . Call tracking began {since}
        {data.preTracking > 0 && (
          <>
            ;{" "}
            <span className="tnum">{formatNumber(data.preTracking)}</span> earlier
            lead{data.preTracking === 1 ? "" : "s"} cannot be judged, because a
            blank call time before that date means unknown rather than uncalled
          </>
        )}
        .
      </p>
    </div>
  );
}
