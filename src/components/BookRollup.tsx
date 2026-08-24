import Link from "next/link";
import {
  REACH_NOT_AGGREGATABLE,
  type BookRollup,
  type ClientRow,
  type CurrencyTotals,
} from "@/lib/metrics/rollup";
import { formatCurrency, formatNumber, DASH } from "@/lib/metrics/compute";
import { Icon } from "@/components/Icon";

/**
 * The book — the agency's own screen.
 *
 * Sits above the client list, and answers a different question from every other
 * surface in this product: not "how is this client doing" but "where is the
 * money and which account needs me this week".
 *
 * Three things it deliberately does not do:
 *
 *   · no total reach — see `REACH_NOT_AGGREGATABLE`
 *   · no grand total across currencies, because there is no rate here
 *   · no ratio quietly computed over a subset without naming what was left out
 */

const LEAD_BASIS_LABEL: Record<string, string> = {
  all: "every lead",
  attributed: "campaign-attributed leads only",
  tagged: "tagged leads only",
  either: "attributed or tagged leads",
};

function Delta({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        {DASH}
      </span>
    );
  }
  const up = value >= 0;
  return (
    <span
      className="text-[11px] font-medium tabular-nums"
      style={{ color: "var(--text-muted)" }}
    >
      {/* Never coloured. On a portfolio screen, spend rising is neither good nor
          bad on its own — it depends on the retainer — and a green or red on it
          would be the tool taking a position it has no basis for. */}
      <span aria-hidden>{up ? "▲" : "▼"}</span>{" "}
      {Math.round(Math.abs(value) * 100)}%
    </span>
  );
}

/**
 * 🔴 The dash means *we do not know*, and nothing else.
 *
 * Gating this on "any deal carried a value" was wrong and live data showed it:
 * a client with no closed deals at all has a return of zero, and we know that.
 * `roasFrom` already draws the line — `null` for deals closed with no value
 * recorded, a real `0` for nothing closed — so the only correct test here is
 * null-ness. If a real zero also rendered as a dash, the dash would stop
 * carrying information anywhere on this page.
 */
function Roas({ value, closedWon, revenueKnown }: { value: number | null; closedWon: number; revenueKnown: boolean }) {
  if (value !== null) return <>{value.toFixed(1)}×</>;
  const unrecorded = closedWon > 0 && !revenueKnown;
  return (
    <span
      style={{ color: "var(--text-muted)" }}
      title={
        unrecorded
          ? `${closedWon} deal${closedWon === 1 ? "" : "s"} closed with no value recorded in GHL, so the return cannot be computed.`
          : "No spend to compute a return against."
      }
    >
      {DASH}
      {unrecorded && <span aria-hidden> *</span>}
    </span>
  );
}

function Num({
  value,
  currency,
  money = false,
}: {
  value: number | null;
  currency: string;
  money?: boolean;
}) {
  if (value === null) {
    return <span style={{ color: "var(--text-muted)" }}>{DASH}</span>;
  }
  return <>{money ? formatCurrency(value, currency) : formatNumber(value)}</>;
}

