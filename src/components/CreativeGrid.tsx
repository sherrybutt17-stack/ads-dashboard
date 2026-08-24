"use client";

import { useMemo, useState } from "react";
import {
  DASH,
  costPer,
  formatCurrency,
  formatNumber,
  formatPercent,
} from "@/lib/metrics/compute";
import {
  hookRate,
  holdRate,
  hookRateGrade,
  holdRateGrade,
  landRate,
  rankingIsMeaningful,
  sortCreatives,
  RANKING_MIN_IMPRESSIONS,
  type Grade,
  type CreativeSortKey,
} from "@/lib/metrics/creative";
import { LENGTH_BUCKET_LABEL, lengthBucket, thruPlayMeaning } from "@/lib/meta/creative";
import type {
  CreativeLeadReconciliation,
  RevenueAttributionCoverage,
} from "@/lib/metrics/queries";
import type { CreativeWithOutcome } from "@/lib/metrics/dashboard";
import type { DeliveryRanking } from "@/db/schema";
import { DataState, PipeNotice, type DataStateProps } from "@/components/DataState";
import { Icon, type IconName } from "@/components/Icon";

/**
 * The creative leaderboard — which ADS are working, not which ad ids.
 *
 * Three things make this different from a table of ad rows:
 *
 * 1. **Rows are assets, not ads.** One video running in eight ad sets is ONE
 *    card here, with its spend summed. Grouping by ad id instead would divide
 *    that spend eight ways and print a cost per lead eight times too low.
 * 2. **Leads are Meta's count, and the card says so.** GHL attribution carries
 *    no ad id, so the CRM ledger cannot tell us which creative produced a lead.
 *    Rather than omit cost per lead or silently swap in a different lead source
 *    under the same label, the panel names which count it is using and shows the
 *    gap against the CRM figure.
 * 3. **A creative still in learning is marked as such.** Its cost per result is
 *    not its steady-state cost, so ranking it against a mature creative — or
 *    killing it on that comparison — is the wrong call.
 */

const SORTS: Array<{ key: CreativeSortKey; label: string }> = [
  { key: "spend", label: "Spend" },
  { key: "leads", label: "Leads" },
  { key: "cpl", label: "Cost per lead" },
  { key: "hook", label: "Hook rate" },
  { key: "hold", label: "Hold rate" },
];

const TYPE_ICON: Record<CreativeWithOutcome["creativeType"], IconName> = {
  video: "play",
  image: "image",
  carousel: "layers",
  unknown: "help",
};

const GRADE_COLOR: Record<Grade, string> = {
  strong: "var(--status-good)",
  solid: "var(--seq-450)",
  weak: "var(--status-warning)",
  unknown: "var(--text-muted)",
};

/**
 * Meta's delivery rankings, in plain words.
 *
 * `unknown` never reaches here — it is filtered upstream, because "we have not
 * formed a judgement" and "average" are different facts and rendering them the
 * same turns an ad with no data yet into a mediocre performer.
 */
const RANKING_LABEL: Record<DeliveryRanking, string> = {
  above_average: "Above average",
  average: "Average",
  below_average_35: "Bottom 35%",
  below_average_20: "Bottom 20%",
  below_average_10: "Bottom 10%",
  unknown: "Not yet judged",
};

function rankingColor(r: DeliveryRanking): string {
  if (r === "above_average") return "var(--status-good)";
  if (r === "average") return "var(--text-secondary)";
  return "var(--status-warning)";
}

