import { appSecretProof } from "@/lib/crypto";

/**
 * Meta Marketing API client.
 *
 * Version is pinned explicitly on every call. This matters more than it looks:
 * an expired Marketing API version does NOT error — Meta silently falls back to
 * the next oldest usable version, changing behaviour with no signal. Versions
 * last roughly 12 months, so this needs reviewing about twice a year.
 */

const DEFAULT_VERSION = "v25.0";

export function metaVersion(): string {
  return process.env.META_API_VERSION || DEFAULT_VERSION;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "MetaApiError";
  }

  /** Throttling responses worth backing off and retrying. */
  get isRateLimit(): boolean {
    return (
      this.code === 4 ||
      this.code === 17 ||
      this.code === 32 ||
      this.code === 613 ||
      this.code === 80000 ||
      this.code === 80004
    );
  }
}

/** Fields Meta returns as JSON strings that we want as numbers. */
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export interface MetaAdAccount {
  id: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  timezone_offset_hours_utc?: number;
  account_status?: number;
}

export interface MetaAction {
  action_type: string;
  value?: string;
  [k: string]: unknown;
}

export interface MetaInsightRow {
  date_start: string;
  date_stop: string;
  campaign_id?: string;
  campaign_name?: string;
  account_currency?: string;
  reach?: string;
  frequency?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  inline_link_clicks?: string;
  inline_link_click_ctr?: string;
  spend?: string;
  actions?: MetaAction[];
  [k: string]: unknown;
}

export class MetaClient {
  private readonly token: string;
  private readonly appSecret: string | undefined;

