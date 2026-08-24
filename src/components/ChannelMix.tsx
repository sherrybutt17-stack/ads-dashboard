import type { ChannelMix, SideTotals } from "@/lib/metrics/channels";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/metrics/compute";
import { Icon } from "@/components/Icon";

/**
 * Paid against everything else — the retainer question, answered honestly.
 *
 * The order of the panel is the argument:
 *
 * 1. **Can this split be believed?** If the platform reports leads the CRM
 *    cannot find, the rest is misinformation and gets withheld.
 * 2. **Volume, not rate.** What paid adds, and what the pipeline looked like
 *    before it.
 * 3. **Rates, explicitly disarmed.** The non-paid side is referrals and repeat
 *    customers; of course it converts better. Shown, because hiding it would be
 *    the massaging this product replaces — framed, because presenting it as a
 *    verdict on the ads would be a lie by arrangement.
 */

function Side({
  label,
  totals,
  note,
  accent,
}: {
  label: string;
  totals: SideTotals;
  note: string;
  accent: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: accent }}
          aria-hidden="true"
        />
        <span className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          {label}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span
          className="tnum text-2xl font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          {formatNumber(totals.leads)}
        </span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          leads
        </span>
      </div>
      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px]">
        <span className="flex gap-1">
          <dt style={{ color: "var(--text-muted)" }}>booked</dt>
          <dd className="tnum" style={{ color: "var(--text-secondary)" }}>
            {formatNumber(totals.appointments)}
            {totals.bookRate !== null && (
              <span style={{ color: "var(--text-muted)" }}>
                {" "}
                ({formatPercent(totals.bookRate, 0)})
              </span>
            )}
          </dd>
        </span>
        <span className="flex gap-1">
          <dt style={{ color: "var(--text-muted)" }}>closed</dt>
          <dd className="tnum" style={{ color: "var(--text-secondary)" }}>
            {formatNumber(totals.won)}
          </dd>
        </span>
      </dl>
      <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {note}
      </p>
    </div>
  );
}

