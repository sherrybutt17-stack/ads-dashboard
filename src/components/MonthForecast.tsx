import {
  MATURING_STAGES,
  MIN_COMPLETE_DAYS,
  type ForecastMetric,
  type ForecastReport,
} from "@/lib/metrics/forecast";
import { formatCurrency, formatNumber, pctChange } from "@/lib/metrics/compute";

/**
 * Where this month lands.
 *
 * ── The band is not decoration ────────────────────────────────────────
 *
 * A single projected number gets read as a prediction and quoted back in a
 * meeting. The interval is what makes it a projection: on the 8th it is wide
 * enough that nobody would quote it, and by the 25th it is narrow enough to act
 * on. That change over the month is the honest content of this panel, and it is
 * why the range renders at the same weight as the point estimate rather than as
 * a footnote beneath it.
 *
 * ── Why the comparison is to last month's WHOLE total ─────────────────
 *
 * Not to last month at the same date. Same-date pacing is the more flattering
 * comparison and the less useful one: the question an operator has on the 12th
 * is "are we going to land where we landed last month", and that is a question
 * about the finished total.
 */

function Metric({
  metric,
  currency,
}: {
  metric: ForecastMetric;
  currency: string;
}) {
  const isMoney = metric.key === "spend";
  const fmt = (v: number) =>
    isMoney ? formatCurrency(v, currency) : formatNumber(Math.round(v));

  const change =
    metric.previous !== null && metric.previous > 0
      ? pctChange(metric.projected, metric.previous)
      : null;

  return (
    <div>
      <p className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
        {metric.label}
      </p>
      <p
        className="tnum mt-0.5 text-[26px] font-semibold leading-none tracking-tight"
        style={{ color: "var(--text-primary)" }}
      >
        {fmt(metric.projected)}
      </p>
      <p className="tnum mt-1.5 text-[12px]" style={{ color: "var(--text-secondary)" }}>
        {fmt(metric.low)} – {fmt(metric.high)}
      </p>
      <p className="tnum mt-1 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
        {fmt(metric.observed)} so far
        {metric.previous !== null && (
          <>
            {" · "}
            {fmt(metric.previous)} last month
            {/*
             * Uncoloured, on purpose. More spend is not good or bad — it is a
             * decision — and more leads at an unknown cost is not either. The
             * polarity-aware colouring on the KPI row above is earned by
             * metrics that have a direction; this one does not.
             */}
            {change !== null && (
              <> ({change >= 0 ? "+" : "−"}{Math.abs(change).toFixed(0)}%)</>
            )}
          </>
        )}
      </p>
    </div>
  );
}

export function MonthForecast({
  report,
  currency,
}: {
  report: ForecastReport;
  currency: string;
}) {
  const { verdict, completeDays, remainingDays, daysInMonth } = report;

  return (
    <section className="card p-5" aria-label="Month-end forecast">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Where this month lands
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            {/*
             * States the cadence exception in the subtitle rather than relying
             * on the section badge. This is the one panel a reader is most
             * likely to assume follows the date picker, because every other
             * number they just scrolled past does.
             */}
            This calendar month, whatever range is selected above — projected
            from the days already complete.
          </p>
        </div>
        {verdict === "ok" && (
          <span className="tnum text-[12px]" style={{ color: "var(--text-secondary)" }}>
            {completeDays} of {daysInMonth} days in
          </span>
        )}
      </div>

      {verdict !== "ok" ? (
        <p
          className="mt-4 rounded-[10px] border px-3 py-2.5 text-[13px] leading-relaxed"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: "var(--text-secondary)",
          }}
        >
          {verdict === "month_over" ? (
            <>
              The month is complete — these are results, not a projection. Last
              month&apos;s totals are in the tables below.
            </>
          ) : verdict === "too_early" ? (
            <>
              <strong style={{ color: "var(--text-primary)" }}>
                Too early to project.
              </strong>{" "}
              {completeDays === 0
                ? "No day of this month has finished yet."
                : `Only ${completeDays} complete ${completeDays === 1 ? "day" : "days"} so far.`}{" "}
              Multiplying that across {remainingDays} remaining days would
              produce a number with more error in it than signal. This fills in
              from day {MIN_COMPLETE_DAYS + 1}.
            </>
          ) : (
            <>
              Nothing has been recorded for this month yet — so there is nothing
              to project from. If ads are running, this is worth checking against
              the connection health page rather than reading as a quiet month.
            </>
          )}
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-5 sm:grid-cols-3">
            {report.metrics.map((m) => (
              <Metric key={m.key} metric={m} currency={currency} />
            ))}
            <div>
              <p className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                Cost per lead
              </p>
              <p
                className="tnum mt-0.5 text-[26px] font-semibold leading-none tracking-tight"
                style={{ color: "var(--text-primary)" }}
              >
                {report.projectedCpl === null
                  ? "–"
                  : formatCurrency(report.projectedCpl, currency)}
              </p>
              <p
                className="tnum mt-1.5 text-[12px]"
                style={{ color: "var(--text-secondary)" }}
              >
                {/*
                 * No band on this one. It is a ratio of two projections whose
                 * errors are correlated — a month that runs hot runs hot on
                 * both — so combining the two intervals independently would
                 * produce a range far wider than the real uncertainty and
                 * imply a precision claim we cannot support either way.
                 */}
                at the projected spend and leads
              </p>
              <p className="tnum mt-1 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                {report.observedCpl === null
                  ? "– so far"
                  : `${formatCurrency(report.observedCpl, currency)} so far`}
              </p>
            </div>
          </div>

          <p
            className="mt-4 text-[11.5px] leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            Ranges are an 80% interval — four months in five land inside one.{" "}
            {report.weekdayWeighted ? (
              <>
                Days still to come are weighted by weekday, because the days
                already elapsed are not an even sample of the month.
              </>
            ) : (
              <>
                Projected at a flat daily rate: this month has not yet shown a
                weekday pattern strong enough to weight by.
              </>
            )}{" "}
            Today is projected rather than counted, since it is still running.
          </p>

          <p
            className="mt-2 text-[11px] leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            {MATURING_STAGES}
          </p>
        </>
      )}
    </section>
  );
}
