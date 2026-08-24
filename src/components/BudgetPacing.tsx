import { formatCurrency, DASH } from "@/lib/metrics/compute";
import { Icon } from "./Icon";
import type { MonthPacing } from "@/lib/budgets";

/**
 * Budget pacing: spend against what the client agreed to spend, and where the
 * month is heading.
 *
 * ── Why a meter and not a chart ───────────────────────────────────────
 *
 * There is one quantity (spend) measured against one reference (budget), and
 * the question is "how far along, and is that the right amount". That is a
 * magnitude-against-a-target, which is a meter's job — a chart here would plot
 * a single point against a line and make a glance into a reading exercise.
 *
 * ── 🔴 The two-segment fill ───────────────────────────────────────────
 *
 * The bar is drawn in two parts: complete days solid, today's partial figure as
 * a lighter cap. That is not decoration. Today is a few hours old, so a single
 * bar including it sits past the pace marker every afternoon and back behind it
 * by morning — an overspend that reverses itself overnight, which is how a
 * dashboard teaches people to stop believing it. The marker compares against
 * the solid segment only, which is the same figure the verdict is computed
 * from, so the picture and the words cannot disagree.
 *
 * Status is never colour alone — every state carries an icon and a written
 * label, and the numbers underneath are in text tokens rather than the status
 * hue, so the one fact gets one colour encoding.
 */

/**
 * What the pipe state means for the reader, when spend cannot be trusted.
 *
 * 🔴 These are NOT pacing verdicts and must never read as one. Recorded spend
 * of zero because Meta could not be reached looks identical to an account that
 * stopped delivering, and "underspending" over a dead sync would send someone
 * to raise a budget on an account that was already spending.
 */
const UNTRUSTED_COPY: Record<string, string> = {
  unreachable: "Spend unavailable — the last sync failed",
  never_synced: "Spend not yet imported",
  backfilling: "First import still running",
  not_connected: "No ad account connected",
};

const STATUS: Record<
  MonthPacing["status"],
  { label: string; icon: "check" | "alert" | "help"; token: string }
> = {
  on_pace: { label: "On pace", icon: "check", token: "var(--status-good)" },
  under: { label: "Underspending", icon: "alert", token: "var(--status-warning)" },
  over: { label: "Overspending", icon: "alert", token: "var(--status-serious)" },
  too_early: { label: "Too early to judge", icon: "help", token: "var(--text-muted)" },
  no_budget: { label: "No budget set", icon: "help", token: "var(--text-muted)" },
};

/** Percentage of the track, clamped so an overspend cannot overflow the bar. */
function pct(value: number, of: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(of) || of <= 0) return 0;
  return Math.max(0, Math.min(100, (value / of) * 100));
}

