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
import type { CreativeTotals } from "@/lib/metrics/creative";
import {
  getBreakdowns,
  getCampaignBreakdown,
  getCreativePerformance,
  getDailySeries,
  getFunnelByCampaign,
  getPeriodMetrics,
  type BreakdownSegment,
  type PaidLeadFilter,
} from "@/lib/metrics/queries";
import {
  getMetaAdLevel,
  getMetaCampaignExtras,
  getMetaCoverage,
  getPeriodReachRow,
  type MetaAdLevelRow,
  type MetaExtrasRow,
} from "@/lib/metrics/board-queries";
import { platformCurrency } from "@/lib/metrics/currency";
import {
  DIMENSIONS,
  METRICS,
  TOP_N,
  canBeCircle,
  checkWidget,
  metricSeries,
  widgetMetrics,
  type DimensionId,
  type MetricId,
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
import { ensurePeriodReach } from "./reach";
import type {
  BoardData,
  BoardWidget,
  CategoryRow,
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
}

type Which = "cur" | "prev";

interface Row {
  key: string;
  label: string;
  sub?: string;
  bag: Bag;
  tone?: CategoryRow["tone"];
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
    landingPageViews: e.landingPageViews,
    video3sViews: e.video3sViews,
    postReactions: e.postReactions,
    comments: e.comments,
    shares: e.shares,
    saves: e.saves,
    pageLikes: e.pageLikes,
    postEngagement: e.postEngagement,
    purchases: e.purchases,
  };
}

function fromAdLevel(r: MetaAdLevelRow): Bag {
  return bag({
    spend: r.spend,
    impressions: r.impressions,
    linkClicks: r.linkClicks,
    clicksAll: r.clicksAll,
    fbLeads: r.fbLeads,
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
  });
}