export function CreativeGrid({
  creatives,
  reconciliation,
  revenueCoverage,
  currency,
  emptyState,
  adLevelSynced,
}: {
  creatives: CreativeWithOutcome[];
  reconciliation: CreativeLeadReconciliation;
  /** How much closed revenue is traceable to an asset. Governs the whole block. */
  revenueCoverage: RevenueAttributionCoverage;
  currency: string;
  emptyState?: DataStateProps | null;
  /**
   * Whether ad-level data exists for this range at all.
   *
   * Distinct from "no creatives ran": ad-level sync began on a date, so an older
   * range legitimately has campaign spend and no creative rows. Conflating the
   * two would read as "no ads ran", which is false.
   */
  adLevelSynced: boolean;
}) {
  const [sort, setSort] = useState<CreativeSortKey>("spend");

  // The unresolved bucket is not a creative and must never compete in a
  // leaderboard with real assets — it is an aggregate of everything we could not
  // attribute to one. Split out, kept visible, rendered last.
  const { assets, unresolved } = useMemo(() => {
    const unresolved = creatives.find((c) => c.creativeKey === "") ?? null;
    return { assets: creatives.filter((c) => c.creativeKey !== ""), unresolved };
  }, [creatives]);

  const sorted = useMemo(() => sortCreatives(assets, sort), [assets, sort]);

  const totalSpend = creatives.reduce((s, c) => s + c.totals.spend, 0);
  const learningCount = assets.filter((c) => c.learning || c.learningLimited).length;

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Which creative is working
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            One card per asset, not per ad — the same image or video running in
            several ad sets is summed here rather than split.
          </p>
        </div>
        {assets.length > 0 && (
          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Sort by
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as CreativeSortKey)}
              className="rounded-md border px-2 py-1 text-xs"
              style={{
                borderColor: "var(--border)",
                background: "var(--surface-1)",
                color: "var(--text-primary)",
              }}
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
                      title: "No ads delivered in this period",
                      detail:
                        "The account is connected and reporting at ad level — nothing ran in this date range.",
                      tone: "neutral" as const,
                    }
                  : {
                      /*
                       * The honest distinction: ad-level reporting starts from
                       * the date it was switched on. A range before that has
                       * real campaign spend and genuinely no creative rows, and
                       * calling that "no ads ran" would be false.
                       */
                      title: "No creative data for this range",
                      detail:
                        "Per-creative reporting starts from the first ad-level sync. Campaign totals above are unaffected; pick a more recent range to see creatives.",
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

          <LeadSourceNote reconciliation={reconciliation} />
          <RevenueCoverageNote coverage={revenueCoverage} />

          {learningCount > 0 && (
            <div
              className="mx-5 mb-4 rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor: "var(--border)",
                background: "var(--surface-2)",
                color: "var(--text-secondary)",
              }}
            >
              <strong style={{ color: "var(--text-primary)" }}>
                {learningCount} {learningCount === 1 ? "creative is" : "creatives are"} still
                in learning.
              </strong>{" "}
              Meta is still finding their audience, so their cost per result is not
              their steady-state cost. Judging them against mature creatives — or
              turning them off on that comparison — is the wrong call.
            </div>
          )}

          <div
            className="grid gap-4 border-t px-5 py-5 sm:grid-cols-2 xl:grid-cols-3"
            style={{ borderColor: "var(--border)" }}
          >
            {sorted.map((c) => (
              <CreativeCard
                key={c.creativeKey}
                creative={c}
                currency={currency}
                shareOfSpend={totalSpend > 0 ? c.totals.spend / totalSpend : null}
                /*
                 * A card shows revenue only where revenue is TRACEABLE. With no
                 * attributed deals, every card would read "0 deals · $0" — which
                 * says the ads produced no customers when what is true is that
                 * we cannot tell. The block is withheld and explained once,
                 * above, instead of being printed wrongly on every card.
                 */
                showOutcome={revenueCoverage.attributedDeals > 0}
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

/**
 * States which lead count these cards divide by, before anyone compares it to
 * the headline number and concludes the dashboard contradicts itself.
 */
function LeadSourceNote({
  reconciliation,
}: {
  reconciliation: CreativeLeadReconciliation;
}) {
  const { metaReported, crmRecorded, gap } = reconciliation;
  return (
    <div className="px-5 pb-3">
      <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        <Icon name="help" size={11} className="mr-1 inline-block align-[-1px]" />
        Leads and cost per lead below are{" "}
        <strong style={{ color: "var(--text-secondary)" }}>Meta&rsquo;s own count</strong>,
        not the CRM&rsquo;s. GoHighLevel records no ad id against a lead, so a
        creative cannot be traced through the pipeline.
        {metaReported > 0 || crmRecorded > 0 ? (
          <>
            {" "}
            For this range Meta reports{" "}
            <span className="tnum">{formatNumber(metaReported)}</span> and the CRM
            recorded <span className="tnum">{formatNumber(crmRecorded)}</span>
            {gap !== 0 && (
              <>
                {" "}
                — a gap of <span className="tnum">{formatNumber(Math.abs(gap))}</span>
              </>
            )}
            . Every other lead figure on this page is the CRM&rsquo;s.
          </>
        ) : null}
      </p>
    </div>
  );
}

/**
 * Whether "which ads bring CUSTOMERS" can be answered at all, stated plainly.
 *
 * This is the section's headline, not a caveat. The join runs on
 * `contacts.meta_ad_id`, which GoHighLevel only ever receives if the ad's URL
 * parameters carry `ad_id={{ad.id}}` — it has no native field for it. Where that
 * is missing, every creative honestly reports zero closed deals, and a grid of
 * zeroes reads as "none of these ads produced a customer". That is a false claim
 * about the ads. So when nothing is traceable the numbers are withheld and the
 * one-line fix is named instead.
 */
function RevenueCoverageNote({
  coverage,
}: {
  coverage: RevenueAttributionCoverage;
}) {
  const { totalDeals, attributedDeals, recentContacts, recentContactsWithAdId } = coverage;

  // Nothing has closed in this range — there is no revenue picture to qualify,
  // and warning about attribution here would be noise.
  if (totalDeals === 0 && recentContacts === 0) return null;

  const full = totalDeals > 0 && attributedDeals === totalDeals;
  if (full) {
    return (
      <p className="px-5 pb-3 text-xs" style={{ color: "var(--text-muted)" }}>
        <Icon name="check" size={11} className="mr-1 inline-block align-[-1px]" />
        All {formatNumber(totalDeals)} closed{" "}
        {totalDeals === 1 ? "deal is" : "deals are"} traced to the creative that
        produced them.
      </p>
    );
  }

  const pipeDead = recentContacts > 0 && recentContactsWithAdId === 0;

  return (
    <div className="px-5 pb-3">
      <div
        className="rounded-lg border px-3 py-2.5 text-xs leading-relaxed"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface-2)",
          color: "var(--text-secondary)",
        }}
      >
        <p>
          <Icon
            name="alert"
            size={12}
            className="mr-1.5 inline-block align-[-2px]"
            style={{ color: "var(--status-warning)" }}
          />
          <strong style={{ color: "var(--text-primary)" }}>
            {attributedDeals === 0
              ? "Revenue cannot be traced to a creative yet."
              : `Only ${formatNumber(attributedDeals)} of ${formatNumber(totalDeals)} closed deals trace to a creative.`}
          </strong>{" "}
          {attributedDeals === 0 && totalDeals > 0 && (
            <>
              {formatNumber(totalDeals)} {totalDeals === 1 ? "deal" : "deals"} closed
              in this range and none of them can be linked to the ad that produced
              them, so per-creative revenue is withheld rather than shown as zero.{" "}
            </>
          )}
          {pipeDead ? (
            <>
              None of the {formatNumber(recentContacts)} leads in the last 30 days
              arrived with an ad id.
            </>
          ) : (
            recentContactsWithAdId > 0 && (
              <>
                {formatNumber(recentContactsWithAdId)} of{" "}
                {formatNumber(recentContacts)} leads in the last 30 days now carry
                one, so this fills in going forward.
              </>
            )
          )}
        </p>
        <p className="mt-1.5" style={{ color: "var(--text-muted)" }}>
          GoHighLevel has no native field for a Meta ad id — it only arrives if the
          ad&rsquo;s URL parameters carry{" "}
          <code
            className="rounded px-1 py-0.5"
            style={{ background: "var(--surface-1)", color: "var(--text-secondary)" }}
          >
            ad_id=&#123;&#123;ad.id&#125;&#125;
          </code>
          . Leads already in the system cannot be traced retroactively.
        </p>
      </div>
    </div>
  );
}

