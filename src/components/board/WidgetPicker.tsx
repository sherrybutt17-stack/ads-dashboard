"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Modal } from "@/components/Modal";
import {
  CARDS,
  DIMENSION_IDS,
  METRICS,
  METRIC_GROUPS,
  METRIC_IDS,
  PRESETS,
  TABLE_COLUMNS,
  TABLE_ROWS,
  TEXT_MAX,
  TITLE_MAX,
  TOP_N,
  VISUALS,
  WIDGET_KINDS,
  canBeCircle,
  checkWidget,
  defaultTitle,
  dimensionLabel,
  metricDims,
  metricLabel,
  metricSeries,
  metricStatKey,
  metricSupports,
  type CardGrouping,
  type CategoryForm,
  type DimensionId,
  type MetricId,
  type SeriesForm,
  type Size,
  type TableDimension,
} from "@/lib/board/catalog";
import { boxHeightPx } from "@/lib/board/grid";
import { encodeWidgetQuery, widgetQueryKey } from "@/lib/board/query";
import type { BoardWidget, WidgetData, WidgetQuery } from "@/lib/board/types";
import { PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";
import { resultTypeChoices } from "@/lib/metrics/results";
import { METRIC_POLARITY } from "@/lib/metrics/compute";
import { BoardWidget as WidgetCard } from "./BoardWidget";

export interface PickerResult {
  query: WidgetQuery;
  title?: string;
  /** A preset's own size, when a preset was chosen. */
  size?: Size;
  /** The preview's numbers, so the board can show them without asking again. */
  data?: WidgetData;
}

/** Everything the Build form can set; turned into a query by `queryOf`. */
interface Draft {
  visual: string;
  platform: AdPlatform;
  metric: MetricId;
  dimension: DimensionId;
  topN: number;
  compare: boolean;
  tableDimension: TableDimension;
  columns: MetricId[];
  sort: MetricId;
  rows: number;
  text: string;
  textSize: "heading" | "body";
  title: string;
  /** A pinned result type; "" counts the range's main type. */
  resultType: string;
  /** Creative cards: one per ad or per creative. */
  cardBy: CardGrouping;
  /** The stats on each card, in order. */
  cardStats: MetricId[];
  cardSort: MetricId;
  cards: number;
  cardRankings: boolean;
  /** Meta campaign ids; empty = every campaign. */
  campaigns: string[];
}

/** A Meta campaign the cards can be narrowed to. */
export interface CampaignChoice {
  id: string;
  name: string | null;
}

const BLANK: Omit<Draft, "platform"> = {
  visual: "kpi",
  metric: "spend",
  dimension: "campaign",
  topN: 6,
  compare: true,
  tableDimension: "campaign",
  columns: ["spend", "impressions", "clicks", "ctr"],
  sort: "spend",
  rows: 10,
  text: "",
  textSize: "heading",
  title: "",
  resultType: "",
  // Whatagraph's link-click report: one card per ad, ranked by link clicks.
  cardBy: "ad",
  cardStats: ["impressions", "clicks", "ctr_all"],
  cardSort: "clicks",
  cards: 6,
  cardRankings: false,
  campaigns: [],
};

/** The stats a fresh card set falls back to when the chosen ones no longer fit. */
const DEFAULT_CARD_STATS: readonly MetricId[] = ["impressions", "clicks", "ctr_all", "spend"];

const LOADING: WidgetData = { kind: "pending", reason: "load" };

function visualOf(q: WidgetQuery): string {
  // The visual ids are the chart forms, plus one per kind that has no form.
  return q.kind === "series" || q.kind === "category" ? q.form : q.kind;
}

function draftFrom(q: WidgetQuery, title: string | undefined, platform: AdPlatform): Draft {
  const d: Draft = {
    ...BLANK,
    platform: "platform" in q ? q.platform : platform,
    visual: visualOf(q),
    title: title ?? "",
  };
  switch (q.kind) {
    case "kpi":
      return { ...d, metric: q.metric, resultType: q.resultType ?? "" };
    case "series":
      return { ...d, metric: q.metric, compare: q.compare, resultType: q.resultType ?? "" };
    case "category":
      return { ...d, metric: q.metric, dimension: q.dimension, topN: q.topN, resultType: q.resultType ?? "" };
    case "table":
      return {
        ...d,
        tableDimension: q.dimension,
        columns: [...q.metrics],
        sort: q.sort,
        rows: q.topN,
        resultType: q.resultType ?? "",
      };
    case "creatives":
      return {
        ...d,
        cardBy: q.by,
        cardStats: [...q.stats],
        cardSort: q.sort,
        cards: q.topN,
        cardRankings: Boolean(q.rankings),
        campaigns: q.campaigns ? [...q.campaigns] : [],
        resultType: q.resultType ?? "",
      };
    case "text":
      return { ...d, text: q.text, textSize: q.size };
    case "funnel":
    case "logo":
      return d;
  }
}

function queryOf(d: Draft): WidgetQuery {
  const v = VISUALS.find((x) => x.id === d.visual) ?? VISUALS[0];
  // Only a results widget carries a pinned type; "" means the main type.
  const pin = d.resultType ? { resultType: d.resultType } : {};
  switch (v.kind) {
    case "kpi":
      return { kind: "kpi", platform: d.platform, metric: d.metric, ...pin };
    case "series":
      return {
        kind: "series",
        platform: d.platform,
        metric: d.metric,
        form: v.form as SeriesForm,
        compare: d.compare,
        ...pin,
      };
    case "category":
      return {
        kind: "category",
        platform: d.platform,
        metric: d.metric,
        dimension: d.dimension,
        form: v.form as CategoryForm,
        topN: d.topN,
        ...pin,
      };
    case "table":
      return {
        kind: "table",
        platform: d.platform,
        dimension: d.tableDimension,
        metrics: d.columns,
        sort: d.sort,
        topN: d.rows,
        ...pin,
      };
    case "creatives":
      return {
        kind: "creatives",
        // Ad-level data exists for Meta only.
        platform: "meta",
        by: d.cardBy,
        stats: d.cardStats,
        sort: d.cardSort,
        topN: d.cards,
        ...(d.cardRankings ? { rankings: true } : {}),
        ...pin,
        ...(d.campaigns.length > 0 ? { campaigns: [...d.campaigns].sort() } : {}),
      };
    case "funnel":
      return { kind: "funnel", platform: d.platform };
    case "text":
      return { kind: "text", text: d.text, size: d.textSize };
    case "logo":
      return { kind: "logo" };
  }
}

const isCircle = (visual: string) => visual === "pie" || visual === "donut";

/** Why a stat cannot fill this visual on this platform, or null when it can. */
function metricBlock(m: MetricId, d: Draft): string | null {
  const kind = VISUALS.find((x) => x.id === d.visual)?.kind;
  if (!metricSupports(m, d.platform)) return `not on ${PLATFORM_LABEL[d.platform]}`;
  if (kind === "series" && !metricSeries(m, d.platform)) return "single value only";
  if (kind === "category") {
    if (metricDims(m, d.platform).length === 0) return "cannot be split";
    if (isCircle(d.visual) && !canBeCircle(m)) return "not parts of a whole";
  }
  return null;
}

function columnFits(m: MetricId, d: Draft): boolean {
  if (!metricSupports(m, d.platform)) return false;
  return d.tableDimension === "date"
    ? metricSeries(m, d.platform)
    : metricDims(m, d.platform).includes(d.tableDimension);
}

/** Whether a stat can go on a creative card: reported per ad (or creative), and not a CRM figure. */
function cardStatFits(m: MetricId, by: CardGrouping): boolean {
  const def = METRICS[m];
  if (def.needs.includes("crm") || def.needs.includes("revenue")) return false;
  return metricSupports(m, "meta") && metricDims(m, "meta").includes(by);
}

/** Row choices for a table: every split some stat on this platform supports, and days. */
function tableDimensions(platform: AdPlatform): TableDimension[] {
  const dims = DIMENSION_IDS.filter((dim) =>
    METRIC_IDS.some((m) => metricSupports(m, platform) && metricDims(m, platform).includes(dim)),
  );
  return [...dims, "date"];
}

/**
 * Bring the dependent choices back to something valid after one changed —
 * switching to a pie keeps the stat if it can be a pie, and only otherwise
 * picks the first one that can. A form that silently reset everything on each
 * click would make the Build tab feel like it was fighting back.
 */
function fixUp(d: Draft): Draft {
  const kind = VISUALS.find((x) => x.id === d.visual)?.kind ?? "kpi";
  const next = { ...d };
  if (kind === "kpi" || kind === "series" || kind === "category") {
    if (metricBlock(next.metric, next)) {
      next.metric = METRIC_IDS.find((m) => !metricBlock(m, next)) ?? next.metric;
    }
  }
  if (kind === "category") {
    const dims = metricDims(next.metric, next.platform);
    if (!dims.includes(next.dimension)) next.dimension = dims[0] ?? "campaign";
    const max = isCircle(next.visual) ? TOP_N.circleMax : TOP_N.max;
    next.topN = Math.min(max, Math.max(TOP_N.min, next.topN));
  }
  if (kind === "table") {
    const dims = tableDimensions(next.platform);
    if (!dims.includes(next.tableDimension)) next.tableDimension = dims[0];
    let cols = next.columns.filter((m) => columnFits(m, next));
    if (cols.length === 0) {
      cols = (["spend", "impressions", "clicks", "ctr", "leads"] as MetricId[]).filter((m) => columnFits(m, next));
    }
    next.columns = cols.slice(0, TABLE_COLUMNS.max);
    if (!next.columns.includes(next.sort)) next.sort = next.columns[0] ?? "spend";
    next.rows = Math.min(TABLE_ROWS.max, Math.max(TABLE_ROWS.min, next.rows));
  }
  if (kind === "creatives") {
    next.platform = "meta";
    let stats = [...new Set(next.cardStats)].filter((m) => cardStatFits(m, next.cardBy));
    if (stats.length === 0) stats = DEFAULT_CARD_STATS.filter((m) => cardStatFits(m, next.cardBy));
    next.cardStats = stats.slice(0, CARDS.statsMax);
    if (!cardStatFits(next.cardSort, next.cardBy)) next.cardSort = next.cardStats[0] ?? "spend";
    next.cards = Math.min(CARDS.max, Math.max(CARDS.min, next.cards));
    next.campaigns = [...new Set(next.campaigns)].slice(0, CARDS.campaignsMax);
  }
  // A pinned result type only on a results widget it can apply to.
  if (!pinsResultType(next) || !resultTypeChoices(next.platform).some((c) => c.key === next.resultType)) {
    next.resultType = "";
  }
  return next;
}

/** Whether this draft counts results of one type — so a type can be pinned. */
function pinsResultType(d: Draft): boolean {
  const kind = VISUALS.find((x) => x.id === d.visual)?.kind;
  if (d.platform === "google") return false;
  const reads = (m: MetricId) => METRICS[m].needs.includes("results");
  if (kind === "kpi" || kind === "series") return reads(d.metric);
  if (kind === "category") return reads(d.metric) && d.dimension !== "result_type";
  if (kind === "table") return d.tableDimension !== "result_type" && d.columns.some(reads);
  if (kind === "creatives") return [...d.cardStats, d.cardSort].some(reads);
  return false;
}

/**
 * Add a widget, or change one: ready-made presets, or built step by step —
 * visual, source, stat, split, options — with a live preview of the real
 * numbers for the board's range.
 *
 * Nothing it offers can fail to save. Every choice is run through
 * `checkWidget`, the same rule the save path enforces, and a choice that
 * cannot work is shown disabled with the reason rather than hidden: a stat
 * that vanishes from the list when you pick a pie chart reads as a bug, and
 * "CTR — not parts of a whole" teaches the rule.
 *
 * The preview asks the data API, debounced and cancelled on change, so typing
 * a title or flicking through forms does not queue a request per keystroke.
 */
export function WidgetPicker({
  open,
  editing,
  platforms,
  campaigns = [],
  slug,
  range,
  basis,
  onClose,
  onDone,
}: {
  open: boolean;
  /** The widget being changed, or null to add a new one. */
  editing: BoardWidget | null;
  /** Ad platforms this client has connected; the first is the default source. */
  platforms: readonly AdPlatform[];
  /** Meta campaigns the creative cards can be narrowed to. */
  campaigns?: readonly CampaignChoice[];
  slug: string;
  range: { start: string; end: string };
  basis: string;
  onClose: () => void;
  onDone: (result: PickerResult) => void;
}) {
  const sources: readonly AdPlatform[] = platforms.length > 0 ? platforms : ["meta"];
  const [tab, setTab] = useState<"prebuilt" | "build">(editing ? "build" : "prebuilt");
  const [draft, setDraft] = useState<Draft>(() =>
    editing ? draftFrom(editing, editing.title, sources[0]) : { ...BLANK, platform: sources[0] },
  );
  const [presetSize, setPresetSize] = useState<Size | undefined>(undefined);
  const [chosenPreset, setChosenPreset] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; data: WidgetData } | null>(null);

  const ids = useId();
  const update = (patch: Partial<Draft>) => {
    setChosenPreset(null);
    setPresetSize(undefined);
    setDraft((d) => fixUp({ ...d, ...patch }));
  };

  const query = queryOf(draft);
  const check = checkWidget(query);
  const blank = query.kind === "text" && query.text.trim() === "";
  const problem = !check.ok ? check.reason : blank ? "Write the text this widget shows." : null;

  // The form is left out of the preview's question: switching a bar to a donut
  // is the same numbers, so it should not cost a request.
  const fetchQuery: WidgetQuery =
    query.kind === "category" ? { ...query, form: "bar" } : query.kind === "series" ? { ...query, form: "line" } : query;
  const key = problem ? null : widgetQueryKey(fetchQuery);
  const local = query.kind === "text";
  const url = key
    ? `/api/c/${encodeURIComponent(slug)}/board/data?w=${encodeWidgetQuery(fetchQuery)}&start=${range.start}&end=${range.end}`
    : null;

  useEffect(() => {
    if (!open || !key || !url || local) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(url, { cache: "no-store", signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((body: { data?: WidgetData }) => {
          setPreview({
            key,
            data: body.data ?? { kind: "unavailable", tone: "problem", title: "No preview" },
          });
        })
        .catch(() => {
          if (!ctl.signal.aborted) {
            setPreview({ key, data: { kind: "unavailable", tone: "problem", title: "The preview could not be loaded" } });
          }
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [open, key, url, local]);

  const previewData: WidgetData = local ? { kind: "text" } : preview && preview.key === key ? preview.data : LOADING;
  const size: Size =
    presetSize ?? (editing ? { w: editing.w, h: editing.h } : WIDGET_KINDS[query.kind].size);
  const title = draft.title.trim() || undefined;
  const previewWidget = { ...query, id: "preview", x: 0, y: 0, w: size.w, h: size.h, title } as BoardWidget;

  function choosePreset(id: string) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const q = withPlatform(preset.query, draft.platform);
    setDraft(fixUp(draftFrom(q, undefined, draft.platform)));
    setPresetSize(preset.size);
    setChosenPreset(id);
  }

  function finish() {
    if (problem) return;
    onDone({
      query,
      title,
      size: presetSize,
      data: !local && preview && preview.key === key ? preview.data : undefined,
    });
  }

  const kind = VISUALS.find((x) => x.id === draft.visual)?.kind ?? "kpi";
  // Creative cards are Meta's alone, so there is no source to choose.
  const hasSource = kind !== "text" && kind !== "logo" && kind !== "creatives";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? "Widget settings" : "Add a widget"}
      description="Numbers in the preview are for the range the board is showing."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {!editing ? (
            <div role="tablist" aria-label="How to choose" className="inline-flex rounded-[var(--radius-sm)] border p-0.5" style={{ borderColor: "var(--border-strong)", background: "var(--surface-2)" }}>
              {(["prebuilt", "build"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  id={`${ids}-tab-${t}`}
                  aria-selected={tab === t}
                  aria-controls={`${ids}-panel-${t}`}
                  onClick={() => setTab(t)}
                  className="rounded-[var(--radius-xs)] px-3 py-1.5 text-[13px] font-medium transition-colors"
                  style={{
                    background: tab === t ? "var(--surface-1)" : "transparent",
                    color: tab === t ? "var(--text-primary)" : "var(--text-muted)",
                  }}
                >
                  {t === "prebuilt" ? "Prebuilt" : "Build your own"}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          {sources.length > 1 && (tab === "prebuilt" || hasSource) && (
            <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text-secondary)" }}>
              Source
              <span className="w-36">
              <select
                className="field"
                value={draft.platform}
                onChange={(e) => {
                  const platform = e.target.value as AdPlatform;
                  if (chosenPreset) {
                    const preset = PRESETS.find((p) => p.id === chosenPreset);
                    if (preset) {
                      setDraft(fixUp(draftFrom(withPlatform(preset.query, platform), undefined, platform)));
                      return;
                    }
                  }
                  update({ platform });
                }}
              >
                {sources.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
              </span>
            </label>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
          <div className="min-w-0">
            {tab === "prebuilt" && !editing ? (
              <div
                role="tabpanel"
                id={`${ids}-panel-prebuilt`}
                aria-labelledby={`${ids}-tab-prebuilt`}
                className="grid max-h-[460px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2"
              >
                {PRESETS.map((p) => {
                  const verdict = checkWidget(withPlatform(p.query, draft.platform));
                  const selected = chosenPreset === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={!verdict.ok}
                      aria-pressed={selected}
                      title={verdict.ok ? undefined : verdict.reason}
                      onClick={() => choosePreset(p.id)}
                      className="flex flex-col items-start gap-0.5 rounded-[var(--radius-sm)] border px-3 py-2 text-left transition-colors hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                      style={{
                        borderColor: selected ? "var(--accent)" : "var(--border)",
                        boxShadow: selected ? "0 0 0 1px var(--accent)" : undefined,
                      }}
                    >
                      <span className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                        {p.label}
                      </span>
                      <span className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                        {verdict.ok ? p.description : verdict.reason}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div
                role={editing ? undefined : "tabpanel"}
                id={`${ids}-panel-build`}
                aria-labelledby={editing ? undefined : `${ids}-tab-build`}
                className="flex flex-col gap-4"
              >
                <Field label="Visual">
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Visual">
                    {VISUALS.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        role="radio"
                        aria-checked={draft.visual === v.id}
                        onClick={() => update({ visual: v.id })}
                        className="chip"
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </Field>

                {(kind === "kpi" || kind === "series" || kind === "category") && (
                  <Field label="Stat" htmlFor={`${ids}-metric`}>
                    <select
                      id={`${ids}-metric`}
                      className="field w-full"
                      value={draft.metric}
                      onChange={(e) => update({ metric: e.target.value as MetricId })}
                    >
                      {METRIC_GROUPS.map((g) => {
                        const inGroup = METRIC_IDS.filter((m) => METRICS[m].group === g);
                        if (inGroup.length === 0) return null;
                        return (
                          <optgroup key={g} label={g}>
                            {inGroup.map((m) => {
                              const block = metricBlock(m, draft);
                              return (
                                <option key={m} value={m} disabled={Boolean(block)}>
                                  {metricLabel(m, draft.platform)}
                                  {block ? ` — ${block}` : ""}
                                </option>
                              );
                            })}
                          </optgroup>
                        );
                      })}
                    </select>
                  </Field>
                )}

                {kind === "category" && (
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
                    <Field label="Split by" htmlFor={`${ids}-dim`}>
                      <select
                        id={`${ids}-dim`}
                        className="field w-full"
                        value={draft.dimension}
                        onChange={(e) => update({ dimension: e.target.value as DimensionId })}
                      >
                        {metricDims(draft.metric, draft.platform).map((d) => (
                          <option key={d} value={d}>
                            {dimensionLabel(d)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Show" htmlFor={`${ids}-topn`}>
                      <input
                        id={`${ids}-topn`}
                        type="number"
                        className="field w-full"
                        min={TOP_N.min}
                        max={isCircle(draft.visual) ? TOP_N.circleMax : TOP_N.max}
                        value={draft.topN}
                        onChange={(e) => update({ topN: Number(e.target.value) || TOP_N.min })}
                      />
                    </Field>
                  </div>
                )}

                {kind === "series" && (
                  <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={draft.compare}
                      onChange={(e) => update({ compare: e.target.checked })}
                    />
                    Show the previous period as a dashed line
                  </label>
                )}

                {kind === "table" && (
                  <TableFields draft={draft} update={update} ids={ids} />
                )}

                {kind === "creatives" && (
                  <CreativeFields draft={draft} update={update} ids={ids} campaigns={campaigns} />
                )}

                {pinsResultType(draft) && (
                  <Field label="Result type" htmlFor={`${ids}-rtype`}>
                    <select
                      id={`${ids}-rtype`}
                      className="field w-full"
                      value={draft.resultType}
                      onChange={(e) => update({ resultType: e.target.value })}
                    >
                      <option value="">The kind most spend went to (automatic)</option>
                      {resultTypeChoices(draft.platform).map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}

                {kind === "text" && (
                  <>
                    <Field label="Text" htmlFor={`${ids}-text`}>
                      <textarea
                        id={`${ids}-text`}
                        className="field min-h-[96px] w-full"
                        maxLength={TEXT_MAX}
                        value={draft.text}
                        onChange={(e) => update({ text: e.target.value })}
                      />
                    </Field>
                    <div className="flex gap-1.5" role="radiogroup" aria-label="Text style">
                      {(["heading", "body"] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          role="radio"
                          aria-checked={draft.textSize === s}
                          onClick={() => update({ textSize: s })}
                          className="chip"
                        >
                          {s === "heading" ? "Heading" : "Note in a card"}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {kind !== "text" && kind !== "logo" && (
                  <Field label="Title" htmlFor={`${ids}-title`}>
                    <input
                      id={`${ids}-title`}
                      className="field w-full"
                      maxLength={TITLE_MAX}
                      placeholder={defaultTitle(query)}
                      value={draft.title}
                      onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <p
              className="mb-2 text-[11px] font-semibold tracking-[0.06em] uppercase"
              style={{ color: "var(--text-muted)" }}
            >
              Preview
            </p>
            <div className="flex min-w-0 flex-col" style={{ height: boxHeightPx(Math.min(size.h, 9)) }}>
              {problem ? (
                <div
                  className="flex h-full items-center justify-center rounded-[var(--radius)] border border-dashed p-4 text-center text-[12.5px]"
                  style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}
                >
                  {problem}
                </div>
              ) : (
                <WidgetCard
                  key={key ?? "none"}
                  widget={previewWidget}
                  data={previewData}
                  slug={slug}
                  range={range}
                  basis={basis}
                  showPlatform={sources.length > 1}
                />
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4" style={{ borderColor: "var(--border)" }}>
          {problem && (
            <p className="mr-auto text-[12px]" role="status" style={{ color: "var(--text-muted)" }}>
              {problem}
            </p>
          )}
          <button type="button" className="btn-ghost rounded-[var(--radius-sm)] px-3 py-2 text-[13px]" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-accent" disabled={Boolean(problem)} onClick={finish}>
            {editing ? "Save changes" : "Add widget"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function withPlatform(q: WidgetQuery, platform: AdPlatform): WidgetQuery {
  return "platform" in q ? ({ ...q, platform } as WidgetQuery) : q;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
          {label}
        </label>
      ) : (
        <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

function TableFields({
  draft,
  update,
  ids,
}: {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  ids: string;
}) {
  const dims = tableDimensions(draft.platform);
  const full = draft.columns.length >= TABLE_COLUMNS.max;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_100px]">
        <Field label="One row per" htmlFor={`${ids}-rows-by`}>
          <select
            id={`${ids}-rows-by`}
            className="field w-full"
            value={draft.tableDimension}
            onChange={(e) => update({ tableDimension: e.target.value as TableDimension })}
          >
            {dims.map((d) => (
              <option key={d} value={d}>
                {dimensionLabel(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sort by" htmlFor={`${ids}-sort`}>
          <select
            id={`${ids}-sort`}
            className="field w-full"
            value={draft.sort}
            onChange={(e) => update({ sort: e.target.value as MetricId })}
          >
            {draft.columns.map((m) => (
              <option key={m} value={m}>
                {metricLabel(m, draft.platform)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rows" htmlFor={`${ids}-rows`}>
          <input
            id={`${ids}-rows`}
            type="number"
            className="field w-full"
            min={TABLE_ROWS.min}
            max={TABLE_ROWS.max}
            value={draft.rows}
            onChange={(e) => update({ rows: Number(e.target.value) || TABLE_ROWS.min })}
          />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
          Columns ({draft.columns.length} of at most {TABLE_COLUMNS.max})
        </legend>
        <div className="grid max-h-[200px] grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto sm:grid-cols-2">
          {METRIC_IDS.filter((m) => metricSupports(m, draft.platform)).map((m) => {
            const fits = columnFits(m, draft);
            const on = draft.columns.includes(m);
            return (
              <label
                key={m}
                className="flex items-center gap-2 text-[12.5px]"
                style={{ color: fits ? "var(--text-secondary)" : "var(--text-muted)" }}
                title={fits ? undefined : `Not available per ${dimensionLabel(draft.tableDimension).toLowerCase()}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!fits || (!on && full) || (on && draft.columns.length <= TABLE_COLUMNS.min)}
                  onChange={(e) =>
                    update({
                      columns: e.target.checked
                        ? [...draft.columns, m]
                        : draft.columns.filter((c) => c !== m),
                    })
                  }
                />
                {metricLabel(m, draft.platform)}
              </label>
            );
          })}
        </div>
      </fieldset>
    </>
  );
}

/** Stats a card can carry, grouped as the Stat list is, for the add and rank selects. */
function CardStatOptions({ by, omit }: { by: CardGrouping; omit?: readonly MetricId[] }) {
  return (
    <>
      {METRIC_GROUPS.map((g) => {
        const inGroup = METRIC_IDS.filter(
          (m) => METRICS[m].group === g && cardStatFits(m, by) && !omit?.includes(m),
        );
        if (inGroup.length === 0) return null;
        return (
          <optgroup key={g} label={g}>
            {inGroup.map((m) => (
              <option key={m} value={m}>
                {metricLabel(m, "meta")}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

/**
 * The creative cards' own settings — Whatagraph's "Creatives performance":
 * the stats each card shows (in order), what ranks them, how many, and which
 * campaigns. A lead report ranks by leads, a click report by link clicks.
 */
function CreativeFields({
  draft,
  update,
  ids,
  campaigns,
}: {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  ids: string;
  campaigns: readonly CampaignChoice[];
}) {
  const [filter, setFilter] = useState("");
  const stats = draft.cardStats;
  const full = stats.length >= CARDS.statsMax;
  const lowestFirst = METRIC_POLARITY[metricStatKey(draft.cardSort, "meta")] === "lower-better";
  const move = (from: number, to: number) => {
    const next = [...stats];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    update({ cardStats: next });
  };
  // Saved campaigns no longer in the list stay, named by id, until removed.
  const known = new Set(campaigns.map((c) => c.id));
  const listed: CampaignChoice[] = [
    ...campaigns,
    ...draft.campaigns.filter((id) => !known.has(id)).map((id) => ({ id, name: null })),
  ];
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? listed.filter((c) => (c.name ?? c.id).toLowerCase().includes(needle))
    : listed;
  const picked = new Set(draft.campaigns);
  const atCap = draft.campaigns.length >= CARDS.campaignsMax;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_100px]">
        <Field label="One card per" htmlFor={`${ids}-card-by`}>
          <select
            id={`${ids}-card-by`}
            className="field w-full"
            value={draft.cardBy}
            onChange={(e) => update({ cardBy: e.target.value as CardGrouping })}
          >
            <option value="ad">Ad — every ad on its own card</option>
            <option value="creative">Creative — ads sharing an image or video, merged</option>
          </select>
        </Field>
        <Field label="Cards" htmlFor={`${ids}-cards`}>
          <input
            id={`${ids}-cards`}
            type="number"
            className="field w-full"
            min={CARDS.min}
            max={CARDS.max}
            value={draft.cards}
            onChange={(e) => update({ cards: Number(e.target.value) || CARDS.min })}
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
          Stats on each card ({stats.length} of at most {CARDS.statsMax})
        </legend>
        <ol className="flex flex-col gap-1">
          {stats.map((m, i) => {
            const label = metricLabel(m, "meta");
            return (
              <li key={m} className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text-secondary)" }}>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <button
                  type="button"
                  className="btn-ghost rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[12px]"
                  disabled={i === 0}
                  aria-label={`Move ${label} earlier`}
                  onClick={() => move(i, i - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-ghost rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[12px]"
                  disabled={i === stats.length - 1}
                  aria-label={`Move ${label} later`}
                  onClick={() => move(i, i + 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn-ghost rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[12px]"
                  disabled={stats.length <= 1}
                  aria-label={`Remove ${label}`}
                  onClick={() => update({ cardStats: stats.filter((x) => x !== m) })}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ol>
        <select
          className="field w-full"
          aria-label="Add a stat to each card"
          value=""
          disabled={full}
          onChange={(e) => {
            const m = e.target.value as MetricId;
            if (m) update({ cardStats: [...stats, m] });
          }}
        >
          <option value="">{full ? `${CARDS.statsMax} stats is the most a card holds` : "Add a stat…"}</option>
          <CardStatOptions by={draft.cardBy} omit={stats} />
        </select>
      </fieldset>

      <Field label="Rank cards by" htmlFor={`${ids}-card-sort`}>
        <select
          id={`${ids}-card-sort`}
          className="field w-full"
          value={draft.cardSort}
          onChange={(e) => update({ cardSort: e.target.value as MetricId })}
        >
          <CardStatOptions by={draft.cardBy} />
        </select>
        <span className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
          {lowestFirst ? "Lowest first — the cheapest at the top." : "Highest first."}
        </span>
      </Field>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
          Campaigns
        </legend>
        <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text-secondary)" }}>
          <input
            type="radio"
            name={`${ids}-campaign-scope`}
            checked={draft.campaigns.length === 0}
            onChange={() => update({ campaigns: [] })}
          />
          Every campaign
        </label>
        {listed.length === 0 ? (
          <p className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
            No Meta campaigns in the last 400 days to choose from.
          </p>
        ) : (
          <>
            {listed.length > 12 && (
              <input
                className="field w-full"
                placeholder="Find a campaign"
                aria-label="Find a campaign"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
            <div className="grid max-h-[180px] grid-cols-1 gap-y-1 overflow-y-auto">
              {visible.map((c) => {
                const on = picked.has(c.id);
                return (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 text-[12.5px]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && atCap}
                      onChange={(e) =>
                        update({
                          campaigns: e.target.checked
                            ? [...draft.campaigns, c.id]
                            : draft.campaigns.filter((id) => id !== c.id),
                        })
                      }
                    />
                    <span className="min-w-0 truncate">{c.name ?? `Campaign ${c.id}`}</span>
                  </label>
                );
              })}
            </div>
            {atCap && (
              <p className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                {CARDS.campaignsMax} campaigns is the most one widget can be narrowed to.
              </p>
            )}
          </>
        )}
      </fieldset>

      <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
        <input
          type="checkbox"
          checked={draft.cardRankings}
          onChange={(e) => update({ cardRankings: e.target.checked })}
        />
        Show Meta&apos;s delivery rankings under each card
      </label>
    </>
  );
}
