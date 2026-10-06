"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCurrency, formatNumber } from "@/lib/metrics/compute";

/**
 * One measure, split across categories, drawn as a bar, a line or a circle.
 *
 * Almost every panel on this dashboard was a table. A table is the right shape
 * for looking a number up and the wrong shape for noticing one — "which of
 * these eleven placements took the money?" is a question you answer in about a
 * second from a bar chart and in about thirty from a column of figures, and the
 * thirty-second version is the one nobody actually performs. This is the chart
 * that goes next to those tables. The table stays: it is the accessible reading
 * of the same numbers and the place exact values live.
 *
 * ## Why a switcher is safe here
 *
 * The same argument `TrendCharts` makes, and the same limits. Bar, line and
 * circle draw ONE measure over ONE set of categories. Nothing about the data,
 * the ordering, the folding or the totals moves when the form does, so no form
 * can show the reader something the other two contradict. The moment a form
 * needed its own aggregation it would stop being a view preference and start
 * being a second dataset wearing the first one's label.
 *
 * Identity survives the switch: a category is the same colour as a bar, as a
 * dot and as a slice. That is why the line form draws a NEUTRAL line with
 * coloured dots rather than a coloured line — a single stroke cannot carry
 * seven identities, and recolouring it per form would make the colour mean
 * "current form" instead of "which category".
 *
 * ## What it deliberately will not do
 *
 * **Two measures.** There is no second axis and no way to ask for one. A
 * dual-axis chart lets two unrelated scales be placed side by side, and every
 * crossing the reader sees is an artifact of where the axes were put. Two
 * measures are two `CategoryChart`s.
 *
 * **Cycle the palette.** Seven hues, assigned in order, and an eighth category
 * folds into "Other" rather than wrapping back to hue one. A cycled ramp makes
 * two different categories the same colour on the same chart, which is not a
 * cosmetic problem — it is a legend that lies.
 *
 * **A circle of negative numbers.** A pie slice is a share of a total, and a
 * share is undefined when the parts can be negative or sum to zero. The form is
 * withdrawn rather than drawn wrong; see `canBeCircle`.
 */

export type CategoryForm = "bar" | "line" | "pie";

const FORMS: readonly { id: CategoryForm; label: string }[] = [
  { id: "bar", label: "Bar" },
  { id: "line", label: "Line" },
  { id: "pie", label: "Circle" },
];

function isCategoryForm(v: unknown): v is CategoryForm {
  return v === "bar" || v === "line" || v === "pie";
}

/**
 * The categorical ramp, in fixed order.
 *
 * `--series-8` is absent on purpose: it is the status red, and a category that
 * happens to land eighth should not read as the broken one. That is also why
 * folding starts at seven rather than eight.
 */
const RAMP = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
] as const;

/** The folded tail. Grey, because "Other" is not an entity — it is a remainder. */
const OTHER_COLOR = "var(--text-muted)";
const OTHER_LABEL = "Other";

/**
 * How a value is written out, as DATA rather than as a function.
 *
 * 🔴 This is not a style choice. `CategoryChart` is a Client Component, and
 * more than half its callers — `KeepKill`, `CreativeFatigue`, `LeadQuality`,
 * `BudgetHistory` — are Server Components. A `format: (n: number) => string`
 * prop type-checks, builds, and then throws at render:
 *
 *   Functions cannot be passed directly to Client Components unless you
 *   explicitly expose it by marking it with "use server".
 *
 * React swallows that into an error boundary that still answers 200, so the
 * symptom is not a stack trace but a tab that quietly renders without its
 * panels. Making the prop a descriptor means the boundary cannot be crossed
 * wrongly: there is no function to pass.
 *
 * The two kinds are the two things this chart ever plots. It never plots a
 * rate — see the `data` prop — so there is deliberately no percent kind.
 */
export type CategoryFormat =
  | { kind: "count" }
  | { kind: "money"; currency: string };

/** The descriptor, resolved to the function the marks and the legend call. */
function formatter(spec: CategoryFormat): (n: number) => string {
  return spec.kind === "money"
    ? (n) => formatCurrency(n, spec.currency)
    : (n) => formatNumber(n);
}