export function BudgetPacing({
  pacing,
  currency,
  monthLabel,
}: {
  pacing: MonthPacing;
  currency: string;
  /** e.g. "August 2026" — the month this pacing describes, spelled out. */
  monthLabel: string;
}) {
  const { budget, spendToDate, spendThroughYesterday } = pacing;

  /*
   * The verdict is replaced, not merely annotated. An amber "Underspending"
   * beside a footnote about a failed sync is still a headline claiming the
   * client underspent, and the headline is what gets read and acted on.
   */
  const untrusted = !pacing.spendTrusted;
  const s = untrusted
    ? {
        label: UNTRUSTED_COPY[pacing.pipeState] ?? "Spend unavailable",
        icon: "alert" as const,
        token: "var(--status-critical)",
      }
    : STATUS[pacing.status];

  // The track is the budget, or — with no budget — whatever the month is
  // heading for, so the bar still has an honest scale to sit on.
  const track = budget && budget > 0 ? budget : (pacing.projectedSpend ?? spendToDate);
  const solidPct = pct(spendThroughYesterday, track);
  const todayPct = Math.max(0, pct(spendToDate, track) - solidPct);
  // No pace marker either: a target line beside a bar drawn from spend we could
  // not fetch invites exactly the comparison that must not be made.
  const markerPct =
    untrusted || pacing.expectedToDate === null
      ? null
      : pct(pacing.expectedToDate, track);
  const overspent = budget !== null && budget > 0 && spendToDate > budget;

  return (
    <section
      className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card-bg)] p-5 shadow-[var(--shadow-card)]"
      aria-label={`Budget pacing for ${monthLabel}`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Budget pacing
          </h2>
          <p className="text-xs text-[var(--text-muted)]">{monthLabel}</p>
        </div>
        <span
          className="inline-flex items-center gap-1.5 text-xs font-medium"
          style={{ color: s.token }}
        >
          <Icon name={s.icon} className="h-3.5 w-3.5" aria-hidden />
          {s.label}
        </span>
      </header>

      <p className="mt-4 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
          {formatCurrency(spendToDate, currency)}
        </span>
        <span className="text-sm text-[var(--text-secondary)]">
          {budget === null ? "spent" : `of ${formatCurrency(budget, currency)}`}
        </span>
      </p>

      <div className="relative mt-4">
        <div
          className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--gridline)]"
          role="img"
          aria-label={
            budget === null
              ? `${formatCurrency(spendToDate, currency)} spent, no budget set`
              : `${formatCurrency(spendToDate, currency)} of ${formatCurrency(budget, currency)} spent`
          }
        >
          <span
            className="h-full rounded-full"
            style={{
              width: `${solidPct}%`,
              background: overspent ? "var(--status-serious)" : "var(--accent)",
            }}
          />
          {todayPct > 0 && (
            <span
              // A 2px surface gap so the partial segment reads as a separate
              // quantity rather than as a gradient on one bar.
              className="h-full rounded-full opacity-45"
              style={{
                width: `${todayPct}%`,
                marginLeft: 2,
                background: overspent ? "var(--status-serious)" : "var(--accent)",
              }}
            />
          )}
        </div>

        {markerPct !== null && (
          <span
            className="absolute -top-1 h-4.5 w-px bg-[var(--text-secondary)]"
            style={{ left: `${markerPct}%`, height: 18 }}
            aria-hidden
          />
        )}
      </div>

      <p className="mt-2 text-xs text-[var(--text-muted)]">
        {pacing.completeDays > 0 ? (
          <>
            {pacing.completeDays} of {pacing.daysInMonth} days complete
            {markerPct !== null && <> · the mark is an even pace</>}
            {pacing.spendToDate > pacing.spendThroughYesterday && (
              <> · the lighter tip is today so far, still partial</>
            )}
          </>
        ) : (
          <>The month has not completed a day yet</>
        )}
      </p>

      {untrusted ? (
        <p className="mt-4 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-secondary)]">
          Pacing is withheld until the spend figures can be trusted — a sync that
          has not run records no spend, which is indistinguishable from an
          account that stopped delivering. Check the connection health on the
          client&rsquo;s setup page.
        </p>
      ) : (
      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-[var(--border)] pt-3">
        <Figure
          label="Projected"
          value={formatCurrency(pacing.projectedSpend, currency)}
          /*
           * Named, because the two projections are not equally good and the
           * reader deserves to know which one this is. The weighted forecast is
           * the same figure "Where this month lands" shows; the run rate is the
           * cruder fallback used before the forecast will commit.
           */
          hint={
            pacing.projectionSource === "forecast"
              ? "Weekday-weighted forecast"
              : pacing.projectionSource === "run_rate"
                ? "At the current run rate"
                : "Not enough of the month yet"
          }
        />
        <Figure
          label={
            pacing.projectedVariance !== null && pacing.projectedVariance < 0
              ? "Under by"
              : "Over by"
          }
          value={
            pacing.projectedVariance === null
              ? DASH
              : formatCurrency(Math.abs(pacing.projectedVariance), currency)
          }
          hint="Projected vs budget"
        />
        <Figure
          label="Daily target"
          value={formatCurrency(pacing.dailyTargetRemaining, currency)}
          hint={
            pacing.daysRemaining > 0
              ? `To land on budget over ${pacing.daysRemaining} day${pacing.daysRemaining === 1 ? "" : "s"}`
              : "The month has closed"
          }
        />
      </dl>
      )}

      {!untrusted && pacing.status === "no_budget" && (
        /*
         * An honest empty state, in the spirit of the rest of the dashboard: it
         * says what is missing and what the month is heading for regardless,
         * rather than rendering a dead panel or — worse — a green "on pace"
         * against a target nobody set.
         */
        <p className="mt-3 text-xs text-[var(--text-secondary)]">
          No monthly budget on record, so there is nothing to pace against. Set
          one in the client&apos;s settings to turn this into a target.
        </p>
      )}
    </section>
  );
}

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </dt>
      {/* Tabular figures: these three sit in a row and must align optically. */}
      <dd className="mt-0.5 text-sm font-medium tabular-nums text-[var(--text-primary)]">
        {value}
      </dd>
      <p className="text-[11px] text-[var(--text-muted)]">{hint}</p>
    </div>
  );
}