function Row({ r }: { r: ClientRow }) {
  return (
    <tr className="border-t" style={{ borderColor: "var(--border)" }}>
      <th scope="row" className="py-2.5 pr-3 text-left font-medium">
        <Link
          href={`/c/${r.slug}`}
          className="hover:underline"
          style={{ color: "var(--text-primary)" }}
        >
          {r.name}
        </Link>
        {!r.connected && (
          /* The reason this client's leads are zero, said next to the zero
             rather than in a footnote under a table nobody scrolls to. */
          <span
            className="ml-2 whitespace-nowrap text-[11px] font-normal"
            style={{ color: "var(--status-warning)" }}
          >
            CRM not connected
          </span>
        )}
        {r.mixedCurrency && (
          <span
            className="ml-2 whitespace-nowrap text-[11px] font-normal"
            style={{ color: "var(--status-warning)" }}
          >
            mixed currency
          </span>
        )}
      </th>
      <td className="py-2.5 pl-3 text-right tabular-nums">
        <Num value={r.spend} currency={r.currency} money />{" "}
        <Delta value={r.spendChange} />
      </td>
      <td className="py-2.5 pl-3 text-right tabular-nums">
        <Num value={r.leads} currency={r.currency} /> <Delta value={r.leadsChange} />
      </td>
      <td className="py-2.5 pl-3 text-right tabular-nums">
        <Num value={r.cpLead} currency={r.currency} money />
      </td>
      <td className="hidden py-2.5 pl-3 text-right tabular-nums sm:table-cell">
        <Num value={r.appointments} currency={r.currency} />
      </td>
      <td className="hidden py-2.5 pl-3 text-right tabular-nums md:table-cell">
        <Num value={r.closedWon} currency={r.currency} />
      </td>
      <td className="hidden py-2.5 pl-3 text-right tabular-nums md:table-cell">
        <Roas value={r.roas} closedWon={r.closedWon} revenueKnown={r.revenueKnown} />
      </td>
    </tr>
  );
}

function Totals({ t }: { t: CurrencyTotals }) {
  return (
    <tr
      className="border-t-2 font-semibold"
      style={{ borderColor: "var(--border-strong)" }}
    >
      <th scope="row" className="py-2.5 pr-3 text-left">
        {t.clients} client{t.clients === 1 ? "" : "s"}
        <span
          className="ml-2 text-[11px] font-normal tabular-nums"
          style={{ color: "var(--text-muted)" }}
        >
          {t.currency}
        </span>
      </th>
      <td className="py-2.5 pl-3 text-right tabular-nums">
        {formatCurrency(t.spend, t.currency)} <Delta value={t.spendChange} />
      </td>
      <td className="py-2.5 pl-3 text-right tabular-nums">
        {formatNumber(t.leads)} <Delta value={t.leadsChange} />
      </td>
      <td className="py-2.5 pl-3 text-right tabular-nums">
        <Num value={t.cpLead} currency={t.currency} money />
      </td>
      <td className="hidden py-2.5 pl-3 text-right tabular-nums sm:table-cell">
        {formatNumber(t.appointments)}
      </td>
      <td className="hidden py-2.5 pl-3 text-right tabular-nums md:table-cell">
        {formatNumber(t.closedWon)}
      </td>
      <td className="hidden py-2.5 pl-3 text-right font-normal tabular-nums md:table-cell">
        <Roas value={t.roas} closedWon={t.closedWon} revenueKnown={t.revenueKnown} />
      </td>
    </tr>
  );
}