export interface CategoryDatum {
  /** Stable identity. Used as the React key and the tooltip lookup. */
  key: string;
  label: string;
  value: number;
  /**
   * An override for the slice's colour, for the cases where the caller holds a
   * MORE authoritative palette than this component's ramp. There are two, and
   * between them they cover every legitimate use:
   *
   * 1. The categories are STATES, not identities, and the app already paints
   *    them. Spend by keep/stop verdict is the example: those categories wear
   *    the status palette a few centimetres below in the same card, and letting
   *    the ramp assign them fresh hues would put "consider stopping" in red in
   *    the list and in, say, teal in the chart above it — two subjects where
   *    there is one.
   *
   * 2. The entity's colour is assigned page-wide. `campaignColors` is built
   *    once in `c/[slug]/page.tsx` and keyed by campaign id precisely so a
   *    campaign is the same colour in the explorer, the table and the report.
   *    A chart that re-assigned by rank would break that — and would also
   *    repaint the survivors whenever a filter changed the series count, which
   *    is the "colour follows the entity, never its rank" rule.
   *
   * 🔴 Not an escape hatch for "I want a different colour". A caller that sets
   * this is asserting the values carry meaning the ramp cannot express; a
   * caller that merely has a preference should not, because the consistency of
   * legends across every panel on the page is the thing the ramp is for.
   */
  color?: string;
}

interface Props {
  data: CategoryDatum[];
  /** What one value IS — "Spend", "Leads". Shown on the axis and in the tooltip. */
  measure: string;
  format: CategoryFormat;
  /**
   * Where this chart's remembered form is stored, e.g. `"breakdowns.placement"`.
   *
   * Per chart, not per app: the form that suits a four-slice split of spend is
   * rarely the form that suits twenty days of it, and one shared key means
   * every chart on the page jumps when a reader adjusts any of them.
   */
  storageKey: string;
  defaultForm?: CategoryForm;
  height?: number;
  /**
   * How many categories get a hue of their own before the tail folds into
   * "Other".
   *
   * Capped at the ramp's length, because past that the component has no hue
   * left to give — UNLESS every datum carries its own `color`, in which case
   * the ramp is not the limit and this is honoured as written. That exemption
   * is what lets a twelve-month delivery record stay twelve bars: folding a
   * time series would put "Other" where June should be.
   */
  maxSlices?: number;
  /** Sorted by value, descending, unless the order already means something. */
  sort?: boolean;
  /**
   * Render at a FIXED width and WITHOUT the switcher.
   *
   * 🔴 Set this on anything that will be printed, for both of its effects. The
   * width is the `ResponsiveContainer` problem `TrendCharts` documents at
   * length — a chart sized from a `ResizeObserver` is captured at its stale
   * screen width when print re-lays-out the page at paper width. The switcher
   * is the reproducibility problem: a PDF whose charts depend on what the
   * person who exported it last clicked is not a document. Paper gets one
   * deterministic form.
   */
  fixedWidth?: number;
  /** Shown instead of a plot when there is nothing to draw. */
  empty?: string;
}

/**
 * Remembered per viewer, per chart, in localStorage.
 *
 * `useSyncExternalStore`, not `useState` + an effect. The effect version is the
 * obvious one and it has two problems:
 *
 *   It cannot read storage during the first render. The server has no
 *   localStorage and would render the default regardless, so a synchronous read
 *   makes the two trees disagree and React discards the server HTML. The effect
 *   version dodges that by reading a frame late — and pays for it with a
 *   `setState` inside an effect, which is a cascading render and which this
 *   repo's lint config rejects outright.
 *
 *   It desynchronises. Two charts pointed at the same key, or the same chart in
 *   two tabs, each hold their own copy and drift.
 *
 * `useSyncExternalStore` solves both by construction: `getServerSnapshot`
 * returns the default so the server and the first client render agree, the real
 * snapshot is adopted in the same commit rather than a paint later, and every
 * subscriber re-reads on a write.
 *
 * 🔴 The stored value is validated before it is returned. localStorage is
 * writable by anything on this origin and survives a rename of the form ids, so
 * an unvalidated read puts an unknown string into `form` — and every branch
 * below is an equality test, which means NOTHING renders. An empty plot frame
 * with working axes is the quietest possible failure.
 */

/**
 * Local subscribers, because the `storage` event does not fire in the tab that
 * wrote. Without this a reader clicking "Circle" would update other tabs and
 * not their own.
 */
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function useCategoryForm(
  storageKey: string,
  fallback: CategoryForm,
): [CategoryForm, (f: CategoryForm) => void] {
  const key = `chart.${storageKey}`;

  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb);
    window.addEventListener("storage", cb);
    return () => {
      listeners.delete(cb);
      window.removeEventListener("storage", cb);
    };
  }, []);

  const getSnapshot = useCallback((): CategoryForm => {
    try {
      const saved = window.localStorage.getItem(key);
      return isCategoryForm(saved) ? saved : fallback;
    } catch {
      // Private window, or site data blocked: the accessor THROWS rather than
      // returning null, and an unreadable preference must not take a chart down.
      return fallback;
    }
  }, [key, fallback]);

  /*
   * Returning `fallback` here rather than reading storage is what makes the
   * server and the first client render agree. A snapshot must also be
   * referentially stable between reads or React re-renders forever — these are
   * strings, which compare by value, so that is free.
   */
  const getServerSnapshot = useCallback(() => fallback, [fallback]);

  const form = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const choose = useCallback(
    (f: CategoryForm) => {
      try {
        window.localStorage.setItem(key, f);
      } catch {
        /* unwritable storage: the click still has to do something, so fall
           through to the notify below and let this render register it */
      }
      notify();
    },
    [key],
  );

  return [form, choose];
}

