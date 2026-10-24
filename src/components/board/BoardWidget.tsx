"use client";

import { useEffect, useState } from "react";
import { DASH } from "@/lib/metrics/compute";
import { StatTile } from "@/components/StatTile";
import { Funnel } from "@/components/Funnel";
import { DataState } from "@/components/DataState";
import { MetricInfo } from "@/components/MetricInfo";
import { defaultTitle, dimensionLabel, isMetricId, metricStatKey } from "@/lib/board/catalog";
import { formatMetricValue, statTileFormat } from "@/lib/board/format";
import { encodeWidgetQuery, widgetQueryOf } from "@/lib/board/query";
import type { BoardWidget as Widget, WidgetData } from "@/lib/board/types";
import { PLATFORM_LABEL } from "@/lib/platforms";
import { BoardCategoryChart, BoardSeriesChart, type FixedSize } from "./BoardChart";
import { BoardCreatives } from "./BoardCreatives";
import { BoardTable } from "./BoardTable";
import { useStats } from "./StatsContext";

/**
 * One widget on a board: a card that draws whatever its data says.
 *
 * Everything it receives is plain data — the widget's saved question and the
 * numbers the server computed for it — so the same component draws the board
 * page, the editor, a share link and a PDF. The one thing it ever fetches is a
 * reach figure the page left pending: reach is one question to Meta per range,
 * and asking it here keeps a slow answer from holding up the whole board.
 */