function CreativeCard({
  creative: c,
  currency,
  shareOfSpend,
  showOutcome,
}: {
  creative: CreativeWithOutcome;
  currency: string;
  shareOfSpend: number | null;
  showOutcome: boolean;
}) {
  const cpl = costPer(c.totals.spend, c.totals.leads);
  const hook = hookRate(c.totals);
  const hold = holdRate(c.totals);
  const land = landRate(c.totals);
  const bucket = lengthBucket(c.videoLengthSeconds);
  const isVideo = c.creativeType === "video";

  return (
    <article
      className="flex flex-col overflow-hidden rounded-xl border"
      style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
    >
      <Thumb creative={c} />

      <div className="flex flex-1 flex-col gap-3 p-3.5">
        <header className="min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3
              className="min-w-0 truncate text-[13px] font-semibold"
              style={{ color: "var(--text-primary)" }}
              title={c.title ?? c.adName ?? c.creativeKey}
            >
              {c.title || c.adName || "Untitled creative"}
            </h3>
            <span
              className="shrink-0 text-[10px] font-medium uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              {c.creativeType}
              {isVideo && c.videoLengthSeconds
                ? ` · ${Math.round(c.videoLengthSeconds)}s`
                : ""}
            </span>
          </div>
          {c.body && (
            <p
              className="mt-1 line-clamp-2 text-[11.5px] leading-snug"
              style={{ color: "var(--text-muted)" }}
              title={c.body}
            >
              {c.body}
            </p>
          )}
        </header>

        {/*
          "Running in 8 ads" is the fact that makes the grouping legible. Without
          it a reader who knows they have 8 ads and sees 3 cards assumes data is
          missing, rather than that three assets are shared across eight ads.
        */}
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {c.adCount === 1 ? "1 ad" : `${c.adCount} ads`}
          {c.adsetCount > 1 && ` · ${c.adsetCount} ad sets`}
          {shareOfSpend !== null && shareOfSpend >= 0.005 && (
            <> · {formatPercent(shareOfSpend, 0)} of spend</>
          )}
        </p>

        {(c.learning || c.learningLimited) && (
          <p
            className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug"
            style={{ background: "var(--surface-2)", color: "var(--status-warning)" }}
          >
            <Icon name="alert" size={12} className="mt-px shrink-0" />
            <span>
              {c.learningLimited ? "Learning limited" : "Still in learning"} —{" "}
              <span style={{ color: "var(--text-muted)" }}>
                {c.learningLimited
                  ? "the ad set is unlikely to exit learning at this budget or audience size; results stay volatile."
                  : "cost per result is not settled yet. Not comparable to a mature creative."}
              </span>
            </span>
          </p>
        )}

        <dl className="grid grid-cols-3 gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <Stat label="Spend" value={formatCurrency(c.totals.spend, currency)} />
          <Stat label="Leads" value={formatNumber(c.totals.leads)} hint="Meta-reported" />
          <Stat
            label="CP-Lead"
            value={cpl === null ? DASH : formatCurrency(cpl, currency)}
            hint="Meta-reported"
          />
        </dl>

        <dl className="grid grid-cols-3 gap-2">
          {isVideo ? (
            <>
              <Stat
                label="Hook"
                value={hook === null ? DASH : formatPercent(hook, 1)}
                grade={hookRateGrade(hook)}
                hint="3-second views ÷ impressions. Not autoplay starts."
              />
              <Stat
                label="Hold"
                value={hold === null ? DASH : formatPercent(hold, 1)}
                grade={holdRateGrade(hold, c.videoLengthSeconds)}
                hint={
                  bucket === "unknown"
                    ? "Video length unknown, so this cannot be graded — a ThruPlay means different things at different lengths."
                    : `${LENGTH_BUCKET_LABEL[bucket]}: ${thruPlayMeaning(bucket)}`
                }
              />
              <Stat
                label="Land"
                value={land === null ? DASH : formatPercent(land, 1)}
                hint="Clicks that actually reached the page."
              />
            </>
          ) : (
            <>
              <Stat label="Impr." value={formatNumber(c.totals.impressions, { compact: true })} />
              <Stat label="Clicks" value={formatNumber(c.totals.linkClicks)} />
              <Stat
                label="Land"
                value={land === null ? DASH : formatPercent(land, 1)}
                hint="Clicks that actually reached the page."
              />
            </>
          )}
        </dl>

        {showOutcome && <Outcome creative={c} currency={currency} />}

        <Rankings creative={c} />
      </div>
    </article>
  );
}