  constructor(token?: string) {
    const resolved = token || process.env.META_SYSTEM_USER_TOKEN;
    if (!resolved) {
      throw new Error(
        "No Meta access token. Set META_SYSTEM_USER_TOKEN, or add a per-client override.",
      );
    }
    this.token = resolved;
    this.appSecret = process.env.META_APP_SECRET;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    attempt = 0,
  ): Promise<T> {
    const url = new URL(`https://graph.facebook.com/${metaVersion()}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    url.searchParams.set("access_token", this.token);
    // Documented best practice: hardens against a leaked token being replayed.
    if (this.appSecret) {
      url.searchParams.set(
        "appsecret_proof",
        appSecretProof(this.token, this.appSecret),
      );
    }

    const res = await fetch(url, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string; code?: number; error_subcode?: number } }
      | null;

    if (!res.ok) {
      const err = new MetaApiError(
        body?.error?.message ?? `Meta ${res.status} on ${path}`,
        res.status,
        body?.error?.code,
        body?.error?.error_subcode,
        body,
      );

      /*
       * Back off on throttling. Meta explicitly warns that firing several
       * queries at once is more likely to trip rate limiting, so we retry
       * serially with exponential backoff rather than racing.
       */
      if (err.isRateLimit && attempt < 4) {
        const waitMs = Math.min(60_000, 2 ** attempt * 2_000);
        await new Promise((r) => setTimeout(r, waitMs));
        return this.request<T>(path, params, attempt + 1);
      }
      throw err;
    }

    await this.readThrottleHeaders(res);
    return body as T;
  }

  /**
   * Watch utilisation and ease off BEFORE the cap trips, not after.
   *
   * Reacting to a 429 recovers a request that already failed; the cheaper move
   * is to notice we are near the ceiling on a *successful* response and pause
   * before the next call. Because per-account calls are serialised, a pause here
   * throttles the whole run — which is exactly the intent. Meta reports these as
   * percentages of allowance (0–100).
   */
  private async readThrottleHeaders(res: Response) {
    const insights = res.headers.get("x-fb-ads-insights-throttle");
    if (!insights) return;
    try {
      const parsed = JSON.parse(insights) as {
        app_id_util_pct?: number;
        acc_id_util_pct?: number;
      };
      const worst = Math.max(
        parsed.app_id_util_pct ?? 0,
        parsed.acc_id_util_pct ?? 0,
      );
      if (worst >= 95) {
        // On the edge of the cap — spend a few seconds now rather than eat a
        // hard block (code 4/17) that stalls the account for minutes.
        console.warn(`[meta] insights throttle at ${worst}% — easing off`);
        await new Promise((r) => setTimeout(r, 5_000));
      } else if (worst >= 80) {
        console.warn(
          `[meta] insights throttle at ${worst}% — approaching the cap`,
        );
      }
    } catch {
      /* header shape drifts; never fail a request over telemetry */
    }
  }

  /** Normalise `act_123` / `123` to the `act_`-prefixed form the API needs. */
  static normalizeAccountId(id: string): string {
    const clean = id.trim().replace(/^act_/i, "");
    // Meta ad-account ids are purely numeric. Enforcing that here — the single
    // point where the id is interpolated into the request path — closes any
    // path-traversal / endpoint-redirect vector at the source.
    if (!/^\d+$/.test(clean)) {
      throw new Error(`Invalid Meta ad account id: "${id}" (must be numeric)`);
    }
    return `act_${clean}`;
  }

  /**
   * Verification call for onboarding. Returns the account's real name,
   * currency, and timezone so a wrong account id is caught immediately rather
   * than producing a silently empty dashboard.
   */
  async getAdAccount(accountId: string): Promise<MetaAdAccount> {
    const act = MetaClient.normalizeAccountId(accountId);
    return this.request<MetaAdAccount>(`/${act}`, {
      fields:
        "id,name,currency,timezone_name,timezone_offset_hours_utc,account_status",
    });
  }

  /**
   * Daily, campaign-level insights over a date range.
   *
   * `use_unified_attribution_setting=true` makes the `actions` figures respect
   * the ad set's attribution setting, which is what reproduces the numbers the
   * client sees in Ads Manager.
   */
  async getDailyInsights(
    accountId: string,
    since: string,
    until: string,
    level: "account" | "campaign" = "campaign",
  ): Promise<MetaInsightRow[]> {
    const act = MetaClient.normalizeAccountId(accountId);
    const rows: MetaInsightRow[] = [];

    let next: string | undefined;
    let page = 0;
    do {
      const res: { data?: MetaInsightRow[]; paging?: { next?: string } } = next
        ? await this.followCursor(next)
        : await this.request(`/${act}/insights`, {
            level,
            time_increment: 1,
            time_range: JSON.stringify({ since, until }),
            fields: [
              "campaign_id",
              "campaign_name",
              "account_currency",
              "reach",
              "frequency",
              "impressions",
              "clicks",
              "ctr",
              "cpc",
              "cpm",
              "inline_link_clicks",
              "inline_link_click_ctr",
              "spend",
              "actions",
            ].join(","),
            use_unified_attribution_setting: true,
            limit: 500,
          });

      rows.push(...(res.data ?? []));
      next = res.paging?.next;
    } while (next && ++page < 100);

    // Fail LOUD rather than return partial spend that reports success. A silent
    // truncation is exactly the wrong-money-looks-fine failure this app exists to
    // prevent — the caller records the sync_run as failed and the health check
    // goes red, instead of the dashboard understating spend on the tail campaigns.
    // The cap is generous (100 × 500 = 50k daily rows); a genuinely larger account
    // needs Meta's async insights job.
    if (next) {
      throw new Error(
        `Meta insights exceeded ${100 * 500} rows for ${act} ${since}..${until}; refusing to report partial data`,
      );
    }

    return rows;
  }

  /**
   * Reach for one whole period, as a single query.
   *
   * MUST NOT be replaced by summing daily reach. Reach counts distinct people
   * inside the queried window: someone who saw an ad on ten days contributes 10
   * to a naive daily sum but 1 to the true figure, overstating it 2–5x on
   * high-frequency campaigns.
   */
  async getPeriodReach(
    accountId: string,
    since: string,
    until: string,
    level: "account" | "campaign" = "campaign",
  ): Promise<Array<{ campaignId: string; reach: number; frequency: number }>> {
    const act = MetaClient.normalizeAccountId(accountId);
    const res = await this.request<{
      data?: MetaInsightRow[];
      paging?: { next?: string };
    }>(`/${act}/insights`, {
      level,
      time_range: JSON.stringify({ since, until }),
      fields: "campaign_id,reach,frequency",
      limit: 500,
    });
    // Account-level reach is a single row, so this never trips in practice. At
    // campaign level an account with >500 campaigns would truncate — and a
    // half-a-reach-table is worse than none, since the read side would treat the
    // partial as authoritative. Fail loud, exactly like getDailyInsights.
    if (res.paging?.next) {
      throw new Error(
        `Meta reach exceeded 500 rows for ${act} ${since}..${until}; refusing to report partial data`,
      );
    }
    return (res.data ?? []).map((r) => ({
      campaignId: r.campaign_id ?? "",
      reach: num(r.reach),
      frequency: num(r.frequency),
    }));
  }

  private async followCursor<T>(cursorUrl: string): Promise<T> {
    // Meta's `paging.next` URL carries the access_token but NOT the
    // appsecret_proof. If the app has "Require app secret proof" enabled, page 1
    // succeeds but every subsequent page 190-fails — silently truncating a large
    // account to its first page. Re-attach the proof on the cursor URL too.
    const url = new URL(cursorUrl);
    if (this.appSecret && !url.searchParams.has("appsecret_proof")) {
      url.searchParams.set(
        "appsecret_proof",
        appSecretProof(this.token, this.appSecret),
      );
    }
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new MetaApiError(`Meta pagination failed`, res.status);
    }
    return (await res.json()) as T;
  }
}

/**
 * Extract the metrics we store from one insights row.
 *
 * Two traps handled here:
 *
 *  1. `actions` is SPARSE — zero-activity types are absent entirely, and the
 *     whole key can be missing on a quiet day. Everything defaults to 0 and we
 *     filter by `action_type` rather than indexing positionally.
 *  2. Lead action types NEST. `lead` already contains both
 *     `onsite_conversion.lead_grouped` and `offsite_conversion.fb_pixel_lead`,
 *     so summing the three would double-count — the single most common
 *     lead-reporting bug against this API.
 */
export function parseInsightRow(row: MetaInsightRow) {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  const action = (type: string): number => {
    const hit = actions.find((a) => a.action_type === type);
    return hit ? num(hit.value) : 0;
  };

  const linkClicksAttributed = action("link_click");
  const inlineLinkClicks = num(row.inline_link_clicks);

  return {
    dateKey: row.date_start,
    campaignId: row.campaign_id ?? "",
    campaignName: row.campaign_name ?? null,
    currency: row.account_currency ?? null,

    reach: num(row.reach),
    impressions: num(row.impressions),
    clicksAll: num(row.clicks),

    /*
     * Prefer the attribution-respecting figure, which matches the Ads Manager
     * "Link clicks" column. `inline_link_clicks` is pinned to a 1-day-click
     * window and reads lower. Fall back to it only when `actions` is absent.
     */
    linkClicks: linkClicksAttributed || inlineLinkClicks,
    inlineLinkClicks,

    spend: num(row.spend),

    leadsTotal: action("lead"),
    leadsPixel: action("offsite_conversion.fb_pixel_lead"),
    leadsOnsite: action("onsite_conversion.lead_grouped"),
  };
}

export type ParsedInsight = ReturnType<typeof parseInsightRow>;