export function BoardWidget({
  widget,
  data,
  slug,
  range,
  basis,
  showPlatform,
  fixed,
}: {
  widget: Widget;
  data: WidgetData;
  slug: string;
  range: { start: string; end: string };
  /** What a change compares against, e.g. "previous 30 days". */
  basis: string;
  /** Name the platform on each widget when the board mixes platforms. */
  showPlatform: boolean;
  /**
   * The cell's exact pixel size, in a printed document — share link, print
   * view, PDF. Charts are sized from it instead of measuring, numbers do not
   * count up (a renderer can capture the page mid-count), and a table shows
   * the rows that fit.
   */
  fixed?: FixedSize;
}) {
  const reg = useStats();
  const query = widgetQueryOf(widget);
  const title = widget.title?.trim() || defaultTitle(query, reg);
  const printed = fixed !== undefined;

  // A new server render (another range, a saved edit) replaces what was fetched.
  const [seen, setSeen] = useState(data);
  const [live, setLive] = useState(data);
  if (data !== seen) {
    setSeen(data);
    setLive(data);
  }

  // Reach is asked for here rather than during the page render: one question
  // to Meta per range, and a slow answer should hold up one tile, not the board.
  const pendingUrl =
    live.kind === "pending" && live.reason === "reach"
      ? `/api/c/${encodeURIComponent(slug)}/board/data?w=${encodeWidgetQuery(query)}` +
        `&start=${range.start}&end=${range.end}`
      : null;
  useEffect(() => {
    if (!pendingUrl) return;
    let alive = true;
    fetch(pendingUrl, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { data?: WidgetData } | null) => {
        if (!alive) return;
        setLive(
          body?.data && body.data.kind !== "pending"
            ? body.data
            : { kind: "unavailable", tone: "empty", title: "Reach is not available right now" },
        );
      })
      .catch(() => {
        if (alive) {
          setLive({ kind: "unavailable", tone: "problem", title: "Reach could not be loaded" });
        }
      });
    return () => {
      alive = false;
    };
  }, [pendingUrl]);

  const platform = "platform" in query ? query.platform : null;
  const platformTag = showPlatform && platform ? PLATFORM_LABEL[platform] : null;
  const tagged = platformTag ? `${title} · ${platformTag}` : title;

  /* ---------------- headline number: the tile is the card ---------------- */
  if (query.kind === "kpi") {
    const format = reg.format(query.metric);
    // The shared maps' key for a built-in; an agency metric carries its own.
    const statKey = isMetricId(query.metric) ? metricStatKey(query.metric, query.platform) : query.metric;
    const polarity = reg.polarity(query.metric, query.platform);
    const definition = reg.definition(query.metric, query.platform);
    const base = reg.base(query.metric);
    if (live.kind === "pending") {
      // Shaped like the tile it becomes, so the row does not jump when reach lands.
      return (
        <div className="card flex h-full min-w-0 flex-col gap-1.5 p-4" aria-busy="true">
          <span
            className="flex items-center gap-1 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
            style={{ color: "var(--text-muted)" }}
          >
            {tagged}
            <MetricInfo metricKey={statKey} label={tagged} definition={definition} />
          </span>
          <div className="skeleton h-[27px] w-28 rounded-[var(--radius-xs)]" />
          {live.reason === "reach" && (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Counting distinct people for this range…
            </p>
          )}
        </div>
      );
    }
    if (live.kind !== "value") {
      // The tile's own empty state, as on the Overview: a dash, and why.
      const reason =
        live.kind === "unavailable"
          ? [live.title, live.detail].filter(Boolean).join(". ")
          : "Nothing to show yet";
      return (
        <StatTile
          className="h-full"
          compact
          comparable={false}
          label={tagged}
          value={DASH}
          numeric={null}
          metricKey={statKey}
          polarity={polarity}
          definition={definition}
          change={null}
          footnote={reason}
        />
      );
    }
    const tileFormat = statTileFormat(format);
    // A fractional count (Google's conversions) prints as text; the count-up
    // animation would round it on the way.
    const animate = Boolean(tileFormat) && !printed && (format !== "count" || Number.isInteger(live.value ?? 0));
    return (
      <StatTile
        className="h-full"
        compact
        // Reach is asked of Meta for this exact range only; it has no previous.
        comparable={base !== "reach" && base !== "frequency"}
        label={live.unit ? `${tagged} · ${live.unit}` : tagged}
        value={formatMetricValue(format, live.value, live.currency)}
        numeric={animate ? live.value : undefined}
        format={tileFormat}
        currency={live.currency}
        metricKey={statKey}
        polarity={polarity}
        definition={definition}
        change={live.change}
        spark={live.spark ?? undefined}
        footnote={[live.footnote, ...(live.notes ?? [])].filter(Boolean).join(" ") || undefined}
        basis={basis}
      />
    );
  }

  /* ---------------- funnel: the Overview's own card ---------------- */
  if (query.kind === "funnel" && live.kind === "funnel") {
    return (
      <Funnel steps={live.steps} exits={live.exits} title={tagged} className="h-full overflow-auto" />
    );
  }

  /* ---------------- text: a heading sits on the page, a note in a card ---------------- */
  if (query.kind === "text") {
    if (query.size === "heading") {
      return (
        <div className="flex h-full items-end pb-1">
          <h2
            className="min-w-0 text-[20px] leading-tight font-semibold tracking-[-0.01em] whitespace-pre-wrap"
            style={{ color: "var(--section-ink, var(--text-primary))", textWrap: "balance" }}
          >
            {query.text}
          </h2>
        </div>
      );
    }
    return (
      <div className="card h-full overflow-auto p-4">
        <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }}>
          {query.text}
        </p>
      </div>
    );
  }

  /* ---------------- logo ---------------- */
  if (live.kind === "logo") {
    return (
      <div className="card flex h-full items-center justify-center p-4">
        {live.src ? (
          // Same reason as the dashboard header: a per-tenant, access-controlled
          // route whose bytes change on upload.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={live.src} alt={live.name} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-center text-[18px] font-semibold" style={{ color: "var(--text-primary)" }}>
            {live.name}
          </span>
        )}
      </div>
    );
  }

  const info =
    query.kind === "series" || query.kind === "category"
      ? {
          key: isMetricId(query.metric) ? metricStatKey(query.metric, query.platform) : query.metric,
          label: reg.label(query.metric, query.platform),
          definition: reg.definition(query.metric, query.platform),
        }
      : null;

  // In a document: the card's padding (16px a side), its title line, and the
  // notes under the content come off the cell to leave the chart's own box.
  const notesHeight = "notes" in live && live.notes?.length ? 34 : 0;
  const chartBox: FixedSize | undefined = fixed
    ? {
        width: Math.max(80, fixed.width - 32),
        height: Math.max(60, fixed.height - 32 - 28 - notesHeight),
      }
    : undefined;

  return (
    <section
      className="card flex h-full min-h-0 flex-col p-4"
      aria-labelledby={`board-w-${widget.id}`}
    >
      <header className="mb-2 flex min-w-0 items-start justify-between gap-2">
        {/* The "i" sits beside the heading, not in it, so the section's
            accessible name is its title alone. */}
        <div className="flex min-w-0 items-center gap-1">
          <h2
            id={`board-w-${widget.id}`}
            className="min-w-0 truncate text-[12px] font-semibold tracking-[0.06em] uppercase"
            style={{ color: "var(--section-ink, var(--text-muted))" }}
          >
            {title}
          </h2>
          {info && <MetricInfo metricKey={info.key} label={info.label} definition={info.definition} />}
        </div>
        {platformTag && (
          <span
            className="shrink-0 rounded-[var(--radius-xs)] border px-1.5 py-0.5 text-[10.5px] font-medium"
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          >
            {platformTag}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {body()}
        {/* Under the content, not pinned to the card's foot: a short table
            would otherwise leave its caveat stranded a hand's width below it. */}
        {"notes" in live && live.notes && live.notes.length > 0 && (
          <p className="mt-2 shrink-0 text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
            {live.notes.join(" ")}
          </p>
        )}
      </div>
    </section>
  );

  function body() {
    if (live.kind === "pending") {
      return (
        <div className="flex flex-1 flex-col gap-2" aria-busy="true">
          <div className="skeleton min-h-0 w-full flex-1 rounded-[var(--radius-sm)]" />
          <span className="sr-only">Loading</span>
        </div>
      );
    }
    if (live.kind === "unavailable") {
      return (
        <div className="flex flex-1 flex-col justify-center">
          <DataState
            size="compact"
            tone={live.tone === "problem" ? "warning" : "neutral"}
            title={live.title}
            detail={live.detail}
          />
        </div>
      );
    }
    if (query.kind === "series" && live.kind === "series") {
      return (
        <BoardSeriesChart
          points={live.points}
          form={query.form}
          format={reg.format(query.metric)}
          currency={live.currency}
          measure={reg.label(query.metric, query.platform)}
          prevLabel={live.prevLabel}
          fixed={chartBox}
        />
      );
    }
    if (query.kind === "category" && live.kind === "categories") {
      return (
        <BoardCategoryChart
          rows={live.rows}
          form={query.form}
          format={reg.format(query.metric)}
          currency={live.currency}
          measure={reg.label(query.metric, query.platform)}
          total={live.total}
          dimension={query.dimension}
          fixed={chartBox}
        />
      );
    }
    if (query.kind === "table" && live.kind === "table") {
      return (
        <BoardTable
          columns={live.columns}
          rows={live.rows}
          totals={live.totals}
          more={live.more}
          currency={live.currency}
          platform={query.platform}
          rowHeading={dimensionLabel(query.dimension)}
          maxRows={chartBox ? tableRowsThatFit(chartBox.height, live.rows.some((r) => r.sub)) : undefined}
        />
      );
    }
    if (query.kind === "creatives" && live.kind === "creatives") {
      return <BoardCreatives data={live} slug={slug} fixed={chartBox} />;
    }
    // Data of the wrong kind for the widget: a stale cache after an edit.
    return <DataState size="compact" title="Nothing to show yet" />;
  }
}

/** Rows a printed table has room for, under its header row and above its totals. */
function tableRowsThatFit(height: number, twoLineRows: boolean): number {
  const rowHeight = twoLineRows ? 46 : 31;
  return Math.max(1, Math.floor((height - 30 - 36) / rowHeight));
}