/**
 * What the creative produced AFTER the click — the whole point of §1e.
 *
 * *"This video produced 22 leads at $31 and 4 closed deals worth $18,400; this
 * image produced 31 leads at $19 and zero closes."* The image looks better on
 * every dashboard in the world and is the worse ad. Cost per lead cannot show
 * that; cost per customer can.
 *
 * Rendered only when at least one deal in the range was traceable — see
 * `RevenueCoverageNote`.
 */
function Outcome({
  creative: c,
  currency,
}: {
  creative: CreativeWithOutcome;
  currency: string;
}) {
  const o = c.outcome;
  const deals = o?.deals ?? 0;
  const revenue = o?.revenue ?? 0;
  // Cost per CUSTOMER, not per lead. Null rather than infinity at zero deals.
  const costPerDeal = costPer(c.totals.spend, deals);
  const roas = revenue > 0 && c.totals.spend > 0 ? revenue / c.totals.spend : null;
  const showRate = o && o.appointments > 0 ? o.showed / o.appointments : null;

  return (
    <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
      <dl className="grid grid-cols-3 gap-2">
        <Stat
          label="Deals"
          value={formatNumber(deals)}
          hint="Distinct opportunities from this creative that reached Closed/Won."
        />
        <Stat
          label="Revenue"
          value={
            /*
             * A deal with no value entered in the CRM contributes to the count
             * but not to the sum. Showing $0 next to a real closed deal would
             * read as "worth nothing" rather than "not recorded".
             */
            deals > 0 && o && o.dealsWithValue === 0
              ? DASH
              : formatCurrency(revenue, currency)
          }
          hint={
            o && deals > o.dealsWithValue
              ? `${o.dealsWithValue} of ${deals} closed deals have a value set in the CRM. Revenue is the sum of those only.`
              : "Sum of deal values on opportunities that reached Closed/Won."
          }
        />
        <Stat
          label="CP-Deal"
          value={costPerDeal === null ? DASH : formatCurrency(costPerDeal, currency)}
          hint="Spend ÷ closed deals — cost per CUSTOMER, not per lead."
        />
      </dl>

      {(roas !== null || showRate !== null || o?.medianDaysToClose != null) && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {roas !== null && (
            <span title="Revenue ÷ spend, from deals traced to this creative.">
              ROAS <strong style={{ color: "var(--text-secondary)" }}>{roas.toFixed(1)}×</strong>
            </span>
          )}
          {roas !== null && (showRate !== null || o?.medianDaysToClose != null) && " · "}
          {showRate !== null && (
            <span title="Of the appointments this creative booked, how many showed up. Some creatives bring people who book and then ghost.">
              Show rate{" "}
              <strong style={{ color: "var(--text-secondary)" }}>
                {formatPercent(showRate, 0)}
              </strong>
            </span>
          )}
          {showRate !== null && o?.medianDaysToClose != null && " · "}
          {o?.medianDaysToClose != null && (
            <span title="Median days from lead-in to close. Leads that close faster are worth more than the same revenue arriving months later.">
              Closes in{" "}
              <strong style={{ color: "var(--text-secondary)" }}>
                {Math.round(o.medianDaysToClose)}d
              </strong>
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  grade,
  hint,
}: {
  label: string;
  value: string;
  grade?: Grade;
  hint?: string;
}) {
  return (
    <div title={hint}>
      <dt
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </dt>
      <dd
        className="tnum mt-0.5 text-[13px] font-semibold"
        style={{
          color:
            grade && grade !== "unknown" ? GRADE_COLOR[grade] : "var(--text-primary)",
        }}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Meta's three delivery rankings — shown only when they mean something.
 *
 * Below ~500 impressions Meta returns UNKNOWN, and an ad with no judgement yet
 * must not be painted as an average performer. When nothing qualifies, the panel
 * says why rather than rendering an empty space that reads as "no problems".
 */
function Rankings({ creative: c }: { creative: CreativeWithOutcome }) {
  const rows: Array<[string, DeliveryRanking]> = [];
  const impressions = c.totals.impressions;
  if (rankingIsMeaningful(c.qualityRanking, impressions) && c.qualityRanking) {
    rows.push(["Quality", c.qualityRanking]);
  }
  if (rankingIsMeaningful(c.engagementRanking, impressions) && c.engagementRanking) {
    rows.push(["Engagement", c.engagementRanking]);
  }
  if (rankingIsMeaningful(c.conversionRanking, impressions) && c.conversionRanking) {
    rows.push(["Conversion", c.conversionRanking]);
  }

  if (rows.length === 0) {
    return (
      <p
        className="border-t pt-2.5 text-[11px]"
        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
      >
        {impressions < RANKING_MIN_IMPRESSIONS
          ? `Meta rankings need about ${formatNumber(RANKING_MIN_IMPRESSIONS)} impressions — this has ${formatNumber(impressions)}.`
          : "Meta has not returned a delivery ranking for this creative."}
      </p>
    );
  }

  return (
    <div
      className="flex flex-wrap gap-x-3 gap-y-1 border-t pt-2.5 text-[11px]"
      style={{ borderColor: "var(--border)" }}
    >
      {rows.map(([label, r]) => (
        <span key={label} style={{ color: "var(--text-muted)" }}>
          {label}:{" "}
          <strong style={{ color: rankingColor(r), fontWeight: 600 }}>
            {RANKING_LABEL[r]}
          </strong>
        </span>
      ))}
    </div>
  );
}

/**
 * The preview image.
 *
 * `no-referrer` because these are Facebook-hosted URLs loaded from the client's
 * browser: without it every card view tells Meta which dashboard origin is being
 * viewed. The URLs also expire, so a broken image is expected eventually and
 * falls back to a typed placeholder rather than a browser-default broken icon.
 */
function Thumb({ creative: c }: { creative: CreativeWithOutcome }) {
  const [failed, setFailed] = useState(false);
  const show = c.thumbnailUrl && !failed;

  return (
    <div
      className="relative flex aspect-[1.91/1] items-center justify-center overflow-hidden"
      style={{ background: "var(--surface-2)" }}
    >
      {show ? (
        /* Meta CDN URLs are short-lived and per-client: next/image would need a
           remotePatterns allowlist for a host that varies, and would cache an
           asset that expires out from under the cache. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={c.thumbnailUrl ?? ""}
          alt={c.title ? `Creative: ${c.title}` : "Ad creative preview"}
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          className="flex flex-col items-center gap-1.5"
          style={{ color: "var(--text-muted)" }}
        >
          <Icon name={TYPE_ICON[c.creativeType]} size={22} />
          <span className="text-[10px] uppercase tracking-wider">
            {c.thumbnailUrl ? "Preview expired" : "No preview"}
          </span>
        </div>
      )}
      {c.creativeType === "video" && show && (
        <span
          className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}
        >
          <Icon name="play" size={9} />
          {c.videoLengthSeconds ? `${Math.round(c.videoLengthSeconds)}s` : "Video"}
        </span>
      )}
    </div>
  );
}

/**
 * Spend that belongs to no single asset.
 *
 * Dynamic Creative recombines images, headlines and bodies per impression, and a
 * carousel has many cards — in both cases no one asset served that spend, so
 * inventing a card for it would attribute a whole ad set's results to whichever
 * image happened to be listed first. Kept visible and labelled so the grid's
 * spend still reconciles with the campaign table above.
 */
function UnresolvedRow({
  row,
  currency,
  totalSpend,
}: {
  row: CreativeWithOutcome;
  currency: string;
  totalSpend: number;
}) {
  const share = totalSpend > 0 ? row.totals.spend / totalSpend : null;
  const cpl = costPer(row.totals.spend, row.totals.leads);
  return (
    <div
      className="border-t px-5 py-4"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          Not attributable to one asset
        </h3>
        <p className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {formatCurrency(row.totals.spend, currency)}
          {share !== null && (
            <span style={{ color: "var(--text-muted)" }}>
              {" "}
              ({formatPercent(share, 0)} of spend)
            </span>
          )}
          {" · "}
          {formatNumber(row.totals.leads)} leads
          {" · "}
          {cpl === null ? DASH : formatCurrency(cpl, currency)} CP-Lead
        </p>
      </div>
      <p className="mt-1 text-[11.5px] leading-snug" style={{ color: "var(--text-muted)" }}>
        {row.adCount === 1 ? "1 ad" : `${row.adCount} ads`} using Dynamic Creative,
        carousels, or a creative we could not read. Meta recombines those assets per
        impression, so no single image or video served this spend — attributing it to
        one would be a guess. Shown here so the totals still add up.
      </p>
    </div>
  );
}