function fromCreative(t: CreativeTotals): Bag {
  return bag({
    spend: t.spend,
    impressions: t.impressions,
    linkClicks: t.linkClicks,
    fbLeads: t.leads,
    landingPageViews: t.landingPageViews,
    video3sViews: t.video3sViews,
    videoPlays: t.videoPlays,
    thruPlays: t.thruPlays,
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

function needs(metrics: readonly MetricId[], need: "extras" | "crm"): boolean {
  return metrics.some((m) => METRICS[m].needs.includes(need));
}

/** Ad-level rows are the only source of ThruPlays and plays. */
function fromAdRows(metric: MetricId): boolean {
  return metric === "thruplays" || metric === "hook_rate";
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

  constructor(readonly input: BoardLoadInput) {
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

  adLevel(by: "ad" | "adset" | "day" | "total", which: Which) {
    return this.once(`adLevel:${by}:${which}`, () => getMetaAdLevel(this.id, this.win(which), by));
  }

  breakdowns() {
    return this.once("breakdowns", () => getBreakdowns(this.id, this.input.window));
  }

  creatives() {
    return this.once("creatives", () => getCreativePerformance(this.id, this.input.window));
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

  /* ---------------------------------------------------------------- */

  /** The whole range (or the previous one) as one bag, campaign rows. */
  async totals(platform: AdPlatform, which: Which, metrics: readonly MetricId[]): Promise<Bag> {
    const p = await this.period(platform, which);
    let b = bag({ ...fromAds(p.ads), funnel: p.funnel, revenue: p.revenue });
    if (platform === "meta" && needs(metrics, "extras")) {
      const [e] = await this.extras("total", which);
      if (e) b = { ...b, ...fromExtras(e) };
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
    metrics: readonly MetricId[],
    adRows: boolean,
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
    const extras =
      platform === "meta" && needs(metrics, "extras")
        ? new Map((await this.extras("day", which)).map((e) => [e.key, e]))
        : null;
    return points.map((p) => {
      const e = extras?.get(p.dateKey);
      return {
        key: p.dateKey,
        label: dayLabel(p.dateKey),
        bag: bag({ ...fromAds(p.ads), funnel: p.funnel, ...(e ? fromExtras(e) : {}) }),
      };
    });
  }

  /** One bag per campaign, ad set, ad, creative or audience segment. */
  async split(
    platform: AdPlatform,
    dimension: DimensionId,
    metrics: readonly MetricId[],
  ): Promise<Row[]> {
    switch (dimension) {
      case "campaign": {
        const rows = await this.campaigns(platform);
        const crm = needs(metrics, "crm") ? await this.funnelByCampaign(platform) : null;
        const extras =
          platform === "meta" && needs(metrics, "extras")
            ? new Map((await this.extras("campaign", "cur")).map((e) => [e.key, e]))
            : null;
        const out: Row[] = rows.map((c) => {
          const e = extras?.get(c.campaignId);
          return {
            key: c.campaignId,
            label: c.campaignName ?? (c.campaignId === "" ? "Unattributed" : c.campaignId),
            bag: bag({
              ...fromAds(c.ads),
              ...(e ? fromExtras(e) : {}),
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
        return rows.map((r) => ({
          key: r.key,
          label: r.label ?? r.key,
          sub: r.parent ?? undefined,
          bag: fromAdLevel(r),
        }));
      }
      case "creative": {
        const rows = await this.creatives();
        return rows.map((c, i) => ({
          key: c.creativeKey,
          label: c.adName ?? c.title ?? `Creative ${i + 1}`,
          sub: c.campaignNames[0],
          bag: fromCreative(c.totals),
        }));
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

  /** Coverage notes for a split or a stat that starts later than the range. */
  async coverageNotes(opts: { adRows: boolean; audience: boolean }): Promise<string[]> {
    if (!opts.adRows && !opts.audience) return [];
    const c = await this.coverage();
    const start = this.input.window.startKey;
    const out: string[] = [];
    if (opts.adRows && c.firstAdDay && start < c.firstAdDay) {
      out.push(`Ad-level figures start ${dayLabel(c.firstAdDay)}; earlier days are not included.`);
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

function gate(q: WidgetQuery, c: BoardConnections): WidgetData | null {
  if (q.kind === "text" || q.kind === "logo") return null;
  const verdict = checkWidget(q);
  if (!verdict.ok) return unavailable("problem", "This widget cannot be shown", verdict.reason);

  const metrics = widgetMetrics(q);
  const adData = metrics.some((m) =>
    METRICS[m].needs.some((n) => n === "ads" || n === "extras" || n === "adlevel" || n === "reach"),
  );
  if (adData && !c[q.platform]) {
    return unavailable(
      "problem",
      `${PLATFORM_LABEL[q.platform]} ads are not connected`,
      "Connect the ad account on the Connections page to fill this widget.",
    );
  }
  if ((q.kind === "funnel" || needs(metrics, "crm")) && !c.crm) {
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
function kpiFootnote(metric: MetricId, b: Bag, currency: string): string | undefined {
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

async function kpiData(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "kpi" }>,
): Promise<WidgetData> {
  const { platform, metric } = q;
  const currency = await L.currency(platform);

  if (metric === "reach" || metric === "frequency") {
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
      value: metric === "reach" ? r.reach : r.frequency,
      previous: null,
      change: null,
      spark: null,
      currency,
      notes: ["Distinct people in this range, not a sum of days."],
    };
  }

  const adRows = fromAdRows(metric);
  const [cur, prev] = adRows
    ? await Promise.all([L.adTotals("cur"), L.adTotals("prev")])
    : await Promise.all([L.totals(platform, "cur", [metric]), L.totals(platform, "prev", [metric])]);

  const value = metricValue(metric, cur);
  const previous = metricValue(metric, prev);
  let spark: number[] | null = null;
  if (metricSeries(metric, platform)) {
    const days = await L.days(platform, "cur", [metric], adRows);
    const values = days.map((d) => metricValue(metric, d.bag));
    spark = METRICS[metric].additive
      ? values.map((v) => v ?? 0)
      : values.filter((v): v is number => v !== null);
  }
  const notes = await L.coverageNotes({ adRows, audience: false });
  return {
    kind: "value",
    value,
    previous,
    change: pctChange(value, previous),
    spark,
    currency,
    footnote: kpiFootnote(metric, cur, currency),
    notes: notes.length ? notes : undefined,
  };
}

async function seriesData(
  L: BoardLoader,
  q: Extract<WidgetQuery, { kind: "series" }>,
): Promise<WidgetData> {
  const { platform, metric } = q;
  const adRows = fromAdRows(metric);
  const [currency, cur, prev, notes] = await Promise.all([
    L.currency(platform),
    L.days(platform, "cur", [metric], adRows),
    q.compare ? L.days(platform, "prev", [metric], adRows) : Promise.resolve(null),
    L.coverageNotes({ adRows, audience: false }),
  ]);
  return {
    kind: "series",
    points: cur.map((d, i) => ({
      key: d.key,
      label: d.label,
      value: metricValue(metric, d.bag),
      prev: prev ? metricValue(metric, prev[i]?.bag ?? EMPTY_BAG) : null,
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
  const def = METRICS[metric];
  const rankBy = def.rankBy ?? metric;
  const audience = isAudience(dimension);

  const [currency, rows, notes, opts] = await Promise.all([
    L.currency(platform),
    L.split(platform, dimension, [metric, rankBy]),
    L.coverageNotes({ adRows: usesAdRows(dimension), audience }),
    dimension === "campaign" ? campaignOptions(L, platform) : Promise.resolve({}),
  ]);

  if (rows.length === 0) {
    return unavailable(
      "empty",
      audience ? "No audience split for this range" : "Nothing to split yet",
      audience ? "Meta has not reported this split for the selected dates." : undefined,
    );
  }

  const valued = rows.map((r) => ({
    ...r,
    value: metricValue(metric, r.bag, opts),
    rank: metricValue(rankBy, r.bag, opts) ?? -Infinity,
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
    if (def.additive) {
      const other = metricValue(metric, sumBags(rest.map((r) => r.bag)));
      if (other !== null && other > 0) {
        out.push({ key: "__other__", label: `Other (${rest.length})`, value: other, tone: "other" });
      }
    } else {
      extraNotes.push(`${rest.length} more not shown.`);
    }
  }

  let whole: Bag = sumBags(rows.map((r) => r.bag));
  if (audience && canBeCircle(metric)) {
    const totals = await L.totals(platform, "cur", [metric]);
    const missing = remainder(totals, whole);
    const notReported = metricValue(metric, missing);
    if (notReported !== null && notReported > 0) {
      out.push({ key: "__not_reported__", label: "Not reported by Meta", value: notReported, tone: "not_reported" });
      whole = totals;
    }
  }

  return {
    kind: "categories",
    rows: out,
    total: def.additive ? metricValue(metric, whole) : null,
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
  const wantAd = metrics.some(fromAdRows);
  const wantCampaign = metrics.some((m) => !fromAdRows(m));
  const [currency, campaignDays, adDays, notes] = await Promise.all([
    L.currency(platform),
    wantCampaign ? L.days(platform, "cur", metrics, false) : Promise.resolve(null),
    wantAd ? L.days(platform, "cur", metrics, true) : Promise.resolve(null),
    L.coverageNotes({ adRows: wantAd, audience: false }),
  ]);
  const base = (campaignDays ?? adDays) as Row[];
  const source = (m: MetricId): Row[] => ((fromAdRows(m) ? adDays : campaignDays) ?? base);

  const rows: TableRow[] = base.map((d, i) => ({
    key: d.key,
    label: d.label,
    values: metrics.map((m) => metricValue(m, source(m)[i]?.bag ?? EMPTY_BAG)),
  }));
  const shown = rows.slice(0, q.topN);
  return {
    kind: "table",
    columns: [...metrics],
    rows: shown,
    totals: metrics.map((m) => metricValue(m, sumBags(source(m).map((r) => r.bag)))),
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

  const [currency, rows, notes, opts] = await Promise.all([
    L.currency(platform),
    L.split(platform, dimension, metrics),
    L.coverageNotes({ adRows: usesAdRows(dimension), audience }),
    dimension === "campaign" ? campaignOptions(L, platform) : Promise.resolve({}),
  ]);

  const all: Row[] = [...rows];
  if (audience && metrics.some(canBeCircle)) {
    const totals = await L.totals(platform, "cur", metrics);
    const missing = remainder(totals, sumBags(rows.map((r) => r.bag)));
    if (missing.spend > 0 || missing.impressions > 0 || missing.linkClicks > 0) {
      all.push({ key: "__not_reported__", label: "Not reported by Meta", bag: missing, tone: "not_reported" });
    }
  }

  if (all.length === 0) {
    return unavailable("empty", "No rows for this range");
  }

  const value = (m: MetricId, b: Bag) => metricValue(m, b, opts);
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
  return {
    kind: "table",
    columns: [...metrics],
    rows: shown.map(({ key, label, sub, values }) => ({ key, label, sub, values })),
    totals: metrics.map((m) => metricValue(m, whole)),
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
  const blocked = gate(q, L.input.connections);
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
