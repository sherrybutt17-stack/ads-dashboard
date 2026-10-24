"use client";

import { CreativeThumb } from "@/components/CreativeThumb";
import { METRICS, metricShortLabel } from "@/lib/board/catalog";
import { CARD_GAP, CARD_MIN_WIDTH, cardGrid } from "@/lib/board/cards";
import { formatMetricValue } from "@/lib/board/format";
import { formatNumber } from "@/lib/metrics/compute";
import { RANKING_LABEL, rankingColor } from "@/lib/metrics/creative";
import type { CreativeCardData, WidgetData } from "@/lib/board/types";

type CreativesData = Extract<WidgetData, { kind: "creatives" }>;

/**
 * Ads as cards — the Board's creative widget.
 *
 * On a page the cards flow three or more across and the widget scrolls, like a
 * table. In a document (`fixed`), `cardGrid` decides how many WHOLE cards fit
 * the box and how tall their pictures can be; the rest are counted, never cut.
 */
export function BoardCreatives({
  data,
  slug,
  fixed,
}: {
  data: CreativesData;
  slug: string;
  fixed?: { width: number; height: number };
}) {
  const rankings = data.cards.some((c) => c.rankings.length > 0 || c.rankingNote !== null);
  const layout = fixed
    ? cardGrid(fixed, { stats: data.stats.length, rankings, cards: data.cards.length })
    : null;
  const cards = layout ? data.cards.slice(0, layout.shown) : data.cards;
  const left = data.more + (data.cards.length - cards.length);

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${fixed ? "" : "overflow-auto"}`}>
      <ul
        className="grid"
        style={{
          gap: CARD_GAP,
          gridTemplateColumns: layout
            ? `repeat(${layout.columns}, minmax(0, 1fr))`
            : `repeat(auto-fill, minmax(min(${CARD_MIN_WIDTH}px, 100%), 1fr))`,
        }}
      >
        {cards.map((c) => (
          <li key={c.key} className="min-w-0">
            <Card
              card={c}
              data={data}
              slug={slug}
              thumbH={layout?.thumbH}
              compact={layout?.compact ?? false}
              printed={fixed !== undefined}
            />
          </li>
        ))}
      </ul>
      {left > 0 && (
        <p className="mt-2 shrink-0 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {formatNumber(left)} more {data.by === "ad" ? (left === 1 ? "ad" : "ads") : left === 1 ? "creative" : "creatives"}{" "}
          {fixed && data.cards.length > cards.length
            ? "didn't fit on the page — fewer stats per card, or fewer cards, fit more."
            : "not shown."}
        </p>
      )}
    </div>
  );
}

function Card({
  card: c,
  data,
  slug,
  thumbH,
  compact,
  printed,
}: {
  card: CreativeCardData;
  data: CreativesData;
  slug: string;
  /** Fixed thumbnail height in a document; 0 = no room for one. */
  thumbH?: number;
  /** A tight page: one line of body, no context line (`cardGrid`). */
  compact: boolean;
  printed: boolean;
}) {
  const titleId = `card-${data.by}-${c.key}`;
  const src = c.thumb
    ? "src" in c.thumb
      ? c.thumb.src
      : `/api/c/${slug}/creative/${encodeURIComponent(c.thumb.ref)}/thumb`
    : null;

  return (
    <article
      aria-labelledby={titleId}
      className="flex h-full flex-col overflow-hidden rounded-[var(--radius-sm)] border"
      style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
    >
      {thumbH !== 0 && (
        <CreativeThumb
          src={src}
          alt={c.headline ? `Ad: ${c.headline}` : `Ad: ${c.name}`}
          type={c.type}
          videoSeconds={c.videoSeconds}
          stored={c.thumb !== null}
          eager={printed}
          // A vertical video stays whole on a wide card, as Whatagraph shows it.
          fit="contain"
          height={thumbH}
          className="aspect-[1.91/1] max-h-[180px]"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
        <h3
          id={titleId}
          className="truncate text-[13.5px] font-semibold leading-5"
          style={{ color: "var(--text-primary)" }}
          title={c.name}
        >
          {c.name}
        </h3>
        {c.headline && (
          <p className="truncate text-xs font-medium leading-[18px]" style={{ color: "var(--text-secondary)" }}>
            {c.headline}
          </p>
        )}
        {c.body && (
          <p className={`${compact ? "line-clamp-1" : "line-clamp-2"} text-xs leading-4`} style={{ color: "var(--text-muted)" }}>
            {c.body}
          </p>
        )}
        {!compact && (
          <p className="truncate text-[11px] leading-4" style={{ color: "var(--text-muted)" }}>
            {[c.context, c.learning === "learning" ? "Learning" : c.learning === "limited" ? "Learning limited" : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}

        <dl className="mt-1 grid grid-cols-3 gap-x-3 gap-y-2">
          {data.stats.map((m, i) => (
            <div key={m} className="min-w-0">
              {/* Two lines, as Whatagraph prints them: "Cost per On-FB lead" cut
                  to "Cost per On-…" no longer says what it is. */}
              <dt
                className="line-clamp-2 min-h-[26px] text-[10px] font-semibold uppercase leading-[13px] tracking-[0.06em] [overflow-wrap:anywhere]"
                style={{ color: "var(--text-muted)" }}
                title={METRICS[m].label}
              >
                {metricShortLabel(m, "meta")}
              </dt>
              <dd className="tnum text-[15px] font-semibold leading-5" style={{ color: "var(--text-primary)" }}>
                {formatMetricValue(METRICS[m].format, c.values[i], data.currency)}
              </dd>
            </div>
          ))}
        </dl>
        {c.resultLabel && (
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Results: {c.resultLabel}
          </p>
        )}

        {c.rankings.length > 0 ? (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {c.rankings.map((r) => (
              <span key={r.label} style={{ color: "var(--text-muted)" }}>
                {r.label}:{" "}
                <strong style={{ color: rankingColor(r.value), fontWeight: 600 }}>{RANKING_LABEL[r.value]}</strong>
              </span>
            ))}
          </p>
        ) : (
          c.rankingNote && (
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {c.rankingNote}
            </p>
          )
        )}

        {c.previewUrl && (
          <a
            href={c.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-auto self-start text-xs font-medium underline-offset-2 hover:underline"
            style={{ color: "var(--accent)" }}
            title="Opens Facebook's preview of the ad — needs a Facebook login"
            aria-label={`View ${c.name} on Facebook (opens in a new tab)`}
          >
            View ad on Facebook ↗
          </a>
        )}
      </div>
    </article>
  );
}
