import type { Client } from "@/db/schema";
import { dayLabel, eachDateKey, previousWindow, type DateWindow } from "@/lib/dates";
import { PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";
import { FUNNEL_PATH, type CanonicalStage } from "@/lib/stages";
import {
  EMPTY_FUNNEL,
  buildFunnelSteps,
  derive,
  formatCurrency,
  formatNumber,
  formatPercent,
  funnelCoherence,
  pctChange,
  type AdTotals,
  type FunnelCounts,
} from "@/lib/metrics/compute";
import { RANKING_MIN_IMPRESSIONS, orderByStat, rankingIsMeaningful } from "@/lib/metrics/creative";
import { safePreviewUrl } from "@/lib/meta/creative";
import {
  asCreativeType,
  asRanking,
  getBreakdowns,
  getCampaignBreakdown,
  getDailySeries,
  getFunnelByCampaign,
  getPeriodMetrics,
  type BreakdownSegment,
  type PaidLeadFilter,
} from "@/lib/metrics/queries";
import {
  getMetaAdCreativePairs,
  getMetaAdIdentity,
  getMetaAdLevel,
  getMetaCampaignExtras,
  getMetaCoverage,
  getPeriodReachRow,
  getPlatformResults,
  getSimpleExtras,
  type MetaAdIdentity,
  type MetaAdLevelRow,
  type MetaAdPairRow,
  type MetaExtrasRow,
  type PlatformResultsRow,
  type ResultsBy,
  type SimpleExtrasRow,
} from "@/lib/metrics/board-queries";
import {
  mergeByType,
  othersFootnote,
  resultTypeFromKey,
  resultsHeadline,
  type ResultType,
  type ResultsHeadline,
} from "@/lib/metrics/results";
import { platformCurrency } from "@/lib/metrics/currency";
import {
  DIMENSIONS,
  TOP_N,
  checkWidget,
  statSeries,
  widgetMetrics,
  type DimensionId,
  type StatId,
} from "./catalog";
import {
  EMPTY_BAG,
  adTotalsOf,
  bag,
  metricValue,
  remainder,
  sumBags,
  type Bag,
  type MetricOptions,
} from "./bag";
import { widgetQueryOf } from "./query";
import { BUILTIN, type Registry } from "./registry";
import { ensurePeriodReach } from "./reach";
import type {
  BoardData,
  BoardWidget,
  CategoryRow,
  CreativeCardData,
  TableRow,
  WidgetData,
  WidgetQuery,
} from "./types";

/**
 * Every board widget's numbers, from the dashboard's own queries.
 *
 * ── The rules this file keeps ─────────────────────────────────────────
 *
 * 1. **One source per number.** Totals, days and campaigns come from the same
 *    functions the Overview uses (`getPeriodMetrics`, `getDailySeries`,
 *    `getCampaignBreakdown`), so a board tile and an Overview tile agree.
 * 2. **Ratios from summed components** (`bag.ts`), never averaged.
 * 3. **Each query once.** Widgets share a memo: ten tiles reading the period
 *    totals cause one query, not ten.
 * 4. **At most six queries at a time**, and a failure only blanks the widgets
 *    that needed it — the Neon pool punishes a burst, and one bad widget must
 *    never take the board down.
 * 5. **Reach is never fetched while rendering a page.** It is one question to
 *    Meta per range; the widget shows as pending and asks the data API.
 */

export interface BoardConnections {
  meta: boolean;
  google: boolean;
  tiktok: boolean;
  crm: boolean;
}

export interface BoardAssets {
  logoSrc: string | null;
  brandName: string;
}

/**
 * - `page`: the board view — reach is left pending for the data API.
 * - `api`: one widget for the editor or a pending tile — reach may be fetched.
 * - `document`: a share link or PDF — cache only, never a Meta call.
 */
export type BoardMode = "page" | "api" | "document";

export interface BoardLoadInput {
  client: Client;
  window: DateWindow;
  mode: BoardMode;
  connections: BoardConnections;
  assets: BoardAssets;
  /**
   * The stats this board can name: the built-ins and its agency's own metrics
   * (`registry.ts`). The built-ins alone when absent.
   */
  registry?: Registry;
}

type Which = "cur" | "prev";

interface Row {
  key: string;
  label: string;
  sub?: string;
  bag: Bag;
  tone?: CategoryRow["tone"];
  /** The result type this row's results count, when it has any. */
  rtype?: ResultType | null;
}

/**
 * Which results a row counts: one type key for the whole widget (its main or
 * pinned type), or `"own"` — each row its own main type, the way every Ads
 * Manager row shows its own result.
 */
type ResultFocus = string | "own" | null;

interface FocusInfo {
  type: ResultType | null;
  headline: ResultsHeadline;
  total: PlatformResultsRow | null;
  /** The widget chose the type; it is not necessarily where the spend went. */
  pinned: boolean;
}

/** One row's results as bag parts, for the focus type. */
function fromResults(
  row: PlatformResultsRow | undefined,
  focus: ResultFocus,
): { parts: Partial<Bag>; type: ResultType | null } {
  if (!row || focus === null) return { parts: {}, type: null };
  const type = focus === "own" ? resultsHeadline(row.byType).type : null;
  const key = focus === "own" ? type?.key : focus;
  const e = key ? row.byType.find((t) => t.type.key === key) : undefined;
  return {
    parts: {
      resultCount: e?.count ?? 0,
      resultSpend: e?.spend ?? 0,
      resultPricedCount: e?.pricedCount ?? 0,
    },
    type: focus === "own" ? type : (e?.type ?? null),
  };
}

/** A small semaphore: at most `max` loaders in flight. */
function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function fromAds(a: AdTotals): Partial<Bag> {
  return {
    spend: a.spend,
    impressions: a.impressions,
    linkClicks: a.linkClicks,
    clicksAll: a.clicksAll,
    fbLeads: a.fbLeads,
  };
}

function fromExtras(e: MetaExtrasRow): Partial<Bag> {
  return {
    leadsOnsite: e.leadsOnsite,
    leadsPixel: e.leadsPixel,
    landingPageViews: e.landingPageViews,
    video3sViews: e.video3sViews,
    postReactions: e.postReactions,
    comments: e.comments,
    shares: e.shares,
    saves: e.saves,
    pageLikes: e.pageLikes,
    postEngagement: e.postEngagement,
    purchases: e.purchases,
    x: e.x,
  };
}

/**
 * Google's or TikTok's extra figures. TikTok's comments and shares are the
 * same quantities as Meta's, so they fill the same parts of the bag and the
 * same stats show them.
 */
function fromSimpleExtras(platform: AdPlatform, e: SimpleExtrasRow): Partial<Bag> {
  return platform === "tiktok"
    ? { x: e.x, xMissing: e.uncollected, comments: e.x.comments ?? 0, shares: e.x.shares ?? 0 }
    : { x: e.x, xMissing: e.uncollected };
}

/** One ad-level row — grouped (ad, ad set, day, total) or one (ad, creative) pair. */
function fromAdLevel(r: MetaAdLevelRow | MetaAdPairRow): Bag {
  return bag({
    spend: r.spend,
    impressions: r.impressions,
    linkClicks: r.linkClicks,
    clicksAll: r.clicksAll,
    fbLeads: r.fbLeads,
    leadsOnsite: r.leadsOnsite,
    leadsPixel: r.leadsPixel,
    landingPageViews: r.landingPageViews,
    video3sViews: r.video3sViews,
    videoPlays: r.videoPlays,
    thruPlays: r.thruPlays,
    postReactions: r.postReactions,
    comments: r.comments,
    shares: r.shares,
    saves: r.saves,
    pageLikes: r.pageLikes,
    postEngagement: r.postEngagement,
    purchases: r.purchases,
    x: r.x,
  });
}

function fromSegment(s: BreakdownSegment): Bag {
  return bag({
    spend: s.spend,
    impressions: s.impressions,
    linkClicks: s.linkClicks,
    fbLeads: s.leads,
  });
}

function funnelFrom(stages: Partial<Record<CanonicalStage, number>> | undefined): FunnelCounts {
  return { ...EMPTY_FUNNEL, ...(stages ?? {}) };
}

function needs(reg: Registry, metrics: readonly StatId[], need: "extras" | "crm" | "results"): boolean {
  return metrics.some((m) => reg.needs(m).includes(need));
}

function unavailable(
  tone: "empty" | "problem",
  title: string,
  detail?: string,
): WidgetData {
  return { kind: "unavailable", tone, title, detail };
}

class BoardLoader {
  private readonly memo = new Map<string, Promise<unknown>>();
  private readonly run = limiter(6);
  readonly tz: string;
  readonly filter: PaidLeadFilter;
  readonly prev: DateWindow;
  readonly reg: Registry;

  constructor(readonly input: BoardLoadInput) {
    this.reg = input.registry ?? BUILTIN;
    this.tz = input.client.timezone;
    this.filter = { mode: input.client.paidLeadFilter, tag: input.client.paidLeadTag };
    this.prev = previousWindow(input.window, this.tz);
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = this.run(fn);
      // Marked handled here; every caller still awaits and sees the rejection.
      p.catch(() => {});
      this.memo.set(key, p);
    }
    return p;
  }

  private win(which: Which): DateWindow {
    return which === "cur" ? this.input.window : this.prev;
  }

  get id(): string {
    return this.input.client.id;
  }

  period(platform: AdPlatform, which: Which) {
    return this.once(`period:${platform}:${which}`, () =>
      getPeriodMetrics(
        this.id,
        this.win(which),
        which === "cur" ? "Selected range" : "Previous period",
        undefined,
        this.filter,
        platform,
        true,
      ),
    );
  }

  daily(platform: AdPlatform, which: Which) {
    return this.once(`daily:${platform}:${which}`, () => {
      const w = this.win(which);
      return getDailySeries(this.id, w, this.tz, eachDateKey(w, this.tz), undefined, this.filter, platform);
    });
  }

  campaigns(platform: AdPlatform) {
    return this.once(`campaigns:${platform}`, () =>
      getCampaignBreakdown(this.id, this.input.window, platform),
    );
  }

  funnelByCampaign(platform: AdPlatform) {
    return this.once(`funnelByCampaign:${platform}`, () =>
      getFunnelByCampaign(this.id, this.input.window, this.filter, platform),
    );
  }

  extras(by: "total" | "day" | "campaign", which: Which) {
    return this.once(`extras:${by}:${which}`, () => getMetaCampaignExtras(this.id, this.win(which), by));
  }

  simpleExtras(platform: "google" | "tiktok", by: "total" | "day" | "campaign", which: Which) {
    return this.once(`simpleExtras:${platform}:${by}:${which}`, () =>
      getSimpleExtras(platform, this.id, this.win(which), by),
    );
  }

  /** Any platform's figures beyond its delivery totals, as bag parts keyed like its rows. */
  async extraParts(
    platform: AdPlatform,
    by: "total" | "day" | "campaign",
    which: Which,
  ): Promise<Map<string, Partial<Bag>>> {
    if (platform === "meta") {
      return new Map((await this.extras(by, which)).map((e) => [e.key, fromExtras(e)]));
    }
    const rows = await this.simpleExtras(platform, by, which);
    return new Map(rows.map((e) => [e.key, fromSimpleExtras(platform, e)]));
  }

  adLevel(by: "ad" | "adset" | "day" | "total", which: Which) {
    return this.once(`adLevel:${by}:${which}`, () => getMetaAdLevel(this.id, this.win(which), by));
  }

  breakdowns() {
    return this.once("breakdowns", () => getBreakdowns(this.id, this.input.window));
  }

  /** Ad-level delivery per (ad, creative) — the one source for creative splits and cards. */
  creativePairs() {
    return this.once("creativePairs", () => getMetaAdCreativePairs(this.id, this.input.window));
  }

  /**
   * What each ad looks like. Keyed once per loader: every caller passes the ads
   * of the same `creativePairs()`, so the first call's list is everyone's list.
   */
  adIdentity(adIds: readonly string[]) {
    return this.once("adIdentity", () => getMetaAdIdentity(this.id, adIds));
  }

  coverage() {
    return this.once("coverage", () => getMetaCoverage(this.id));
  }

  reach() {
    return this.once("reach", () => getPeriodReachRow(this.id, this.input.window));
  }

  currency(platform: AdPlatform) {
    return this.once(`currency:${platform}`, () => platformCurrency(this.input.client, platform));
  }

  results(platform: AdPlatform, by: ResultsBy, which: Which) {
    return this.once(`results:${platform}:${by}:${which}`, () =>
      getPlatformResults(platform, this.id, this.win(which), by),
    );
  }

  /**
   * The type a results widget counts — the one it pins, else the current
   * range's main type — resolved ONCE, so the previous period, the days and
   * the rows all count the same thing and a change compares like with like.
   */
  async resultFocus(platform: AdPlatform, pinned: string | undefined): Promise<FocusInfo> {
    const [total] = await this.results(platform, "total", "cur");
    const types = pinned ? new Map([[pinned, resultTypeFromKey(platform, pinned)]]) : undefined;
    const headline = resultsHeadline(total?.byType ?? [], { pinned: pinned ?? null, types });
    return { type: headline.type, headline, total: total ?? null, pinned: Boolean(pinned) };
  }

  /* ---------------------------------------------------------------- */

  /** The whole range (or the previous one) as one bag, campaign rows. */
  async totals(
    platform: AdPlatform,
    which: Which,
    metrics: readonly StatId[],
    focus: ResultFocus = null,
  ): Promise<Bag> {
    const p = await this.period(platform, which);
    let b = bag({ ...fromAds(p.ads), funnel: p.funnel, revenue: p.revenue });
    if (needs(this.reg, metrics, "extras")) {
      const e = (await this.extraParts(platform, "total", which)).get("");
      if (e) b = { ...b, ...e };
    }
    if (needs(this.reg, metrics, "results")) {
      const [r] = await this.results(platform, "total", which);
      b = { ...b, ...fromResults(r, focus).parts };
    }
    return b;
  }

  /** The whole range from ad rows — for stats that only exist there. */
  async adTotals(which: Which): Promise<Bag> {
    const [r] = await this.adLevel("total", which);
    return r ? fromAdLevel(r) : { ...EMPTY_BAG };
  }

  /** One bag per day of the range, in order. */
  async days(
    platform: AdPlatform,
    which: Which,
    metrics: readonly StatId[],
    adRows: boolean,
    focus: ResultFocus = null,
  ): Promise<Row[]> {
    const w = this.win(which);
    if (adRows) {
      const rows = await this.adLevel("day", which);
      const byDay = new Map(rows.map((r) => [r.key, r]));
      return eachDateKey(w, this.tz).map((k) => {
        const r = byDay.get(k);
        return { key: k, label: dayLabel(k), bag: r ? fromAdLevel(r) : { ...EMPTY_BAG } };
      });
    }
    const points = await this.daily(platform, which);
    const extras = needs(this.reg, metrics, "extras") ? await this.extraParts(platform, "day", which) : null;
    const results = needs(this.reg, metrics, "results")
      ? new Map((await this.results(platform, "day", which)).map((r) => [r.key, r]))
      : null;
    return points.map((p) => ({
      key: p.dateKey,
      label: dayLabel(p.dateKey),
      bag: bag({
        ...fromAds(p.ads),
        funnel: p.funnel,
        ...(extras?.get(p.dateKey) ?? {}),
        ...(results ? fromResults(results.get(p.dateKey), focus).parts : {}),
      }),
    }));
  }

  /** One bag per campaign, ad set, ad, creative or audience segment. */
  async split(
    platform: AdPlatform,
    dimension: DimensionId,
    metrics: readonly StatId[],
    focus: ResultFocus = null,
  ): Promise<Row[]> {
    switch (dimension) {
      case "result_type": {
        // One row per kind of result. Each row is its own type, so nothing
        // downstream may add them up (see categoryData / tableData).
        const [total] = await this.results(platform, "total", "cur");
        return (total?.byType ?? [])
          .filter((t) => t.count > 0 || t.spend > 0)
          .map((t) => ({
            key: t.type.key,
            label: t.type.label,
            rtype: t.type,
            bag: bag({ resultCount: t.count, resultSpend: t.spend, resultPricedCount: t.pricedCount }),
          }));
      }
      case "campaign": {
        const rows = await this.campaigns(platform);
        const crm = needs(this.reg, metrics, "crm") ? await this.funnelByCampaign(platform) : null;
        const extras = needs(this.reg, metrics, "extras") ? await this.extraParts(platform, "campaign", "cur") : null;
        const results = needs(this.reg, metrics, "results")
          ? new Map((await this.results(platform, "campaign", "cur")).map((r) => [r.key, r]))
          : null;
        const out: Row[] = rows.map((c) => {
          const r = results ? fromResults(results.get(c.campaignId), focus) : null;
          return {
            key: c.campaignId,
            label: c.campaignName ?? (c.campaignId === "" ? "Unattributed" : c.campaignId),
            rtype: r?.type,
            bag: bag({
              ...fromAds(c.ads),
              ...(extras?.get(c.campaignId) ?? {}),
              ...(r?.parts ?? {}),
              funnel: crm ? funnelFrom(crm.get(c.campaignId)) : null,
            }),
          };
        });
        if (crm) {
          // Leads with no campaign spend in range — Unattributed, or a campaign
          // that has since stopped. Kept so the column still sums to the total.
          const known = new Set(rows.map((r) => r.campaignId));
          for (const [key, stages] of crm) {
            if (known.has(key)) continue;
            out.push({
              key,
              label: key === "" ? "Unattributed" : `Campaign ${key}`,
              bag: bag({ funnel: funnelFrom(stages) }),
            });
          }
        }
        return out;
      }
      case "adset":
      case "ad": {
        const rows = await this.adLevel(dimension, "cur");
        const results = needs(this.reg, metrics, "results")
          ? new Map((await this.results(platform, dimension, "cur")).map((x) => [x.key, x]))
          : null;
        return rows.map((r) => {
          const res = results ? fromResults(results.get(r.key), focus) : null;
          return {
            key: r.key,
            label: r.label ?? r.key,
            sub: r.parent ?? undefined,
            rtype: res?.type,
            bag: res ? { ...fromAdLevel(r), ...res.parts } : fromAdLevel(r),
          };
        });
      }
      case "creative": {
        /*
         * From the (ad, creative) pairs, merged by asset — so every stat ad rows
         * carry works per creative, not only the handful the leaderboard sums.
         * The no-single-asset bucket stays a row of its own, so a table by
         * creative still adds up to the ad-level total.
         */
        const [pairs, results] = await Promise.all([
          this.creativePairs(),
          needs(this.reg, metrics, "results") ? this.results(platform, "creative", "cur") : Promise.resolve(null),
        ]);
        const identity = await this.adIdentity(pairs.map((p) => p.adId));
        const byKey = results ? new Map(results.map((r) => [r.key, r])) : null;
        return [...groupBy(pairs, (p) => p.creativeKey)].map(([key, list], i) => {
          const rep = biggest(list);
          const ident = identity.get(rep.adId);
          const res = byKey ? fromResults(byKey.get(key), focus) : null;
          const b = sumBags(list.map(fromAdLevel));
          return {
            key,
            label:
              key === ""
                ? "Not attributable to one asset"
                : (ident?.adName ?? rep.adName ?? ident?.title ?? `Creative ${i + 1}`),
            sub: rep.campaignName ?? undefined,
            rtype: res?.type,
            bag: res ? { ...b, ...res.parts } : b,
          };
        });
      }
      default: {
        const b = await this.breakdowns();
        const group = b.groups.find((g) => g.key === dimension);
        if (!group || group.missing) return [];
        // Meta sends genders lower-case ("female"); the key stays as sent, since
        // the fixed colours match on it, and only the label is capitalised.
        return group.segments.map((s) => ({
          key: s.value,
          label: dimension === "gender" ? s.value.charAt(0).toUpperCase() + s.value.slice(1) : s.value,
          bag: fromSegment(s),
        }));
      }
    }
  }

  /**
   * Coverage notes for a split or a stat that starts later than the range —
   * and, on Google and TikTok, for extra figures some days were synced without.
   */
  async coverageNotes(opts: {
    adRows: boolean;
    audience: boolean;
    extras?: { platform: AdPlatform; metrics: readonly StatId[] };
  }): Promise<string[]> {
    const out: string[] = [];
    const ex = opts.extras;
    if (ex && ex.platform !== "meta") {
      const keys = [...new Set(ex.metrics.flatMap((m) => this.reg.extraKeys(m)))];
      if (keys.length > 0) {
        const [total] = await this.simpleExtras(ex.platform, "total", "cur");
        if (keys.some((k) => (total?.uncollected[k] ?? 0) > 0)) {
          out.push(
            "Some days in this range were synced before these figures were collected — re-pull history on the Connections page to include them.",
          );
        }
      }
    }
    if (!opts.adRows && !opts.audience) return out;
    const c = await this.coverage();
    const start = this.input.window.startKey;
    if (opts.adRows && c.firstAdDay && start < c.firstAdDay) {
      out.push(
        `Ad-level figures start ${dayLabel(c.firstAdDay)}; earlier days are not included. Import ad-level history on the Connections page to add them.`,
      );
    }
    if (opts.audience && c.firstBreakdownDay && start < c.firstBreakdownDay) {
      out.push(
        `Audience splits start ${dayLabel(c.firstBreakdownDay)}; earlier days count as not reported.`,
      );
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Widgets
 * ------------------------------------------------------------------ */

function gate(q: WidgetQuery, c: BoardConnections, reg: Registry): WidgetData | null {
  if (q.kind === "text" || q.kind === "logo") return null;
  const verdict = checkWidget(q, reg);
  if (!verdict.ok) return unavailable("problem", "This widget cannot be shown", verdict.reason);

  const metrics = widgetMetrics(q);
  const adData = metrics.some((m) =>
    reg.needs(m).some(
      (n) => n === "ads" || n === "extras" || n === "adlevel" || n === "reach" || n === "results",
    ),
  );
  if (adData && !c[q.platform]) {
    return unavailable(
      "problem",
      `${PLATFORM_LABEL[q.platform]} ads are not connected`,
      "Connect the ad account on the Connections page to fill this widget.",
    );
  }
  if ((q.kind === "funnel" || needs(reg, metrics, "crm")) && !c.crm) {
    return unavailable(
      "problem",
      "No CRM connected",
      "Leads, appointments and sales come from GoHighLevel. Connect it to fill this widget.",
    );
  }
  return null;
}

/**
 * The line under a headline number, matching the Overview tile word for word,
 * so a figure means the same thing on both screens.
 */
function kpiFootnote(metric: StatId, b: Bag, currency: string): string | undefined {
  const f = b.funnel;
  if (!f) return undefined;
  const coherence = funnelCoherence(f);
  switch (metric) {
    case "cp_lead": {
      if (!coherence.leadsRecorded) return "not shown: more appts than leads recorded";
      const d = derive(f, adTotalsOf(b), b.revenue);
      if (d.cpLead === null && f.new_lead > 0) return "No spend recorded";
      if (d.cpLeadQualified !== null) {
        return `${formatCurrency(d.cpLeadQualified, currency)} excluding ${formatNumber(f.disqualified)} disqualified`;
      }
      return undefined;
    }
    case "appointments":
      return coherence.leadsRecorded
        ? `${formatPercent(metricValue("book_pct", b), 1)} of leads`
        : "more appts than leads recorded";
    case "showed":
      return coherence.showsRecorded
        ? `${formatPercent(metricValue("show_pct", b), 1)} of appts`
        : "attendance not recorded";
    case "won":
      return `${formatCurrency(metricValue("cp_won", b), currency)} each`;
    case "revenue": {
      const r = b.revenue;
      if (!r) return undefined;
      if (r.wonOpps > 0 && r.wonWithValue === 0) return `${formatNumber(r.wonOpps)} closed, no deal value set`;
      if (r.wonWithValue > 0 && r.wonWithValue < r.wonOpps) {
        return `${formatNumber(r.wonWithValue)} of ${formatNumber(r.wonOpps)} deals valued`;
      }
      return undefined;
    }
    case "roas": {
      const r = b.revenue;
      if (r && r.wonOpps > 0 && r.wonWithValue === 0) return "Needs deal values in GHL";
      const avg = metricValue("avg_deal", b);
      return avg !== null ? `${formatCurrency(avg, currency)} avg deal` : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * What a results widget owes its reader: which kind it is counting (on a
 * chart, where no tile label says so), days synced before results existed,
 * and spend no type's cost could include.
 */
function resultNotes(
  reg: Registry,
  f: FocusInfo | null,
  metrics: readonly StatId[],
  currency: string,
  opts: { counting?: boolean } = {},
): string[] {
  if (!f) return [];
  const out: string[] = [];
  if (opts.counting && f.type && f.type.key !== "google:conversions") {
    out.push(
      f.pinned
        ? `Counting ${f.type.label.toLowerCase()}.`
        : `Counting ${f.type.label.toLowerCase()} — the kind of result most spend went to.`,
    );
  }
  if ((f.total?.rowsWithoutResults ?? 0) > 0) {
    out.push(
      "Some days in this range were synced before results were collected — re-pull history on the Connections page to include them.",
    );
  }
  if (metrics.some((m) => reg.base(m) === "cost_per_result") && (f.total?.mixedSpend ?? 0) > 0) {
    out.push(
      `${formatCurrency(f.total!.mixedSpend, currency)} went to campaigns optimising for more than one kind of result, so it is not in the cost per result.`,
    );
  }
  return out;
}

function noResults(f: FocusInfo): WidgetData {
  const notCollected = (f.total?.rowsWithoutResults ?? 0) > 0;
  return unavailable(
    "empty",
    notCollected ? "Results not collected for these dates yet" : "No results in this range",
    notCollected ? "Re-pull history on the Connections page to fill them in." : undefined,
  );
}

/** A results tile: one type, the same type for the previous period and the days. */
async function resultsKpi(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "kpi" }>,
  currency: string,
): Promise<WidgetData> {
  const { platform, metric } = q;
  const f = await L.resultFocus(platform, q.resultType);
  if (!f.type) return noResults(f);
  const key = f.type.key;
  const [cur, prev, days] = await Promise.all([
    L.totals(platform, "cur", [metric], key),
    L.totals(platform, "prev", [metric], key),
    L.days(platform, "cur", [metric], false, key),
  ]);
  const value = L.reg.value(metric, cur);
  const previous = L.reg.value(metric, prev);
  const values = days.map((d) => L.reg.value(metric, d.bag));
  const notes = resultNotes(L.reg, f, [metric], currency);
  return {
    kind: "value",
    value,
    previous,
    change: pctChange(value, previous),
    spark: L.reg.additive(metric)
      ? values.map((v) => v ?? 0)
      : values.filter((v): v is number => v !== null),
    currency,
    // Google's results are one type, already in the title ("Conversions").
    unit: platform === "google" ? undefined : f.type.label,
    footnote: q.resultType ? undefined : (othersFootnote(f.headline.others) ?? undefined),
    notes: notes.length ? notes : undefined,
  };
}

async function kpiData(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "kpi" }>,
): Promise<WidgetData> {
  const { platform, metric } = q;
  const currency = await L.currency(platform);
  if (needs(L.reg, [metric], "results")) return resultsKpi(L, q, currency);

  // Reach, or the agency's own name for it, is one fetched figure for the range.
  const base = L.reg.base(metric);
  if (base === "reach" || base === "frequency") {
    let r = await L.reach();
    if (r === null && L.input.mode === "api") {
      const outcome = await ensurePeriodReach(L.input.client, L.input.window);
      if (outcome === "multi_account") r = "multiple";
      else if (outcome === "cached" || outcome === "fetched") {
        r = await getPeriodReachRow(L.id, L.input.window);
      } else {
        return unavailable(
          "empty",
          outcome === "timeout" ? "Meta is still counting" : "Reach is not available",
          outcome === "timeout"
            ? "Reach for this range is being fetched. Refresh in a minute."
            : "Meta did not return reach for this range.",
        );
      }
    }
    if (r === "multiple") {
      return unavailable(
        "empty",
        "Reach cannot be combined",
        "This client has more than one Meta ad account, and the same person can be reached by both.",
      );
    }
    if (r === null) {
      return L.input.mode === "page"
        ? { kind: "pending", reason: "reach" }
        : unavailable("empty", "Reach is not available for this range yet");
    }
    return {
      kind: "value",
      value: base === "reach" ? r.reach : r.frequency,
      previous: null,
      change: null,
      spark: null,
      currency,
      notes: ["Distinct people in this range, not a sum of days."],
    };
  }

  const adRows = L.reg.fromAdRows(metric, platform);
  const [cur, prev] = adRows
    ? await Promise.all([L.adTotals("cur"), L.adTotals("prev")])
    : await Promise.all([L.totals(platform, "cur", [metric]), L.totals(platform, "prev", [metric])]);

  const value = L.reg.value(metric, cur);
  const previous = L.reg.value(metric, prev);
  let spark: number[] | null = null;
  const def = L.reg.get(metric);
  if (def && statSeries(def, platform)) {
    const days = await L.days(platform, "cur", [metric], adRows);
    const values = days.map((d) => L.reg.value(metric, d.bag));
    spark = L.reg.additive(metric)
      ? values.map((v) => v ?? 0)
      : values.filter((v): v is number => v !== null);
  }
  const notes = await L.coverageNotes({ adRows, audience: false, extras: { platform, metrics: [metric] } });
  return {
    kind: "value",
    value,
    previous,
    change: pctChange(value, previous),
    spark,
    currency,
    footnote: kpiFootnote(base, cur, currency),
    notes: notes.length ? notes : undefined,
  };
}

async function seriesData(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "series" }>,
): Promise<WidgetData> {
  const { platform, metric } = q;
  const adRows = L.reg.fromAdRows(metric, platform);
  const f = needs(L.reg, [metric], "results") ? await L.resultFocus(platform, q.resultType) : null;
  if (f && !f.type) return noResults(f);
  const focus: ResultFocus = f?.type?.key ?? null;
  const [currency, cur, prev, coverage] = await Promise.all([
    L.currency(platform),
    L.days(platform, "cur", [metric], adRows, focus),
    q.compare ? L.days(platform, "prev", [metric], adRows, focus) : Promise.resolve(null),
    L.coverageNotes({ adRows, audience: false, extras: { platform, metrics: [metric] } }),
  ]);
  const notes = [...resultNotes(L.reg, f, [metric], currency, { counting: true }), ...coverage];
  return {
    kind: "series",
    points: cur.map((d, i) => ({
      key: d.key,
      label: d.label,
      value: L.reg.value(metric, d.bag),
      prev: prev ? L.reg.value(metric, prev[i]?.bag ?? EMPTY_BAG) : null,
    })),
    currency,
    prevLabel: q.compare ? "Previous period" : null,
    notes: notes.length ? notes : undefined,
  };
}

function isAudience(d: DimensionId): boolean {
  return DIMENSIONS[d].source === "breakdown";
}

function usesAdRows(d: DimensionId): boolean {
  return d === "adset" || d === "ad" || d === "creative";
}

async function campaignOptions(L: BoardLoader, platform: AdPlatform): Promise<MetricOptions> {
  const p = await L.period(platform, "cur");
  return { campaignRow: { cplTrusted: funnelCoherence(p.funnel).leadsRecorded } };
}

async function categoryData(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "category" }>,
): Promise<WidgetData> {
  const { platform, metric, dimension } = q;
  // `gate` has checked the widget against this registry, so the stat resolves.
  const def = L.reg.get(metric)!;
  const rankBy = def.rankBy ?? metric;
  const audience = isAudience(dimension);
  // By result type every bar is a different kind of thing: never a whole.
  const byType = dimension === "result_type";
  const additive = def.additive && !byType;

  const f = needs(L.reg, [metric, rankBy], "results")
    ? await L.resultFocus(platform, byType ? undefined : q.resultType)
    : null;
  if (f && !f.type && !byType) return noResults(f);
  const focus: ResultFocus = byType ? null : (f?.type?.key ?? null);

  const [currency, rows, coverage, opts] = await Promise.all([
    L.currency(platform),
    L.split(platform, dimension, [metric, rankBy], focus),
    L.coverageNotes({ adRows: usesAdRows(dimension), audience, extras: { platform, metrics: [metric, rankBy] } }),
    dimension === "campaign" ? campaignOptions(L, platform) : Promise.resolve({}),
  ]);
  const notes = [...resultNotes(L.reg, f, [metric], currency, { counting: !byType }), ...coverage];

  if (rows.length === 0) {
    return unavailable(
      "empty",
      audience ? "No audience split for this range" : "Nothing to split yet",
      audience ? "Meta has not reported this split for the selected dates." : undefined,
    );
  }

  const valued = rows.map((r) => ({
    ...r,
    value: L.reg.value(metric, r.bag, opts),
    rank: L.reg.value(rankBy, r.bag, opts) ?? -Infinity,
  }));
  // A segment with nothing in it is not a slice; a ratio with no denominator is not a bar.
  const present = valued.filter((r) => (def.additive ? (r.value ?? 0) > 0 : r.value !== null));

  const ordered = DIMENSIONS[dimension].natural
    ? present
    : [...present].sort((a, b) => b.rank - a.rank);

  const circle = q.form === "pie" || q.form === "donut";
  const cap = circle ? Math.min(q.topN, TOP_N.circleMax) : q.topN;
  const shown = ordered.slice(0, cap);
  const rest = ordered.slice(cap);

  const out: CategoryRow[] = shown.map((r) => ({ key: r.key, label: r.label, value: r.value }));
  const extraNotes = [...notes];
  if (rest.length > 0) {
    if (additive) {
      const other = L.reg.value(metric, sumBags(rest.map((r) => r.bag)));
      if (other !== null && other > 0) {
        out.push({ key: "__other__", label: `Other (${rest.length})`, value: other, tone: "other" });
      }
    } else {
      extraNotes.push(`${rest.length} more not shown.`);
    }
  }

  let whole: Bag = sumBags(rows.map((r) => r.bag));
  if (audience && L.reg.additive(metric)) {
    const totals = await L.totals(platform, "cur", [metric]);
    const missing = remainder(totals, whole);
    const notReported = L.reg.value(metric, missing);
    if (notReported !== null && notReported > 0) {
      out.push({ key: "__not_reported__", label: "Not reported by Meta", value: notReported, tone: "not_reported" });
      whole = totals;
    }
  }

  return {
    kind: "categories",
    rows: out,
    total: additive ? L.reg.value(metric, whole) : null,
    currency,
    notes: extraNotes.length ? extraNotes : undefined,
  };
}

/**
 * One row per day. A stat that only exists on ad rows (ThruPlays, hook rate)
 * reads the ad-row day; every other column reads the campaign-row day. Mixing
 * them in one bag would print zeros for the first kind and double-count the
 * second.
 */
async function dailyTableData(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "table" }>,
): Promise<WidgetData> {
  const { platform, metrics } = q;
  const wantAd = metrics.some((m) => L.reg.fromAdRows(m, platform));
  const wantCampaign = metrics.some((m) => !L.reg.fromAdRows(m, platform));
  // One kind of result per day table, so its column adds up.
  const f = needs(L.reg, metrics, "results") ? await L.resultFocus(platform, q.resultType) : null;
  const focus: ResultFocus = f?.type?.key ?? null;
  const [currency, campaignDays, adDays, coverage] = await Promise.all([
    L.currency(platform),
    wantCampaign ? L.days(platform, "cur", metrics, false, focus) : Promise.resolve(null),
    wantAd ? L.days(platform, "cur", metrics, true) : Promise.resolve(null),
    L.coverageNotes({ adRows: wantAd, audience: false, extras: { platform, metrics } }),
  ]);
  const notes = [...resultNotes(L.reg, f, metrics, currency, { counting: true }), ...coverage];
  const base = (campaignDays ?? adDays) as Row[];
  const source = (m: StatId): Row[] => ((L.reg.fromAdRows(m, platform) ? adDays : campaignDays) ?? base);

  const rows: TableRow[] = base.map((d, i) => ({
    key: d.key,
    label: d.label,
    values: metrics.map((m) => L.reg.value(m, source(m)[i]?.bag ?? EMPTY_BAG)),
  }));
  const shown = rows.slice(0, q.topN);
  return {
    kind: "table",
    columns: [...metrics],
    rows: shown,
    totals: metrics.map((m) => L.reg.value(m, sumBags(source(m).map((r) => r.bag)))),
    more: Math.max(0, rows.length - shown.length),
    currency,
    notes: notes.length ? notes : undefined,
  };
}

async function tableData(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "table" }>,
): Promise<WidgetData> {
  if (q.dimension === "date") return dailyTableData(L, q);
  const { platform, metrics, sort } = q;
  const dimension: DimensionId = q.dimension;
  const audience = isAudience(dimension);
  const wantsResults = needs(L.reg, metrics, "results");
  const byType = dimension === "result_type";
  const f = wantsResults ? await L.resultFocus(platform, q.resultType) : null;
  /*
   * A table by campaign, ad set or ad shows each row's OWN results, the way
   * every Ads Manager row does — unless the widget pins one type.
   */
  const focus: ResultFocus = !wantsResults || byType ? null : q.resultType ? (f?.type?.key ?? q.resultType) : "own";

  const [currency, splitRows, coverage, opts] = await Promise.all([
    L.currency(platform),
    L.split(platform, dimension, metrics, focus),
    L.coverageNotes({ adRows: usesAdRows(dimension), audience, extras: { platform, metrics } }),
    dimension === "campaign" ? campaignOptions(L, platform) : Promise.resolve({}),
  ]);
  const notes = [...resultNotes(L.reg, f, metrics, currency), ...coverage];
  // Name each row's kind of result under it (Google has only one kind).
  const rows: Row[] =
    focus === "own" && platform !== "google"
      ? splitRows.map((r) => ({
          ...r,
          sub: [r.sub, r.rtype && (r.bag.resultCount > 0 || r.bag.resultSpend > 0) ? r.rtype.label : null]
            .filter(Boolean)
            .join(" · ") || undefined,
        }))
      : splitRows;

  const all: Row[] = [...rows];
  if (audience && metrics.some((m) => L.reg.additive(m))) {
    const totals = await L.totals(platform, "cur", metrics);
    const missing = remainder(totals, sumBags(rows.map((r) => r.bag)));
    if (missing.spend > 0 || missing.impressions > 0 || missing.linkClicks > 0) {
      all.push({ key: "__not_reported__", label: "Not reported by Meta", bag: missing, tone: "not_reported" });
    }
  }

  if (all.length === 0) {
    return unavailable("empty", "No rows for this range");
  }

  const value = (m: StatId, b: Bag) => L.reg.value(m, b, opts);
  const sortIndex = metrics.indexOf(sort);
  const tableRows: Array<TableRow & { tone?: string }> = all.map((r) => ({
    key: r.key,
    label: r.label,
    sub: r.sub,
    values: metrics.map((m) => value(m, r.bag)),
    tone: r.tone,
  }));

  // The withheld remainder is not a row to rank — it always closes the table.
  const ordered = [
    ...tableRows
      .filter((r) => r.tone !== "not_reported")
      .sort((a, b) => (b.values[sortIndex] ?? -Infinity) - (a.values[sortIndex] ?? -Infinity)),
    ...tableRows.filter((r) => r.tone === "not_reported"),
  ];

  const shown = ordered.slice(0, q.topN);
  // Totals over every row, shown or not, re-derived from the summed components.
  const whole = sumBags(all.map((r) => r.bag));
  /*
   * Results of different kinds have no total — Ads Manager shows "—" for a
   * mixed column, and so does this.
   */
  const kinds = new Set(
    all
      .filter((r) => r.bag.resultCount > 0 || r.bag.resultSpend > 0)
      .map((r) => r.rtype?.key ?? focus ?? ""),
  );
  const mixedResults = byType || kinds.size > 1;
  return {
    kind: "table",
    columns: [...metrics],
    rows: shown.map(({ key, label, sub, values }) => ({ key, label, sub, values })),
    totals: metrics.map((m) =>
      mixedResults && L.reg.needs(m).includes("results") ? null : L.reg.value(m, whole),
    ),
    more: Math.max(0, ordered.length - shown.length),
    currency,
    notes: notes.length ? notes : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Creative cards
 * ------------------------------------------------------------------ */

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** The pair that speaks for a group: the one most money went to. */
function biggest(list: readonly MetaAdPairRow[]): MetaAdPairRow {
  return list.reduce((a, b) => (b.spend > a.spend ? b : a));
}

/** The first non-empty value, the representative ad's own first. */
function firstOf<T>(values: Array<T | null | undefined>): T | null {
  for (const v of values) if (v !== null && v !== undefined && v !== "") return v;
  return null;
}

function shareOfSpend(spend: number, total: number): string | null {
  if (total <= 0 || spend <= 0) return null;
  const share = spend / total;
  if (share < 0.005) return null;
  return share < 0.01 ? "<1% of spend" : `${Math.round(share * 100)}% of spend`;
}

const RANKING_FIELDS = [
  ["Quality", "qualityRanking"],
  ["Engagement", "engagementRanking"],
  ["Conversion", "conversionRanking"],
] as const;

/**
 * Ads (or creatives) as cards, ranked by one stat — Whatagraph's "Creatives
 * performance", built from the same ad rows as every other ad-level widget.
 *
 * Grouping by creative merges the ads that share an image or video, as the
 * Overview's leaderboard does; by ad keeps each ad on its own card, as
 * Whatagraph does. The no-single-asset bucket (Dynamic Creative, carousels)
 * has no picture to show, so by creative it is left off the cards and named in
 * a note; its spend still counts in every card's share.
 */
async function creativesData(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "creatives" }>,
): Promise<WidgetData> {
  const reads = widgetMetrics(q);
  const wantsResults = needs(L.reg, reads, "results");
  const f = wantsResults ? await L.resultFocus("meta", q.resultType) : null;
  // Each card counts its own kind of result, as each Ads Manager row does — unless one is pinned.
  const focus: ResultFocus = !wantsResults ? null : q.resultType ? (f?.type?.key ?? q.resultType) : "own";

  const [currency, pairs, coverage, results] = await Promise.all([
    L.currency("meta"),
    L.creativePairs(),
    L.coverageNotes({ adRows: true, audience: false }),
    wantsResults ? L.results("meta", "ad_creative", "cur") : Promise.resolve(null),
  ]);
  const identity = await L.adIdentity(pairs.map((p) => p.adId));
  const chosen = q.campaigns ? new Set(q.campaigns) : null;
  const scoped = chosen ? pairs.filter((p) => chosen.has(p.campaignId)) : pairs;
  const totalSpend = scoped.reduce((s, p) => s + p.spend, 0);
  const resultsByPair = results ? new Map(results.map((r) => [r.key, r])) : null;

  const groups = groupBy(scoped, (p) => (q.by === "ad" ? p.adId : p.creativeKey));
  const unresolved = q.by === "creative" ? (groups.get("") ?? []) : [];
  if (q.by === "creative") groups.delete("");

  const built = [...groups].map(([key, list]) => {
    let b = sumBags(list.map(fromAdLevel));
    let rtype: ResultType | null = null;
    if (resultsByPair) {
      const typed = mergeByType(
        list.flatMap((p) => resultsByPair.get(`${p.adId}|${p.creativeKey}`)?.byType ?? []),
      );
      const r = fromResults(
        { key, label: null, parent: null, byType: typed, spend: 0, mixedSpend: 0, rowsWithoutResults: 0 },
        focus,
      );
      b = { ...b, ...r.parts };
      rtype = r.type;
    }
    return { key, list, bag: b, rtype };
  });

  const ascending = L.reg.polarity(q.sort, "meta") === "lower-better";
  const ordered = orderByStat(
    built.filter((c) => c.bag.spend > 0 || c.bag.impressions > 0),
    (c) => L.reg.value(q.sort, c.bag),
    { ascending, spend: (c) => c.bag.spend, key: (c) => c.key },
  );
  const shown = ordered.slice(0, q.topN);

  const showsResults = q.stats.some((m) => L.reg.needs(m).includes("results"));
  const cards: CreativeCardData[] = shown.map((c) => {
    const rep = biggest(c.list);
    // The biggest ad first, then the others, for any field it leaves blank.
    const idents = [rep, ...c.list.filter((p) => p !== rep)]
      .map((p) => identity.get(p.adId))
      .filter((x): x is MetaAdIdentity => Boolean(x));
    const name =
      firstOf([idents[0]?.adName, rep.adName, ...idents.map((x) => x.adName)]) ??
      (q.by === "ad" ? `Ad ${c.key}` : "Untitled creative");
    const headline = firstOf(idents.map((x) => x.title));
    const adCount = new Set(c.list.map((p) => p.adId)).size;
    const share = shareOfSpend(c.bag.spend, totalSpend);
    const context =
      q.by === "creative"
        ? [`${adCount} ${adCount === 1 ? "ad" : "ads"}`, share].filter(Boolean).join(" · ")
        : [rep.campaignName, share].filter(Boolean).join(" · ");
    // The asset's own thumbnail; an ad with no single asset is looked up by ad.
    const thumbKey = q.by === "creative" ? c.key : rep.creativeKey || `ad.${rep.adId}`;
    const thumbRef = idents.some((x) => x.hasThumbnail) ? thumbKey : null;

    // Rankings: the most-delivered pair that has any, judged on the card's volume.
    let rankings: CreativeCardData["rankings"] = [];
    let rankingNote: string | null = null;
    if (q.rankings) {
      const source = [...c.list]
        .filter((p) => p.qualityRanking || p.engagementRanking || p.conversionRanking)
        .sort((a, b) => b.impressions - a.impressions)[0];
      if (source) {
        rankings = RANKING_FIELDS.flatMap(([label, field]) => {
          const value = asRanking(source[field]);
          return value && rankingIsMeaningful(value, c.bag.impressions) ? [{ label, value }] : [];
        });
      }
      if (rankings.length === 0) {
        rankingNote =
          c.bag.impressions < RANKING_MIN_IMPRESSIONS
            ? `Meta rankings need about ${RANKING_MIN_IMPRESSIONS} impressions — this has ${formatNumber(c.bag.impressions)}.`
            : `Meta has not returned a delivery ranking for this ${q.by}.`;
      }
    }

    const stages = idents.map((x) => x.learningStage);
    return {
      key: c.key,
      name,
      headline: headline && headline.trim() !== name.trim() ? headline : null,
      body: firstOf(idents.map((x) => x.body)),
      type: asCreativeType(firstOf([...idents.map((x) => x.creativeType), rep.creativeType])),
      videoSeconds: idents.reduce<number | null>(
        (m, x) => (x.videoLengthSeconds !== null && (m === null || x.videoLengthSeconds > m) ? x.videoLengthSeconds : m),
        null,
      ),
      thumb: thumbRef ? { ref: thumbRef } : null,
      previewUrl: firstOf(idents.map((x) => safePreviewUrl(x.previewLink))),
      values: q.stats.map((m) => L.reg.value(m, c.bag)),
      context,
      resultLabel:
        showsResults && c.rtype && (c.bag.resultCount > 0 || c.bag.resultSpend > 0) ? c.rtype.label : null,
      rankings,
      rankingNote,
      learning: stages.includes("LEARNING") ? "learning" : stages.includes("LEARNING_LIMITED") ? "limited" : null,
    };
  });

  const notes = [...resultNotes(L.reg, f, reads, currency, { counting: focus !== "own" }), ...coverage];
  if (focus === "own" && showsResults) notes.push("Each card counts its own kind of result, as Ads Manager does.");
  if (chosen) {
    const names = new Map(pairs.map((p) => [p.campaignId, p.campaignName]));
    const listed = [...chosen].map((id) => names.get(id) ?? `Campaign ${id}`);
    notes.push(`Only ads in ${listed.length === 1 ? "the campaign" : `${listed.length} campaigns`}: ${listed.join(", ")}.`);
  }
  const unresolvedSpend = unresolved.reduce((s, p) => s + p.spend, 0);
  if (unresolvedSpend > 0) {
    notes.push(
      `${formatCurrency(unresolvedSpend, currency)} went to ads with no single image or video (Dynamic Creative, carousels), so it is on no card.`,
    );
  }
  if (ascending && cards.length > 1) notes.push(`Ranked by ${L.reg.label(q.sort, "meta").toLowerCase()}, lowest first.`);

  if (cards.length === 0) {
    return unavailable(
      "empty",
      chosen ? "No ads from the chosen campaigns ran in this range" : "No ads ran in this range",
      coverage[0],
    );
  }
  return {
    kind: "creatives",
    by: q.by,
    stats: [...q.stats],
    cards,
    more: Math.max(0, ordered.length - shown.length),
    currency,
    notes: notes.length ? notes : undefined,
  };
}

async function funnelData(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "funnel" }>,
): Promise<WidgetData> {
  const p = await L.period(q.platform, "cur");
  const f = p.funnel;
  if (f.new_lead === 0 && f.appointment_booked === 0 && f.closed_won === 0) {
    return unavailable("empty", "No leads entered the pipeline in this range");
  }
  return {
    kind: "funnel",
    steps: buildFunnelSteps(f, FUNNEL_PATH),
    exits: { no_show: f.no_show, lost: f.lost },
  };
}

