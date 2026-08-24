import { Icon } from "./Icon";
import { formatCurrency, DASH } from "@/lib/metrics/compute";
import type { BudgetHistory, DeliveryMonth } from "@/lib/metrics/budget-history";

/**
 * Whether the money the client agreed to spend actually got spent, month by
 * month.
 *
 * The pacing panel above answers this for the month in progress, while it can
 * still be changed. This is the record in arrears — the thing to have in front
 * of you at a renewal, where "we placed your budget every month bar one" is a
 * different conversation from a shrug.
 *
 * Every row is this client against their own agreement. There is no peer
 * figure and no rank anywhere on this panel.
 *
 * The month in progress is shown but never scored — see `budget-history.ts`.
 * Rendering it as a shortfall would put the loudest colour on the panel for the
 * first three weeks of every month.
 */

const VERDICT: Record<
  DeliveryMonth["verdict"],
  { label: string; token: string; icon: "check" | "alert" | "help" | null }
> = {
  on_target: { label: "Delivered", token: "var(--status-good)", icon: "check" },
  under: { label: "Short", token: "var(--status-warning)", icon: "alert" },
  over: { label: "Over", token: "var(--status-serious)", icon: "alert" },
  no_budget: { label: "No budget", token: "var(--text-muted)", icon: null },
  in_progress: { label: "In progress", token: "var(--text-muted)", icon: null },
};

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  return `${Math.round(v * 100)}%`;
}

export function BudgetHistoryPanel({
  history,
  currency,
}: {
  history: BudgetHistory;
  currency: string;
}) {
  // Nothing was ever agreed: the pacing panel already says so, and a second
  // empty panel saying it again is noise.
  if (history.scored === 0 && history.committed === 0) return null;

  return (
    <section className="card p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Budget delivery
        </h2>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {history.onTarget} of {history.scored} month
          {history.scored === 1 ? "" : "s"} on target
        </span>
      </header>

      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        {formatCurrency(history.placed, currency)} placed of{" "}
        {formatCurrency(history.committed, currency)} committed across closed
        months — {pct(history.deliveredOverall)}. The month in progress is shown
        but not scored.
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[26rem] text-sm">
          <thead>
            <tr
              className="text-left text-[11px] uppercase tracking-wide"
              style={{ color: "var(--text-muted)" }}
            >
              <th className="pb-1 font-medium">Month</th>
              <th className="pb-1 text-right font-medium">Budget</th>
              <th className="pb-1 text-right font-medium">Placed</th>
              <th className="pb-1 text-right font-medium">Delivered</th>
              <th className="pb-1 pl-3 font-medium">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {history.months.map((m) => {
              const v = VERDICT[m.verdict];
              return (
                <tr
                  key={m.monthKey}
                  className="border-t"
                  style={{ borderColor: "var(--border)" }}
                >
                  <td className="py-1.5" style={{ color: "var(--text-primary)" }}>
                    {m.label}
                  </td>
                  <td
                    className="py-1.5 text-right tabular-nums"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {m.budget === null ? DASH : formatCurrency(m.budget, currency)}
                  </td>
                  <td
                    className="py-1.5 text-right tabular-nums"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {formatCurrency(m.spend, currency)}
                  </td>
                  <td
                    className="py-1.5 text-right tabular-nums"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {/* Undefined against no budget — never a confident 0%. */}
                    {m.verdict === "in_progress" ? DASH : pct(m.delivered)}
                  </td>
                  <td className="py-1.5 pl-3">
                    {/* Never colour alone: the word is always present. */}
                    <span
                      className="inline-flex items-center gap-1 text-xs"
                      style={{ color: v.token }}
                    >
                      {v.icon && <Icon name={v.icon} size={11} />}
                      {v.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
