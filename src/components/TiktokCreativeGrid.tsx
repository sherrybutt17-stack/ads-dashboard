"use client";

import { useMemo, useState } from "react";
import { DASH, formatCurrency, formatNumber, formatPercent } from "@/lib/metrics/compute";
import { formatResultCount } from "@/lib/metrics/results";
import type { TiktokCreativeRow } from "@/lib/metrics/tiktok-creatives";
import { DataState, PipeNotice, type DataStateProps } from "@/components/DataState";
import { Icon } from "@/components/Icon";
import { CreativeThumb } from "@/components/CreativeThumb";
import { CategoryChart, type CategoryFormat } from "@/components/CategoryChart";

/**
 * TikTok's creative leaderboard — which VIDEOS are working, not which ad ids.
 *
 * Its own component rather than a mode of Meta's `CreativeGrid`, because the
 * signals are TikTok's own and none of Meta's carry over honestly:
 *
 *   · the attention measures are 2- and 6-second views, not Meta's 3-second
 *     "hook" and ThruPlay "hold" — printing a 2-second rate under "Hook" would
 *     compare two different things under one name;
 *   · TikTok has no delivery rankings and no learning phase in its API, so those
 *     panels are omitted rather than shown as "unknown";
 *   · Results are TikTok's own count against each ad group's goal, and the CRM
 *     receives no TikTok ad id, so no per-video revenue can be traced.
 *
 * The rules that matter are the same as Meta's: one card per asset (the same
 * video in five ad groups is one card), ratios computed from summed parts, and
 * the spend no single asset served kept visible so the cards add up.
 */

type SortKey = "spend" | "results" | "cpr" | "view2s" | "view6s";

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "spend", label: "Spend" },
  { key: "results", label: "Results" },
  { key: "cpr", label: "Cost per result" },
  { key: "view2s", label: "2-second view rate" },
  { key: "view6s", label: "6-second view rate" },
];

/** A share of impressions or plays, or null where there is nothing to divide by. */
const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const view2s = (c: TiktokCreativeRow) => rate(c.totals.video_2s, c.totals.impressions);
const view6s = (c: TiktokCreativeRow) => rate(c.totals.video_6s, c.totals.impressions);

/** The value a sort ranks by, and its direction: costs lowest first, everything else highest. */
function sortValue(c: TiktokCreativeRow, key: SortKey): number | null {
  switch (key) {
    case "spend":
      return c.totals.spend;
    case "results":
      return c.results?.count ?? null;
    case "cpr":
      return c.results?.costPer ?? null;
    case "view2s":
      return c.creativeType === "video" ? view2s(c) : null;
    case "view6s":
      return c.creativeType === "video" ? view6s(c) : null;
  }
}

/** Ranked by the chosen stat; a card with no value for it goes last; ties to spend, then key. */
export function sortTiktokCreatives(rows: readonly TiktokCreativeRow[], key: SortKey): TiktokCreativeRow[] {
  const lowestFirst = key === "cpr";
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else if (va !== vb) {
      return lowestFirst ? va - vb : vb - va;
    }
    return b.totals.spend - a.totals.spend || a.creativeKey.localeCompare(b.creativeKey);
  });
}