/** The monthly split as stacked bars — the shape of the volume question. */
function MonthlyBars({ data, currency }: { data: ChannelMix; currency: string }) {
  const rows = [...data.rows].sort((a, b) => (a.month < b.month ? -1 : 1));
  const max = rows.reduce((m, r) => Math.max(m, r.paidLeads + r.otherLeads), 0) || 1;

  return (
    <div className="table-scroll">
      <div className="flex min-w-[420px] items-end gap-1.5" style={{ height: 92 }}>
        {rows.map((r) => {
          const total = r.paidLeads + r.otherLeads;
          return (
            <div key={r.month} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="flex w-full flex-col justify-end"
                style={{ height: 72 }}
                title={`${r.label}: ${r.paidLeads} paid, ${r.otherLeads} other${
                  r.spend !== null ? `, ${formatCurrency(r.spend, currency)} spend` : ", no ad data"
                }`}
              >
                <div
                  className="w-full rounded-t-[3px]"
                  style={{
                    height: `${(r.otherLeads / max) * 100}%`,
                    background: "var(--series-3)",
                  }}
                />
                <div
                  className="w-full"
                  style={{
                    height: `${(r.paidLeads / max) * 100}%`,
                    background: "var(--series-1)",
                    borderRadius: r.otherLeads === 0 ? "3px 3px 0 0" : undefined,
                  }}
                />
              </div>
              <span
                className="tnum text-[9px] whitespace-nowrap"
                style={{ color: total > 0 ? "var(--text-muted)" : "transparent" }}
              >
                {r.label.slice(0, 3)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChannelMixPanel({
  data,
  currency,
  splitDefinable,
  filterMode,
}: {
  data: ChannelMix;
  currency: string;
  splitDefinable: boolean;
  filterMode: string;
}) {
  const header = (
    <div>
      <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Is the advertising adding anything?
      </h2>
      <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
        Paid leads against everything else that reached the pipeline, month by month
      </p>
    </div>
  );

  if (!splitDefinable) {
    return (
      <section className="card p-5">
        {header}
        <p className="mt-5 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {/*
           * A configuration fact, not a data problem, and worth stating rather
           * than rendering as a 100/0 split that would look like a result.
           */}
          This client is set to count <strong>every</strong> lead in the pipeline
          as paid ({filterMode}), so there is no other side to compare against.
          Change the lead filter in Setup to separate them.
        </p>
      </section>
    );
  }

  const { trust } = data;

  return (
    <section className="card p-5">
      {header}

      {/* --- 1 · Can this be believed? --------------------------------- */}
      {trust.level !== "usable" && (
        <div
          className="mt-4 flex items-start gap-2.5 rounded-[10px] p-3.5"
          style={{
            background:
              trust.level === "broken"
                ? "color-mix(in srgb, var(--status-critical) 10%, transparent)"
                : "var(--surface-2)",
          }}
        >
          <span
            className="mt-0.5 shrink-0"
            style={{
              color:
                trust.level === "broken"
                  ? "var(--status-critical)"
                  : "var(--status-warning)",
            }}
          >
            <Icon name="alert" size={14} />
          </span>
          <div className="text-[13px] leading-relaxed" style={{ color: "var(--text-primary)" }}>
            {trust.platformLeads > 0 ? (
              <>
                <strong>
                  {trust.level === "broken"
                    ? "This split cannot be trusted right now."
                    : "This split is missing some paid leads."}
                </strong>{" "}
                The ad platform reports{" "}
                <span className="tnum">{formatNumber(trust.platformLeads)}</span> leads
                over this period; only{" "}
                <span className="tnum">{formatNumber(trust.matchedLeads)}</span> could
                be matched to a campaign in the CRM. The rest are sitting on the
                &ldquo;everything else&rdquo; side of this panel, which makes the
                advertising look weaker and the rest of the pipeline look stronger
                than either is.{" "}
                {trust.gapMonths.length > 0 && (
                  <>
                    Worst in {trust.gapMonths.slice(-3).join(", ")}.{" "}
                  </>
                )}
                {/*
                 * 🔴 The fix is named, because this is an attribution setup
                 * problem the operator can actually resolve — not an
                 * unexplained caveat to be scrolled past.
                 */}
                Usually the ad URL parameters, or Instant Form leads arriving
                without UTMs.
              </>
            ) : (
              <>
                No ad-platform lead figures for this period, so there is nothing to
                check the split against. It may be right; nothing here confirms it.
              </>
            )}
          </div>
        </div>
      )}

      {/* --- 2 · Volume ------------------------------------------------- */}
      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        <Side
          label="From the ads"
          totals={data.paid}
          accent="var(--series-1)"
          note={
            data.costPerPaidLead === null
              ? "No spend recorded against these."
              : `${formatCurrency(data.costPerPaidLead, currency)} each, from ${formatCurrency(data.spend, currency)} of spend.`
          }
        />
        <Side
          label="Everything else"
          totals={data.other}
          accent="var(--series-3)"
          /*
           * 🔴 Never labelled "organic". This bucket is referrals, walk-ins,
           * repeat customers — and any paid lead whose attribution failed. The
           * note says so at the point of reading rather than in a footnote
           * nobody reaches.
           */
          note="Referrals, repeat customers, walk-ins — plus any paid lead whose attribution did not arrive."
        />
      </div>

      <div className="mt-5">
        <MonthlyBars data={data} currency={currency} />
      </div>

      {/* --- 3 · What the volume means ---------------------------------- */}
      <div className="mt-4 flex flex-col gap-2">
        {data.baseline && (
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            In the {data.baseline.months} months before any ad data was recorded
            here, the pipeline received a median of{" "}
            <strong className="tnum">{formatNumber(data.baseline.medianLeads)}</strong>{" "}
            leads a month. Since then it has been{" "}
            <strong className="tnum">{formatNumber(data.baseline.medianSince)}</strong>.{" "}
            <span style={{ color: "var(--text-muted)" }}>
              {/* 🔴 "No ad data" is not "no ads were running" — the dashboard
                  cannot know what happened before it was connected, and saying
                  so is the difference between evidence and a sales line. */}
              That is what the pipeline received, not proof of what caused it —
              the dashboard has no visibility of anything running before it was
              connected.
            </span>
          </p>
        )}

        <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {data.cannibalisation.verdict === "possible" ? (
            <span style={{ color: "var(--status-warning)" }}>
              Across {data.cannibalisation.months} months, the rest of the pipeline
              tends to be <strong>smaller</strong> in the months with the most
              spend (rank correlation {data.cannibalisation.rho?.toFixed(2)}, p ={" "}
              {data.cannibalisation.p?.toFixed(2)}). That is worth understanding
              before scaling: some of what is being paid for may be leads that
              would have arrived anyway.
            </span>
          ) : data.cannibalisation.verdict === "no_sign" ? (
            <>
              Across {data.cannibalisation.months} months, the rest of the pipeline
              does not shrink in the months with the most spend — so the paid leads
              look like additions rather than leads that would have arrived anyway.
            </>
          ) : data.cannibalisation.verdict === "not_measurable" ? (
            <>
              Spend has been flat enough across these months that there is no
              variation to test whether paid is displacing the rest of the pipeline.
            </>
          ) : (
            /* 🔴 Never rendered as reassurance. A correlation over five points
               detects nothing, and "no sign of cannibalisation" drawn from that
               would be a guarantee made out of silence. */
            <>
              {data.cannibalisation.months} months of spend history so far — not
              enough to tell whether paid is adding to the rest of the pipeline or
              displacing it. That needs about eight.
            </>
          )}
        </p>

        <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {/*
           * The disarming sentence. Without it the booking rates above are an
           * argument for cancelling the retainer, drawn from a comparison that
           * was never valid.
           */}
          <strong>Per-lead rates are not a verdict on the ads.</strong> The other
          side includes referrals and returning customers, who are the warmest
          leads any business gets and will almost always convert better. What paid
          can be judged on is the volume it adds at a known price
          {data.costPerPaidLead !== null && (
            <> — {formatCurrency(data.costPerPaidLead, currency)} a lead here</>
          )}
          , which is a number the rest of the pipeline does not have and cannot be
          bought more of.
        </p>
      </div>
    </section>
  );
}