export function BookRollupPanel({
  book,
  days,
  error,
}: {
  book: BookRollup;
  days: number;
  error: string | null;
}) {
  const byCurrency = new Map(book.byCurrency.map((t) => [t.currency, t]));

  return (
    <section className="card mb-6 p-5" aria-label="Across all clients">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Across all clients
        </h2>
        <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
          last {days} days, each in its own timezone
        </span>
      </div>

      {error ? (
        <div className="mt-4 flex items-start gap-2.5">
          <span style={{ color: "var(--status-critical)" }} className="mt-0.5">
            <Icon name="alert" size={14} />
          </span>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            The roll-up could not be read, so no totals are shown rather than
            partial ones. The client list below is unaffected.
            <span className="mt-1 block text-xs" style={{ color: "var(--text-muted)" }}>
              {error}
            </span>
          </p>
        </div>
      ) : book.rows.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          No clients to total up yet.
        </p>
      ) : (
        <>
          {/* Wide tables scroll inside their own container, never the page. */}
          <div className="-mx-1 mt-3 overflow-x-auto px-1">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead>
                <tr style={{ color: "var(--text-muted)" }}>
                  <th scope="col" className="pb-1.5 pr-3 text-left font-medium">
                    Client
                  </th>
                  <th scope="col" className="pb-1.5 pl-3 text-right font-medium">
                    Spend
                  </th>
                  <th scope="col" className="pb-1.5 pl-3 text-right font-medium">
                    Leads
                  </th>
                  <th scope="col" className="pb-1.5 pl-3 text-right font-medium">
                    Cost/lead
                  </th>
                  <th
                    scope="col"
                    className="hidden pb-1.5 pl-3 text-right font-medium sm:table-cell"
                  >
                    Appts
                  </th>
                  <th
                    scope="col"
                    className="hidden pb-1.5 pl-3 text-right font-medium md:table-cell"
                  >
                    Won
                  </th>
                  <th
                    scope="col"
                    className="hidden pb-1.5 pl-3 text-right font-medium md:table-cell"
                  >
                    ROAS
                  </th>
                </tr>
              </thead>
              <tbody>
                {/*
                 * Grouped by currency when there is more than one, because a
                 * total row under a mixed list would look like it summed them.
                 */}
                {book.singleCurrency
                  ? book.rows.map((r) => <Row key={r.clientId} r={r} />)
                  : [...byCurrency.keys()].flatMap((code) => [
                      ...book.rows
                        .filter((r) => (r.currency || "USD").toUpperCase() === code)
                        .map((r) => <Row key={r.clientId} r={r} />),
                      <Totals key={`t-${code}`} t={byCurrency.get(code)!} />,
                    ])}
                {book.singleCurrency && book.byCurrency[0] && (
                  <Totals t={book.byCurrency[0]} />
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-col gap-1.5">
            {/*
             * 🔴 A ratio computed over a subset says so, and names the subset.
             * Silently dropping a client whose webhook was never wired is how a
             * book-wide cost per lead becomes flattering by accident.
             */}
            {book.byCurrency
              .filter((t) => t.excluded.length > 0)
              .map((t) => (
                <p
                  key={t.currency}
                  className="text-xs leading-relaxed"
                  style={{ color: "var(--text-muted)" }}
                >
                  Cost per lead and ROAS leave out{" "}
                  {t.excluded.map((e) => e.name).join(", ")} — no CRM events have
                  ever arrived, so {t.excluded.length === 1 ? "its" : "their"} zero
                  leads describe the connection rather than the advertising.{" "}
                  {formatCurrency(
                    t.excluded.reduce((s, e) => s + e.spend, 0),
                    t.currency,
                  )}{" "}
                  of spend is still counted in the total above.
                </p>
              ))}

            {book.leadBases.length > 1 && (
              <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                Clients count leads differently here —{" "}
                {book.leadBases
                  .map(
                    (b) =>
                      `${b.clients} using ${LEAD_BASIS_LABEL[b.mode] ?? b.mode}`,
                  )
                  .join(", ")}
                . Each client&rsquo;s own figure is right; the blended cost per
                lead above divides one pool of spend by leads counted under more
                than one rule.
              </p>
            )}

            {book.mixedCurrencyClients.length > 0 && (
              <p className="text-xs leading-relaxed" style={{ color: "var(--status-warning)" }}>
                {book.mixedCurrencyClients.join(", ")}{" "}
                {book.mixedCurrencyClients.length === 1 ? "has" : "have"} Meta and
                Google accounts priced in different currencies. Their spend is added
                together above, which is wrong by the exchange rate.
              </p>
            )}

            {book.rows.some((r) => r.closedWon > 0 && !r.revenueKnown) && (
              <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                * Deals closed with no value recorded in GHL, so no return can be
                computed. That is an operations gap, not a result — a
                &ldquo;0.0×&rdquo; there would blame the advertising for an empty
                field.
              </p>
            )}

            <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Spend is Meta and Google together, so cost per lead here is blended
              across both — each client&rsquo;s own dashboard reports the two
              separately. {REACH_NOT_AGGREGATABLE}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