export function TiktokCreativeGrid({
  slug,
  creatives,
  currency,
  emptyState,
  adLevelSynced,
}: {
  /** Needed to build the picture route's URL, which is tenant-scoped. */
  slug: string;
  creatives: TiktokCreativeRow[];
  currency: string;
  emptyState?: DataStateProps | null;
  /** Whether any TikTok ad-level row exists — "not imported yet" versus "nothing ran". */
  adLevelSynced: boolean;
}) {
  const [sort, setSort] = useState<SortKey>("spend");

  // The unresolved bucket is not a creative: kept out of the leaderboard, shown last.
  const { assets, unresolved } = useMemo(
    () => ({
      assets: creatives.filter((c) => c.creativeKey !== ""),
      unresolved: creatives.find((c) => c.creativeKey === "") ?? null,
    }),
    [creatives],
  );
  const sorted = useMemo(() => sortTiktokCreatives(assets, sort), [assets, sort]);
  const totalSpend = creatives.reduce((s, c) => s + c.totals.spend, 0);
  const uncollected = assets.some((c) => c.uncollectedDays > 0);

  // Only additive measures are charted; see Meta's grid for why a rate is not.
  const chart =
    sort === "spend"
      ? { measure: "Spend", of: (c: TiktokCreativeRow) => c.totals.spend, format: { kind: "money", currency } as CategoryFormat }
      : { measure: "Results", of: (c: TiktokCreativeRow) => c.results?.count ?? 0, format: { kind: "count" } as CategoryFormat };

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--section-ink, var(--text-primary))" }}>
            Which creative is working
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            One card per video or image, not per ad — the same video running in
            several ad groups is summed here rather than split.
          </p>
        </div>
        {assets.length > 0 && (
          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Sort by
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-[var(--radius-sm)] border px-2 py-1 text-xs"
              style={{ borderColor: "var(--border)", background: "var(--surface-1)", color: "var(--text-primary)" }}
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {creatives.length === 0 ? (
        <div className="border-t px-5 pb-5" style={{ borderColor: "var(--border)" }}>
          <div className="pt-5">
            <DataState
              {...(emptyState ??
                (adLevelSynced
                  ? {
                      title: "No TikTok ads delivered in this period",
                      detail: "TikTok is reporting at ad level — nothing ran in this date range.",
                      tone: "neutral" as const,
                    }
                  : {
                      title: "No TikTok creative data yet",
                      detail:
                        "Per-video reporting starts from the first ad-level sync, which runs nightly. For past months: Connections → Import historical data → Import TikTok ad-level detail.",
                      tone: "neutral" as const,
                    }))}
              size="compact"
            />
          </div>
        </div>
      ) : (
        <>
          {emptyState && (
            <div className="px-5 pb-1">
              <PipeNotice {...emptyState} />
            </div>
          )}

          <div className="px-5 pb-3">
            <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
              <Icon name="help" size={11} className="mr-1 inline-block align-[-1px]" />
              Results and cost per result below are{" "}
              <strong style={{ color: "var(--text-secondary)" }}>TikTok&rsquo;s own count</strong>
              {" "}— its Results column, each ad group judged by its own goal — not the CRM&rsquo;s.
              GoHighLevel receives no TikTok ad id, so a video cannot be traced through the pipeline.
              {uncollected &&
                " Some days were synced before TikTok's view and engagement figures were collected; re-import TikTok ad-level detail to fill them in."}
            </p>
          </div>

          <div className="border-t px-5 pt-4" style={{ borderColor: "var(--border)" }}>
            <CategoryChart
              storageKey="tiktok-creatives"
              measure={chart.measure}
              format={chart.format}
              height={210}
              data={[
                ...sorted.map((c) => ({ key: c.creativeKey, label: c.adName || "Untitled creative", value: chart.of(c) })),
                ...(unresolved && chart.of(unresolved) > 0
                  ? [{ key: "__unresolved__", label: "Not attributed to one asset", value: chart.of(unresolved), color: "var(--text-muted)" }]
                  : []),
              ]}
              empty="No creative carried spend in this period"
            />
          </div>

          <div className="grid gap-4 border-t px-5 py-5 sm:grid-cols-2 xl:grid-cols-3" style={{ borderColor: "var(--border)" }}>
            {sorted.map((c) => (
              <TiktokCreativeCard
                key={c.creativeKey}
                creative={c}
                slug={slug}
                currency={currency}
                shareOfSpend={totalSpend > 0 ? c.totals.spend / totalSpend : null}
              />
            ))}
          </div>

          {unresolved && unresolved.totals.spend > 0 && (
            <UnresolvedRow row={unresolved} currency={currency} totalSpend={totalSpend} />
          )}
        </>
      )}
    </section>
  );
}