/**
 * The switcher. Styled as the date presets and the trend switcher are —
 * `accent-fill` on the active segment — because it is the same kind of control.
 * A series colour here would say "this button is data".
 */
function FormSwitch({
  value,
  onChange,
  allowed,
}: {
  value: CategoryForm;
  onChange: (f: CategoryForm) => void;
  allowed: readonly CategoryForm[];
}) {
  return (
    <div
      role="group"
      aria-label="Chart form"
      className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-sm)] p-0.5"
      style={{ background: "var(--surface-2)" }}
    >
      {FORMS.filter((f) => allowed.includes(f.id)).map((f) => {
        const active = f.id === value;
        return (
          <button
            key={f.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(f.id)}
            className={`rounded-[var(--radius-xs)] px-2 py-1 text-[11px] font-semibold transition-colors${
              active ? " accent-fill" : ""
            }`}
            style={
              active
                ? undefined
                : { background: "transparent", color: "var(--text-secondary)" }
            }
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Whether a circle is honest for this data.
 *
 * A slice is a share of a whole. With a negative part there is no whole to take
 * a share of — the arcs would still be drawn, by taking absolute values, and
 * they would show a loss-making category as a healthy wedge. With a zero total
 * there is nothing to divide. Both cases withdraw the form rather than draw it,
 * and the button disappears with it so nobody is left clicking a control that
 * does nothing.
 */
function canBeCircle(data: CategoryDatum[]): boolean {
  if (!data.length) return false;
  if (data.some((d) => d.value < 0)) return false;
  return data.reduce((a, d) => a + d.value, 0) > 0;
}

export function CategoryChart({
  data,
  measure,
  format: formatSpec,
  storageKey,
  defaultForm = "bar",
  height = 240,
  maxSlices = RAMP.length,
  sort = true,
  fixedWidth,
  empty = "Nothing to chart in this period",
}: Props) {
  const [stored, setForm] = useCategoryForm(storageKey, defaultForm);

  const format = formatter(formatSpec);

  const rows = sort ? [...data].sort((a, b) => b.value - a.value) : [...data];

  /*
   * Fold the tail. The cut is at `maxSlices - 1` so the folded group is itself
   * one of the slots — folding three categories into an "Other" that then sits
   * alongside seven named ones would be eight things on a seven-hue ramp.
   *
   * A tail of exactly one is left alone: an "Other" containing a single
   * category is strictly worse than naming it, and it is the case that makes a
   * reader distrust every other "Other" on the page.
   */
  const ownColours = rows.length > 0 && rows.every((d) => d.color);
  const cap = ownColours ? maxSlices : Math.min(maxSlices, RAMP.length);
  const folded =
    rows.length > cap + 1
      ? [
          ...rows.slice(0, cap - 1),
          {
            key: "__other__",
            label: OTHER_LABEL,
            value: rows.slice(cap - 1).reduce((a, d) => a + d.value, 0),
          },
        ]
      : rows;

  /*
   * "Other" keeps grey even when the caller supplies colours: a remainder is
   * not one of the states, and painting it as one would invent a category.
   */
  const points = folded.map((d, i) => ({
    ...d,
    color:
      d.key === "__other__"
        ? OTHER_COLOR
        : (d.color ?? RAMP[i % RAMP.length]),
  }));

  const circleOk = canBeCircle(folded);
  const allowed: CategoryForm[] = circleOk ? ["bar", "line", "pie"] : ["bar", "line"];
  /*
   * A remembered "pie" on data that cannot be one falls back rather than
   * blanking. The reader set that preference on a period where the circle was
   * legitimate; a month with a refund in it should change the chart, not empty
   * it.
   */
  const form: CategoryForm = stored === "pie" && !circleOk ? "bar" : stored;

  const total = folded.reduce((a, d) => a + d.value, 0);

  if (!points.length) {
    return (
      <div
        className="flex items-center justify-center rounded-[var(--radius)] px-4 text-center text-xs"
        style={{
          height,
          border: "1px dashed var(--border)",
          color: "var(--text-muted)",
        }}
      >
        {empty}
      </div>
    );
  }

  const axisTick = { fill: "var(--text-muted)", fontSize: 10 };

  /*
   * One tooltip for all three forms. Recharts hands a pie slice its datum under
   * a different shape from a bar's, so both are unwrapped to the same `payload`
   * before anything reads it — otherwise the circle silently shows an empty box.
   */
  const tooltip = (
    <Tooltip
      cursor={{ fill: "var(--surface-2)", stroke: "var(--baseline)" }}
      content={({ active, payload }) => {
        if (!active || !payload?.length) return null;
        const p = payload[0]?.payload as
          | (CategoryDatum & { color: string })
          | undefined;
        if (!p) return null;
        const share = total > 0 ? (p.value / total) * 100 : null;
        return (
          <div
            className="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs shadow-lg"
            style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border-strong)",
              color: "var(--text-primary)",
            }}
          >
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-2 rounded-full"
                style={{ background: p.color }}
              />
              <span style={{ color: "var(--text-muted)" }}>{p.label}</span>
            </div>
            <div className="tnum mt-0.5 font-semibold">
              {format(p.value)}
              <span
                className="ml-1 font-normal"
                style={{ color: "var(--text-muted)" }}
              >
                {measure.toLowerCase()}
              </span>
            </div>
            {share != null && circleOk && (
              <div className="tnum mt-0.5" style={{ color: "var(--text-muted)" }}>
                {share.toFixed(share < 10 ? 1 : 0)}% of total
              </div>
            )}
          </div>
        );
      }}
    />
  );

  const sized = fixedWidth
    ? { width: fixedWidth, height }
    : ({} as Record<string, never>);

  const chart =
    form === "pie" ? (
      <PieChart {...sized}>
        {tooltip}
        <Pie
          data={points}
          dataKey="value"
          nameKey="label"
          innerRadius="52%"
          outerRadius="80%"
          paddingAngle={1}
          isAnimationActive={false}
          /*
           * A 2px ring in the CARD's colour, not a white one. It is the spacer
           * that keeps two adjacent slices from reading as one shape, and a
           * hardcoded white turns into a bright outline the moment the reader
           * is in dark mode.
           */
          stroke="var(--card-bg)"
          strokeWidth={2}
        >
          {points.map((p) => (
            <Cell key={p.key} fill={p.color} />
          ))}
        </Pie>
      </PieChart>
    ) : form === "line" ? (
      <LineChart data={points} {...sized} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--gridline)" strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="label"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          interval={0}
          height={44}
          angle={-20}
          textAnchor="end"
        />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v) => format(Number(v))}
        />
        {tooltip}
        {/*
          A neutral stroke with coloured dots, not a coloured stroke.

          One line cannot carry seven identities. Colouring the stroke would
          either pick one category's hue for all of them — which says something
          false — or change with the form, which would make colour mean "which
          button is pressed". The dots are the identity and they match the bars
          and the slices exactly.
        */}
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--text-secondary)"
          strokeWidth={2}
          isAnimationActive={false}
          dot={({ cx, cy, payload }) => (
            <circle
              key={(payload as CategoryDatum).key}
              cx={cx}
              cy={cy}
              r={4.5}
              fill={(payload as { color: string }).color}
              stroke="var(--card-bg)"
              strokeWidth={2}
            />
          )}
          activeDot={{ r: 6, stroke: "var(--card-bg)", strokeWidth: 2 }}
        />
      </LineChart>
    ) : (
      <BarChart data={points} {...sized} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--gridline)" strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="label"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          interval={0}
          height={44}
          angle={-20}
          textAnchor="end"
        />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v) => format(Number(v))}
        />
        {tooltip}
        {/* 4px rounded at the data end only — the baseline end stays square so
            the bar reads as anchored to zero rather than floating above it. */}
        <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={56}>
          {points.map((p) => (
            <Cell key={p.key} fill={p.color} />
          ))}
        </Bar>
      </BarChart>
    );

  return (
    <div>
      {!fixedWidth && (
        <div className="mb-2 flex items-center justify-end">
          <FormSwitch value={form} onChange={setForm} allowed={allowed} />
        </div>
      )}
      <div style={{ height }}>
        {fixedWidth ? (
          chart
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {chart}
          </ResponsiveContainer>
        )}
      </div>
      {/*
        The legend.

        Always present, and always carrying the VALUE next to the name, so
        identity is never colour-alone and the circle form is readable without
        hovering every slice. On bar and line the category is already written
        under its mark, so this repeats the label — which is the point: the same
        swatch means the same thing in all three forms, and a reader who learns
        the mapping in one keeps it in the others.
      */}
      <ul
        className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px]"
        style={{ color: "var(--text-secondary)" }}
      >
        {points.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ background: p.color }}
            />
            <span>{p.label}</span>
            <span className="tnum" style={{ color: "var(--text-muted)" }}>
              {format(p.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
