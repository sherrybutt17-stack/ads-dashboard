import { Icon, type IconName } from "@/components/Icon";
import { DASH, formatCurrency, formatNumber } from "@/lib/metrics/compute";
import type { CurrencyTotals } from "@/lib/metrics/rollup";

/**
 * The four headline numbers for the whole book, as tinted cards.
 *
 * ── Why these are tinted and the tables are not ───────────────────────
 *
 * The tint is WAYFINDING, not data. Each card owns a fixed hue by METRIC —
 * spend is always violet, leads always blue — so the eye can return to the
 * same number tomorrow without reading the label. The hue says "this is the
 * spend card"; it does not encode the value, and nothing about the colour
 * changes when the number does.
 *
 * 🔴 That is why these use `--tint-*` and not the `--series-*` ramp. The
 * series hues are tuned as MARKS against the 3:1 floor and carry categorical
 * identity inside a chart; painting a card in one would put a data colour on
 * a non-data object and make the KPI row look like a legend for a chart that
 * does not exist. `series-palette.test.ts` enforces that separation, and this
 * component is deliberately not on its allowlist.
 *
 * ── The numbers are ink, not tint ─────────────────────────────────────
 *
 * Every value is set in `--text-primary` on its tint, never in the tint's own
 * hue. Each tint clears 4.75:1 against the worst ink that lands on it in both
 * themes — see the token block — which is what makes a pastel card safe to
 * put a caption on at all.
 */

const CARDS = [
  { key: "spend", tint: "--tint-violet", icon: "chart" },
  { key: "leads", tint: "--tint-blue", icon: "users" },
  { key: "cpl", tint: "--tint-mint", icon: "layers" },
  { key: "appts", tint: "--tint-amber", icon: "check" },
] as const;

export function BookKpis({ t, days }: { t: CurrencyTotals; days: number }) {
  const window = `Last ${days} days`;

  return (
    <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        tint={CARDS[0].tint}
        icon={CARDS[0].icon}
        label="Ad spend"
        value={formatCurrency(t.spend, t.currency, { compact: true })}
        caption={window}
        change={t.spendChange}
      />
      <Kpi
        tint={CARDS[1].tint}
        icon={CARDS[1].icon}
        label="Leads"
        value={formatNumber(t.leads)}
        caption={window}
        change={t.leadsChange}
      />
      <Kpi
        tint={CARDS[2].tint}
        icon={CARDS[2].icon}
        label="Cost per lead"
        value={formatCurrency(t.cpLead, t.currency)}
        /*
         * 🔴 The caption names the EXCLUSION, because the number is a blend
         * over a subset. Clients whose CRM has never delivered are left out of
         * this ratio — their zero leads describe a broken pipe, not the
         * advertising — and a cost per lead that quietly dropped them while
         * looking like a book-wide figure is the kind of number someone
         * repeats in a meeting. The table below says the same thing at length.
         */
        caption={
          t.excluded.length > 0
            ? `${t.excluded.length} client${t.excluded.length === 1 ? "" : "s"} left out`
            : window
        }
      />
      <Kpi
        tint={CARDS[3].tint}
        icon={CARDS[3].icon}
        label="Appointments"
        value={formatNumber(t.appointments)}
        caption={`${formatNumber(t.closedWon)} closed won`}
      />
    </div>
  );
}

function Kpi({
  tint,
  icon,
  label,
  value,
  caption,
  change,
}: {
  tint: string;
  icon: IconName;
  label: string;
  value: string;
  caption: string;
  change?: number | null;
}) {
  return (
    <div
      className="rounded-[var(--radius-lg)] p-4"
      style={{ background: `var(${tint})` }}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-xs)]"
          /* A wash of the card's own ground, one step up — enough to seat the
             glyph without introducing a fifth colour per card. */
          style={{
            background: "color-mix(in srgb, var(--surface-1) 55%, transparent)",
            color: "var(--text-secondary)",
          }}
        >
          <Icon name={icon} size={13} />
        </span>
        <span
          className="text-[12px] font-medium"
          style={{ color: "var(--text-secondary)" }}
        >
          {label}
        </span>
      </div>

      <div
        className="mt-3 text-[26px] leading-none font-semibold tracking-[-0.02em] tabular-nums"
        style={{ color: "var(--text-primary)" }}
      >
        {value}
      </div>

      <div
        className="mt-2 flex items-center gap-1.5 text-[11.5px]"
        style={{ color: "var(--text-muted)" }}
      >
        {change !== undefined && <Delta value={change} />}
        <span>{caption}</span>
      </div>
    </div>
  );
}

/**
 * Neutral by design, and the same rule the roll-up table already follows:
 * on a portfolio screen a rise in spend is neither good nor bad on its own —
 * it depends on the retainer — so colouring it green or red would be the tool
 * taking a position it has no basis for.
 */
function Delta({ value }: { value: number | null }) {
  if (value === null) return <span>{DASH}</span>;
  return (
    <span className="font-medium tabular-nums">
      <span aria-hidden="true">{value >= 0 ? "▲" : "▼"}</span>{" "}
      {Math.round(Math.abs(value) * 100)}%
    </span>
  );
}