function TiktokCreativeCard({
  creative: c,
  currency,
  shareOfSpend,
  slug,
}: {
  creative: TiktokCreativeRow;
  currency: string;
  shareOfSpend: number | null;
  slug: string;
}) {
  const isVideo = c.creativeType === "video";
  const r = c.results;
  const t = c.totals;
  const engagement = [
    [t.likes, "like", "likes"],
    [t.comments, "comment", "comments"],
    [t.shares, "share", "shares"],
    [t.follows, "follow", "follows"],
  ] as const;

  return (
    <article
      className="flex flex-col overflow-hidden rounded-xl border"
      style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
    >
      <CreativeThumb
        // Our own route, serving the stored picture — TikTok's URLs die in hours.
        src={c.pictureRef ? `/api/c/${slug}/creative/${c.pictureRef}/thumb` : null}
        alt={c.adName ? `Creative: ${c.adName}` : "TikTok creative preview"}
        type={c.creativeType}
        videoSeconds={c.videoSeconds}
        stored={Boolean(c.pictureRef)}
        // TikTok is vertical video: kept whole on a wide card, letterboxed.
        fit="contain"
      />

      <div className="flex flex-1 flex-col gap-3 p-3.5">
        <header className="min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3
              className="min-w-0 truncate text-[13px] font-semibold"
              style={{ color: "var(--text-primary)" }}
              title={c.adName ?? c.creativeKey}
            >
              {c.adName || "Untitled creative"}
            </h3>
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              {c.creativeType}
              {isVideo && c.videoSeconds ? ` · ${Math.round(c.videoSeconds)}s` : ""}
            </span>
          </div>
          {c.adText && (
            <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug" style={{ color: "var(--text-muted)" }} title={c.adText}>
              {c.adText}
            </p>
          )}
        </header>

        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {c.adCount === 1 ? "1 ad" : `${c.adCount} ads`}
          {c.adgroupCount > 1 && ` · ${c.adgroupCount} ad groups`}
          {shareOfSpend !== null && shareOfSpend >= 0.005 && <> · {formatPercent(shareOfSpend, 0)} of spend</>}
        </p>

        <dl className="grid grid-cols-3 gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <Stat label="Spend" value={formatCurrency(t.spend, currency)} />
          <Stat
            label={r?.type.label ?? "Results"}
            value={r ? formatResultCount(r.count, r.type) : DASH}
            hint={
              r && r.otherTypes > 0
                ? "TikTok-reported. This creative also ran under other goals, counted separately."
                : "TikTok-reported."
            }
          />
          <Stat
            label="Cost / result"
            value={r?.costPer == null ? DASH : formatCurrency(r.costPer, currency)}
            hint="Spend ÷ TikTok's results of this type."
          />
        </dl>

        <dl className="grid grid-cols-3 gap-2">
          {isVideo ? (
            <>
              <Stat
                label="2s views"
                value={view2s(c) === null ? DASH : formatPercent(view2s(c)!, 1)}
                hint="2-second views ÷ impressions: did the scroll stop?"
              />
              <Stat
                label="6s views"
                value={view6s(c) === null ? DASH : formatPercent(view6s(c)!, 1)}
                hint="6-second views ÷ impressions: did it hold them?"
              />
              <Stat
                label="Completed"
                value={rate(t.video_p100, t.video_views) === null ? DASH : formatPercent(rate(t.video_p100, t.video_views)!, 1)}
                hint="Watched to the end ÷ video plays."
              />
            </>
          ) : (
            <>
              <Stat label="Impr." value={formatNumber(t.impressions, { compact: true })} />
              <Stat label="Clicks" value={formatNumber(t.clicks)} />
              <Stat label="CTR" value={rate(t.clicks, t.impressions) === null ? DASH : formatPercent(rate(t.clicks, t.impressions)!, 2)} />
            </>
          )}
        </dl>

        {engagement.some(([n]) => n > 0) && (
          <p className="tnum text-[11px]" style={{ color: "var(--text-muted)" }}>
            {engagement
              .filter(([n]) => n > 0)
              .map(([n, one, many]) => `${formatNumber(n)} ${n === 1 ? one : many}`)
              .join(" · ")}
          </p>
        )}
      </div>
    </article>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        {label}
      </dt>
      <dd className="tnum mt-0.5 text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
        {value}
      </dd>
    </div>
  );
}

/** Spend no single asset served — kept visible so the cards still add up. */
function UnresolvedRow({ row, currency, totalSpend }: { row: TiktokCreativeRow; currency: string; totalSpend: number }) {
  const share = totalSpend > 0 ? row.totals.spend / totalSpend : null;
  return (
    <div className="border-t px-5 py-4" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          Not attributable to one asset
        </h3>
        <p className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {formatCurrency(row.totals.spend, currency)}
          {share !== null && <span style={{ color: "var(--text-muted)" }}> ({formatPercent(share, 0)} of spend)</span>}
        </p>
      </div>
      <p className="mt-1 text-[11.5px] leading-snug" style={{ color: "var(--text-muted)" }}>
        {row.adName ? (
          <>
            <span style={{ color: "var(--text-secondary)" }}>{row.adName}</span>
            {row.adCount > 1 && ` and ${row.adCount - 1} other${row.adCount > 2 ? "s" : ""}`}
            {". "}
          </>
        ) : (
          `${row.adCount === 1 ? "1 ad" : `${row.adCount} ads`}. `
        )}
        {row.creativeType === "carousel"
          ? "TikTok reports a carousel's spend for the ad as a whole, never per image, so no single picture served it."
          : "TikTok could not say which video or image these ads showed, so their spend belongs to no single card."}
        {" Shown here so the totals still add up."}
      </p>
    </div>
  );
}