async function widgetData(L: BoardLoader, q: WidgetQuery): Promise<WidgetData> {
  const blocked = gate(q, L.input.connections, L.reg);
  if (blocked) return blocked;
  switch (q.kind) {
    case "kpi":
      return kpiData(L, q);
    case "series":
      return seriesData(L, q);
    case "category":
      return categoryData(L, q);
    case "table":
      return tableData(L, q);
    case "creatives":
      return creativesData(L, q);
    case "funnel":
      return funnelData(L, q);
    case "text":
      return { kind: "text" };
    case "logo":
      return { kind: "logo", src: L.input.assets.logoSrc, name: L.input.assets.brandName };
  }
}

async function safely(L: BoardLoader, q: WidgetQuery): Promise<WidgetData> {
  try {
    return await widgetData(L, q);
  } catch (err) {
    console.error("[board] widget failed:", q.kind, err);
    return unavailable("problem", "This widget could not be loaded", "Try again in a moment.");
  }
}

/** Every widget on a board, keyed by widget id. Never throws. */
export async function loadBoardData(
  input: BoardLoadInput,
  widgets: readonly BoardWidget[],
): Promise<BoardData> {
  const L = new BoardLoader(input);
  const entries = await Promise.all(
    widgets.map(async (w) => [w.id, await safely(L, widgetQueryOf(w))] as const),
  );
  return Object.fromEntries(entries);
}

/** One widget's data, for the editor and for pending tiles. Never throws. */
export async function loadWidgetData(input: BoardLoadInput, query: WidgetQuery): Promise<WidgetData> {
  return safely(new BoardLoader(input), query);
}
