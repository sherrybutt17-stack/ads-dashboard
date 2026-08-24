import Link from "next/link";
import { Icon } from "./Icon";
import { formatCurrency, DASH } from "@/lib/metrics/compute";
import { monthLabel } from "@/lib/commentary/model";
import type { BookPacing, BookPacingRow } from "@/lib/metrics/book-pacing";

/**
 * Budget commitment across the book, and who is off track.
 *
 * Two things, in the order an agency owner needs them: what has been promised
 * and placed this month, then the exception list. The exception list is the
 * point — the totals are context for it.
 *
 * ── What this panel refuses to do ─────────────────────────────────────
 *
 * **Rank clients against each other.** The attention list is alphabetical, and
 * `book-pacing.ts` sorts it that way rather than by variance, because a list
 * ordered by who is worst is a leaderboard whatever it is called. Every
 * judgement here is a client against their own agreement.
 *
 * **Print a total across currencies.** There is no exchange rate in this
 * system; each currency gets its own line, and a client whose own budgets
 * straddle two is shown but contributes to neither.
 *
 * **Imply the book is complete.** `withoutBudget` is stated on the face of the
 * panel. A commitment total that quietly omits half the clients would be read
 * as the whole book.
 */

const STATUS: Record<string, { label: string; token: string }> = {
  under: { label: "Underspending", token: "var(--status-warning)" },
  over: { label: "Overspending", token: "var(--status-serious)" },
};

export function BookPacingPanel({
  pacing,
  error,
}: {
  pacing: BookPacing;
  error: string | null;
}) {
  const has = pacing.rows.length > 0;
  if (!has && !error) return null;

  return (
    <section className="card p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Budget commitment
        </h2>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {/*
            Around a month boundary the book straddles two calendars, because
            each client's month is resolved in their own timezone. Naming one
            month then would label a Sydney client's figures with a Los Angeles
            calendar, so it names none.
          */}
          {pacing.mixedMonths
            ? "Current month, per client timezone"
            : pacing.monthKey
              ? monthLabel(pacing.monthKey)
              : DASH}
        </span>
      </header>

      {error ? (
        /*
         * Named rather than rendered as an empty panel: "we could not read the
         * budgets" and "no budgets are set" are different facts and only one of
         * them is a task for the reader.
         */
        <p className="mt-3 text-xs" style={{ color: "var(--status-critical)" }}>
          Budget figures unavailable — {error}
        </p>
      ) : (
        <>
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
            {pacing.byCurrency.map((t) => (
              <div key={t.currency}>
                <dt
                  className="text-[11px] uppercase tracking-wide"
                  style={{ color: "var(--text-muted)" }}
                >
                  Committed{pacing.singleCurrency ? "" : ` · ${t.currency}`}
                </dt>
                <dd
                  className="mt-0.5 text-lg font-semibold tabular-nums"
                  style={{ color: "var(--text-primary)" }}
                >
                  {formatCurrency(t.committed, t.currency)}
                </dd>
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {formatCurrency(t.spentToDate, t.currency)} placed ·{" "}
                  {formatCurrency(t.expectedToDate, t.currency)} on an even pace
                </p>
              </div>
            ))}
          </dl>

          {pacing.needsAttention.length > 0 ? (
            <ul className="mt-4 flex flex-col gap-1.5 border-t pt-3" style={{ borderColor: "var(--border)" }}>
              {pacing.needsAttention.map((row) => (
                <AttentionRow key={row.clientId} row={row} />
              ))}
            </ul>
          ) : (
            <p
              className="mt-4 border-t pt-3 text-xs"
              style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
            >
              Every client with a budget is pacing within 10% of it.
            </p>
          )}

          {pacing.untrusted > 0 && (
            /*
             * Named on the face of the panel. A client whose sync is broken
             * records no spend, which would read as an underspend — so it is
             * excluded from both the totals and the attention list, and saying
             * so is the difference between a total that is short and a total
             * that is quietly wrong.
             */
            <p className="mt-2 text-[11px]" style={{ color: "var(--status-critical)" }}>
              {pacing.untrusted} client{pacing.untrusted === 1 ? "" : "s"} excluded —
              spend could not be read from the ad platform, so pacing would be
              indistinguishable from an account that stopped delivering.
            </p>
          )}

          {pacing.withoutBudget > 0 && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
              {pacing.withoutBudget} client{pacing.withoutBudget === 1 ? "" : "s"} with
              no budget on record {pacing.withoutBudget === 1 ? "is" : "are"} not counted
              above.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function AttentionRow({ row }: { row: BookPacingRow }) {
  const s = STATUS[row.status] ?? { label: row.status, token: "var(--text-muted)" };
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
      <Link
        href={`/c/${row.slug}`}
        className="font-medium underline-offset-2 hover:underline"
        style={{ color: "var(--text-primary)" }}
      >
        {row.name}
      </Link>
      <span className="flex items-center gap-1.5" style={{ color: s.token }}>
        <Icon name="alert" size={11} />
        {s.label}
      </span>
      <span className="tabular-nums" style={{ color: "var(--text-secondary)" }}>
        {formatCurrency(row.spentToDate, row.currency)} of{" "}
        {formatCurrency(row.committed, row.currency)}
        {row.mixedCurrency && " (mixed currencies)"} · {row.daysRemaining} days left
      </span>
    </li>
  );
}
