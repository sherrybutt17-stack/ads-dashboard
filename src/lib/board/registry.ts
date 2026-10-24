import { AD_PLATFORMS, PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";
import { METRIC_POLARITY, type Polarity } from "@/lib/metrics/compute";
import { definitionFor, type MetricDefinition } from "@/lib/metrics/definitions";
import {
  evaluateFormula,
  formulaText,
  parseFormula,
  type FormulaNode,
  type FormulaToken,
} from "@/lib/metrics/formula";
import { metricValue, type Bag, type MetricOptions } from "./bag";
import {
  METRICS,
  METRIC_IDS,
  isMetricId,
  metricExtraKeys,
  metricLabel,
  metricStatKey,
  statLabel,
  type CustomMetricId,
  type DimensionId,
  type MetricFormat,
  type MetricId,
  type MetricNeed,
  type StatDef,
  type StatId,
  type StatLookup,
} from "./catalog";

/**
 * An agency's own metrics (Settings → Metrics) as Board stats.
 *
 * ── Two kinds ─────────────────────────────────────────────────────────
 *
 * - A **rename** is one platform's built-in stat under the agency's own name
 *   and description — Whatagraph's "custom name". Everything else, from how it
 *   splits to how reach is fetched, is the built-in's: the aggregator computes
 *   the base stat and only the label differs.
 * - A **formula** combines built-in stats with + − × ÷ and numbers. It is
 *   never additive (a total is computed, not summed), splits only the ways
 *   all its stats split, and is drawn over time only where all of them are.
 *
 * Formulas use built-in stats only — no formula of formulas — so there is
 * nothing to cycle, and an edit to one metric can never break another.
 *
 * ── Why a registry ────────────────────────────────────────────────────
 *
 * A board's stats are no longer a fixed list: the same widget code must
 * resolve `custom:<id>` for the board's agency and for no one else's. Every
 * place that turns a stat id into a label, a format, a direction or a value
 * asks a registry built from that agency's metrics; `BUILTIN` is the one with
 * none. An id the registry cannot resolve — deleted, or another agency's —
 * resolves to nothing, and the widget says so instead of guessing.
 *
 * Pure, and safe in the browser: pages receive the agency's metrics as props
 * and build the same registry the server does.
 */

/** One agency metric, as stored and as handed to pages and share links — plain JSON. */
export interface CustomMetric {
  id: string;
  kind: "rename" | "formula";
  /** A rename names one platform; a formula one, or "any" — every platform all its stats support. */
  platform: AdPlatform | "any";
  /** A rename's built-in stat. */
  baseMetric: MetricId | null;
  /** A formula's tokens (`metrics/formula.ts`). */
  expression: FormulaToken[] | null;
  label: string;
  description: string | null;
  /** A formula's own; a rename shows its base's. */
  format: MetricFormat | null;
  polarity: Polarity | null;
  archived: boolean;
}

export function customId(c: { id: string }): CustomMetricId {
  return `custom:${c.id}`;
}

export interface Registry extends StatLookup {
  /** The agency's metrics, as given — frozen into share links with the widgets that use them. */
  readonly customs: readonly CustomMetric[];
  label(id: StatId, platform: AdPlatform): string;
  /** Where space is tight, such as a creative card. */
  shortLabel(id: StatId, platform: AdPlatform): string;
  format(id: StatId): MetricFormat;
  additive(id: StatId): boolean;
  polarity(id: StatId, platform: AdPlatform): Polarity;
  definition(id: StatId, platform: AdPlatform): MetricDefinition | null;
  /** The built-in a rename stands for; any other id as it is. */
  base(id: StatId): StatId;
  /** Any stat's value from one row's components. Null means "no honest value". */
  value(id: StatId, b: Bag, opts?: MetricOptions): number | null;
  needs(id: StatId): readonly MetricNeed[];
  /** On Meta, read only from ad rows (`MetricDef.adRows`) — for a formula, if any of its stats is. */
  fromAdRows(id: StatId, platform: AdPlatform): boolean;
  /** The extra figures (`Bag.x` keys) it reads. */
  extraKeys(id: StatId): string[];
  /**
   * The agency's metrics on a platform, for the picker, by name. Archived ones
   * only when listed in `keep` — a widget already showing one keeps it.
   */
  customIds(platform: AdPlatform, keep?: readonly StatId[]): CustomMetricId[];
}

interface Entry {
  def: StatDef;
  metric: CustomMetric;
  /** A formula's parsed tree. */
  node: FormulaNode | null;
  /** A formula's built-in stats. */
  operands: MetricId[];
}

const DELETED = "Deleted metric";

function intersect(lists: ReadonlyArray<readonly DimensionId[]>): DimensionId[] {
  const [first = [], ...rest] = lists;
  return first.filter((d) => rest.every((l) => l.includes(d)));
}

/** A rename as a stat: the base under a new name, on its one platform. Null when its base no longer fits. */
function renameEntry(c: CustomMetric): Entry | null {
  if (c.platform === "any" || !c.baseMetric || !isMetricId(c.baseMetric)) return null;
  const base = METRICS[c.baseMetric];
  const p = c.platform;
  if (!base.platforms.includes(p)) return null;
  return {
    metric: c,
    node: null,
    operands: [base.id],
    def: {
      ...base,
      id: customId(c),
      label: c.label,
      labels: undefined,
      short: undefined,
      group: "Custom metrics",
      platforms: [p],
      series: base.series.includes(p) ? [p] : [],
      dims: { [p]: base.dims[p] ?? [] },
      custom: { kind: "rename", base: base.id, description: c.description, archived: c.archived },
    },
  };
}

/** A formula as a stat. Null when it no longer parses or no platform reports all its stats. */
function formulaEntry(c: CustomMetric): Entry | null {
  const parsed = parseFormula(c.expression ?? []);
  if (!parsed.ok || parsed.stats.length === 0 || !parsed.stats.every(isMetricId)) return null;
  const operands = parsed.stats as MetricId[];
  const defs = operands.map((id) => METRICS[id]);
  const platforms = (c.platform === "any" ? AD_PLATFORMS : [c.platform]).filter((p) =>
    defs.every((d) => d.platforms.includes(p)),
  );
  if (platforms.length === 0) return null;
  return {
    metric: c,
    node: parsed.node,
    operands,
    def: {
      id: customId(c),
      label: c.label,
      format: c.format ?? "decimal",
      group: "Custom metrics",
      // Not a key of the built-in maps: direction and definition come from the metric itself.
      statKey: "",
      platforms,
      additive: false,
      series: platforms.filter((p) => defs.every((d) => d.series.includes(p))),
      dims: Object.fromEntries(platforms.map((p) => [p, intersect(defs.map((d) => d.dims[p] ?? []))])),
      // A computed figure split by campaign ranks by where the money went.
      rankBy: "spend",
      needs: [...new Set(defs.flatMap((d) => d.needs))],
      ...(defs.some((d) => d.adRows) ? { adRows: true as const } : {}),
      custom: { kind: "formula", base: null, description: c.description, archived: c.archived },
    },
  };
}

export function buildRegistry(customs: readonly CustomMetric[]): Registry {
  const entries = new Map<StatId, Entry>();
  for (const c of customs) {
    const e = c.kind === "rename" ? renameEntry(c) : formulaEntry(c);
    if (e) entries.set(e.def.id, e);
  }

  const get = (id: StatId): StatDef | null => (isMetricId(id) ? METRICS[id] : (entries.get(id)?.def ?? null));
  const base = (id: StatId): StatId => entries.get(id)?.def.custom?.base ?? id;

  const reg: Registry = {
    customs,
    get,
    base,
    label(id, platform) {
      const d = get(id);
      return d ? statLabel(d, platform) : DELETED;
    },
    shortLabel(id, platform) {
      const d = get(id);
      return d ? (d.short ?? statLabel(d, platform)) : DELETED;
    },
    format(id) {
      return get(id)?.format ?? "count";
    },
    additive(id) {
      return get(id)?.additive ?? false;
    },
    polarity(id, platform) {
      if (isMetricId(id)) return METRIC_POLARITY[metricStatKey(id, platform)] ?? "neutral";
      const e = entries.get(id);
      if (!e) return "neutral";
      if (e.metric.polarity) return e.metric.polarity;
      const b = e.def.custom?.base;
      return b ? (METRIC_POLARITY[metricStatKey(b, platform)] ?? "neutral") : "neutral";
    },
    definition(id, platform) {
      if (isMetricId(id)) return definitionFor(metricStatKey(id, platform));
      const e = entries.get(id);
      if (!e) return null;
      const own = e.metric.description?.trim() || null;
      const b = e.def.custom?.base;
      if (b) {
        const inner = definitionFor(metricStatKey(b, platform));
        return {
          what: own ?? inner?.what ?? `${metricLabel(b, platform)}, under your agency's own name.`,
          formula: inner?.formula ?? `${PLATFORM_LABEL[platform]}'s ${metricLabel(b, platform)}.`,
          caveat: [`Your agency's name for ${PLATFORM_LABEL[platform]}'s “${metricLabel(b, platform)}”.`, inner?.caveat]
            .filter(Boolean)
            .join(" "),
        };
      }
      return {
        what: own ?? "A formula set up by your agency.",
        formula: formulaText(e.metric.expression ?? [], (op) => (isMetricId(op) ? metricLabel(op, platform) : op)),
        caveat: "Worked out from each row's summed figures, so a total is never an average of the rows.",
      };
    },
    value(id, b, opts = {}) {
      if (isMetricId(id)) return metricValue(id, b, opts);
      const e = entries.get(id);
      if (!e) return null;
      const r = e.def.custom?.base;
      if (r) return metricValue(r, b, opts);
      // Each stat on the same row's components — a ratio of sums, never an average.
      return e.node ? evaluateFormula(e.node, (op) => (isMetricId(op) ? metricValue(op, b, opts) : null)) : null;
    },
    needs(id) {
      return get(id)?.needs ?? [];
    },
    fromAdRows(id, platform) {
      return platform === "meta" && get(id)?.adRows === true;
    },
    extraKeys(id) {
      if (isMetricId(id)) return metricExtraKeys(id);
      const e = entries.get(id);
      return e ? [...new Set(e.operands.flatMap(metricExtraKeys))] : [];
    },
    customIds(platform, keep = []) {
      return [...entries.values()]
        .filter((e) => e.def.platforms.includes(platform) && (!e.metric.archived || keep.includes(e.def.id)))
        .sort((a, b) => a.def.label.localeCompare(b.def.label))
        .map((e) => e.def.id as CustomMetricId);
    },
  };
  return reg;
}

/** The built-in stats alone — for anything that never meets an agency's metrics. */
export const BUILTIN: Registry = buildRegistry([]);

/* ------------------------------------------------------------------ *
 * Validation — the settings API's, and a stored row's on the way out
 * ------------------------------------------------------------------ */

export const CUSTOM_LIMITS = { label: 40, description: 280, perAgency: 200 } as const;

/** What the settings form sends: a metric before it has an id. */
export interface CustomMetricDraft {
  kind: "rename" | "formula";
  platform: AdPlatform | "any";
  baseMetric: string | null;
  expression: FormulaToken[] | null;
  label: string;
  description: string | null;
  format: MetricFormat | null;
  polarity: Polarity | null;
}

export type DraftCheck =
  | { ok: true }
  | {
      ok: false;
      field: "label" | "description" | "platform" | "baseMetric" | "expression" | "format" | "polarity";
      error: string;
    };

const platformsOf = (p: AdPlatform | "any"): readonly AdPlatform[] => (p === "any" ? AD_PLATFORMS : [p]);
const nameOf = (p: AdPlatform | "any") => (p === "any" ? "any platform" : PLATFORM_LABEL[p]);

/**
 * Whether a metric can be saved, with the sentence the form shows when not.
 * `others` are the agency's other metrics (the one being edited left out).
 */
export function validateCustomMetric(d: CustomMetricDraft, others: readonly CustomMetric[]): DraftCheck {
  const label = d.label.trim();
  if (label.length < 1 || label.length > CUSTOM_LIMITS.label) {
    return { ok: false, field: "label", error: `Give the metric a name of 1 to ${CUSTOM_LIMITS.label} characters.` };
  }
  const key = label.toLowerCase();
  const mine = platformsOf(d.platform);
  const clash = others.find(
    (o) => o.label.trim().toLowerCase() === key && platformsOf(o.platform).some((p) => mine.includes(p)),
  );
  if (clash) {
    return { ok: false, field: "label", error: `Another metric for ${nameOf(clash.platform)} is already called “${clash.label}”.` };
  }
  for (const p of mine) {
    const builtIn = METRIC_IDS.find((m) => METRICS[m].platforms.includes(p) && metricLabel(m, p).toLowerCase() === key);
    if (builtIn) {
      return { ok: false, field: "label", error: `“${label}” is already a stat on ${PLATFORM_LABEL[p]} — choose another name.` };
    }
  }
  if ((d.description ?? "").length > CUSTOM_LIMITS.description) {
    return { ok: false, field: "description", error: `Keep the description to ${CUSTOM_LIMITS.description} characters.` };
  }

  if (d.kind === "rename") {
    if (d.platform === "any") return { ok: false, field: "platform", error: "Choose the platform whose stat you are renaming." };
    if (!d.baseMetric || !isMetricId(d.baseMetric)) {
      return { ok: false, field: "baseMetric", error: "Choose the stat to rename." };
    }
    if (!METRICS[d.baseMetric].platforms.includes(d.platform)) {
      return { ok: false, field: "baseMetric", error: `${PLATFORM_LABEL[d.platform]} does not report ${METRICS[d.baseMetric].label}.` };
    }
    return { ok: true };
  }

  const parsed = parseFormula(d.expression ?? []);
  if (!parsed.ok) return { ok: false, field: "expression", error: parsed.error };
  if (parsed.stats.length === 0) {
    return { ok: false, field: "expression", error: "A formula needs at least one stat." };
  }
  if (!parsed.stats.every(isMetricId)) {
    return { ok: false, field: "expression", error: "A formula can use built-in stats only, not other custom metrics." };
  }
  const defs = (parsed.stats as MetricId[]).map((id) => METRICS[id]);
  const reach = defs.find((x) => x.id === "reach" || x.id === "frequency");
  if (reach) {
    return {
      ok: false,
      field: "expression",
      error: `${reach.label} counts distinct people across a whole range, so it can't go into a formula.`,
    };
  }
  const platforms = mine.filter((p) => defs.every((x) => x.platforms.includes(p)));
  if (platforms.length === 0) {
    const missing = d.platform === "any" ? null : defs.find((x) => !x.platforms.includes(d.platform as AdPlatform));
    return {
      ok: false,
      field: "expression",
      error: missing
        ? `${PLATFORM_LABEL[d.platform as AdPlatform]} does not report ${missing.label}.`
        : "No platform reports every stat in this formula.",
    };
  }
  if (platforms.includes("meta")) {
    const adOnly = defs.find((x) => x.adRows);
    const other = defs.find((x) => x.needs.some((n) => n === "crm" || n === "revenue" || n === "results"));
    if (adOnly && other) {
      return {
        ok: false,
        field: "expression",
        error: `On Meta, ${adOnly.label} is only reported per ad, so it can't be combined with ${other.label}.`,
      };
    }
  }
  if (!d.format) return { ok: false, field: "format", error: "Choose how the result is shown." };
  if (!d.polarity) return { ok: false, field: "polarity", error: "Choose whether higher or lower is better." };
  return { ok: true };
}
