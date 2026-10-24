/**
 * TikTok Marketing API client.
 *
 * ── 🔴 TikTok answers HTTP 200 for its own errors ─────────────────────
 *
 * The single most important difference from Meta and Google. A failed TikTok
 * call returns `200 OK` with `{"code": 40001, "message": "..."}` in the body;
 * `res.ok` is true, `res.status` is 200, and any client written to the shape of
 * the other two integrations reads that as success and parses an absent `data`
 * key into zero spend.
 *
 * Zero spend is not an error state anywhere in this product — a paused account
 * legitimately reports it — so the failure would surface as a client whose
 * TikTok dashboard reads $0 with a green health check. That is precisely the
 * silent-empty-block failure this whole application exists to replace, so
 * `code !== 0` is checked on every response before anything else happens.
 *
 * ── Auth ──────────────────────────────────────────────────────────────
 *
 * `Access-Token` header, not a bearer. Tokens are per-advertiser-authorisation
 * and do not expire, but they are invalidated when the authorising user loses
 * access — so a 40105 is a normal end-of-life event to be reported, not a
 * crash.
 */

import { TIKTOK_EXTRAS } from "@/lib/metrics/platform-extras";

const BASE = "https://business-api.tiktok.com/open_api";
const VERSION = "v1.3";

/** TikTok's documented maximum for the reporting endpoint. */
const PAGE_SIZE = 1000;

/**
 * Safety cap on the page walk — 50 pages is 50,000 campaign-days, far beyond
 * any real account over a 7-day window. It exists so a malformed `total_page`
 * cannot spin the sync forever, not as an expected limit.
 */
const MAX_PAGES = 50;

/**
 * How many advertiser ids to request per `/advertiser/info/` call.
 *
 * Defensive, not documented — see `getAdvertisers`. An agency login reaching a
 * few hundred advertisers is ordinary, and those ids are JSON-encoded into a
 * query string.
 */
const ADVERTISER_INFO_CHUNK = 50;

export class TiktokApiError extends Error {
  constructor(
    message: string,
    /** TikTok's own code. 0 is success; everything else is not. */
    readonly code: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "TiktokApiError";
  }

  /**
   * The token is dead or the user's access was revoked. Not retryable.
   *
   * 🔴 Deliberately narrow. The first version of this list also claimed 40001
   * and 40100, and 40100 appeared in `isRateLimit` too — so one code was
   * simultaneously "stop, the token is dead" and "wait and try again", and the
   * retry branch won: a permanent auth failure spent 35 seconds backing off
   * before reporting itself.
   *
   * TikTok's error codes are thinly documented, and a wrong classification is
   * worse than no classification in both directions — retrying a dead token
   * wastes a sync window, and reporting a rate limit as a revoked token sends
   * the operator to re-authorise an account that was fine. So only the codes
   * whose meaning is documented appear here; everything else is an ordinary
   * error with its message shown.
   */
  get isAuth(): boolean {
    return this.code === 40105;
  }

  /** Rate limited. Worth backing off. */
  get isRateLimit(): boolean {
    return this.code === 50002;
  }
}

export interface TiktokAdvertiser {
  advertiser_id: string;
  /**
   * Normalised by us, because TikTok calls this field two different things.
   *
   * `/oauth2/advertiser/get/` returns `advertiser_name`. `/advertiser/info/`
   * calls the identical value `name` and REJECTS `advertiser_name` outright —
   * see `getAdvertisers`. Callers get one spelling either way.
   */
  advertiser_name?: string;
  currency?: string;
  timezone?: string;
}

/** `/advertiser/info/` rows, in TikTok's own spelling, before normalising. */
interface TiktokAdvertiserInfoRow {
  advertiser_id: string | number;
  name?: string;
  currency?: string;
  timezone?: string;
}

export interface TiktokInsightRow {
  dimensions: { stat_time_day?: string; campaign_id?: string; adgroup_id?: string };
  metrics: Record<string, string | number | null>;
}

/**
 * The campaign objective, asked for alongside spend because it names what a
 * TikTok "result" is ("LEAD_GENERATION" → leads). A report attribute, like
 * `campaign_name`. Optional: refused, the request is retried without it.
 */
const OBJECTIVE_METRIC = "objective_type";

/**
 * TikTok's 40002 lists the fields it would not accept ("Invalid metric fields:
 * ['objective_type']"). Only a refusal naming one of OUR optional fields is
 * retried; anything else is a real failure.
 */
export function isOptionalMetricRefusal(err: unknown, fields: readonly string[]): boolean {
  if (!(err instanceof TiktokApiError) || err.code !== 40002) return false;
  return fields.some((f) => err.message.includes(f));
}

/** The fields a 40002 names ("Invalid metric fields: ['a', 'b']"), or [] if it names none. */
export function refusedMetrics(err: unknown): string[] {
  if (!(err instanceof TiktokApiError) || err.code !== 40002) return [];
  const list = /Invalid metric fields:\s*\[([^\]]*)\]/i.exec(err.message)?.[1] ?? "";
  return [...list.matchAll(/['"]([a-z0-9_]+)['"]/gi)].map((m) => m[1]);
}

/** One campaign-day's extra figures, by TikTok's own metric names. */
export interface TiktokExtrasRow {
  campaignId: string;
  /** "YYYY-MM-DD 00:00:00", as the report sends it. */
  statTimeDay: string;
  metrics: Record<string, number>;
}

/** One ad group's results on one day, for summing up to its campaign. */
export interface TiktokAdgroupResult {
  campaignId: string;
  /** "YYYY-MM-DD 00:00:00", as the report sends it. */
  statTimeDay: string;
  result: number;
  objective: string | null;
}

interface Envelope<T> {
  code: number;
  message: string;
  data?: T;
}

export class TiktokClient {
  constructor(private readonly token: string) {
    if (!token) throw new Error("No TikTok access token.");
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    attempt = 0,
  ): Promise<T> {
    const url = new URL(`${BASE}/${VERSION}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const res = await fetch(url, {
      headers: { "Access-Token": this.token },
      cache: "no-store",
    });

    /*
     * A transport-level failure still has to be caught — TikTok's 200-with-an
     * -error-body convention covers its own errors, not a gateway timeout.
     */
    if (!res.ok && res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
      return this.request<T>(path, params, attempt + 1);
    }

    const body = (await res.json().catch(() => null)) as Envelope<T> | null;

    if (!body) {
      throw new TiktokApiError(`TikTok returned no JSON on ${path}`, -1);
    }

    // 🔴 The check the whole file exists for. See the header.
    if (body.code !== 0) {
      const err = new TiktokApiError(
        body.message || `TikTok error ${body.code} on ${path}`,
        body.code,
        body,
      );
      if (err.isRateLimit && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 5000));
        return this.request<T>(path, params, attempt + 1);
      }
      throw err;
    }

    if (body.data === undefined) {
      throw new TiktokApiError(`TikTok returned no data on ${path}`, 0, body);
    }
    return body.data;
  }

  /**
   * Every advertiser this token can reach.
   *
   * The equivalent of Google's `ListAccessibleCustomers`, and the reason
   * self-serve connect is simpler here than for Google: no manager hierarchy to
   * expand, no `login-customer-id` to resolve per account.
   */
  async listAdvertisers(appId: string, secret: string): Promise<TiktokAdvertiser[]> {
    const data = await this.request<{ list?: TiktokAdvertiser[] }>(
      "/oauth2/advertiser/get/",
      { app_id: appId, secret },
    );
    return data.list ?? [];
  }

  /** Name, currency and timezone — the verification call for onboarding. */
  async getAdvertiser(advertiserId: string): Promise<TiktokAdvertiser | null> {
    const [found] = await this.getAdvertisers([advertiserId]);
    return found ?? null;
  }

  /**
   * Name, currency and timezone for many advertisers at once.
   *
   * 🔴 This call is not optional decoration on top of `listAdvertisers`. That
   * endpoint returns **only** `advertiser_id` and `advertiser_name` — no
   * currency and no timezone — so without this the picker would offer a list of
   * advertisers with no way to tell which currency their spend is in, and the
   * sync would have no timezone to bucket days by. Both are load-bearing:
   * TikTok buckets days in the advertiser's timezone exactly as Meta does.
   *
   * Chunked because the ids ride in a query string. TikTok does not publish a
   * documented ceiling here, so the cap is defensive rather than derived — but
   * an over-long URL fails as "no advertisers found", which reads as a broken
   * sign-in and sends the operator back through consent for no reason.
   */
  async getAdvertisers(advertiserIds: string[]): Promise<TiktokAdvertiser[]> {
    const ids = advertiserIds.map(normalizeAdvertiserId);
    const out: TiktokAdvertiser[] = [];

    for (let i = 0; i < ids.length; i += ADVERTISER_INFO_CHUNK) {
      const chunk = ids.slice(i, i + ADVERTISER_INFO_CHUNK);
      const data = await this.request<{ list?: TiktokAdvertiserInfoRow[] }>(
        "/advertiser/info/",
        {
          advertiser_ids: JSON.stringify(chunk),
          /*
           * 🔴 `name`, NOT `advertiser_name`.
           *
           * TikTok names this field differently on the two endpoints that
           * return it: `/oauth2/advertiser/get/` answers with
           * `advertiser_name`, and `/advertiser/info/` accepts only `name` and
           * refuses `advertiser_name` with a 40002 whose message lists all 30
           * legal field names. Asking for the wrong one does not degrade the
           * response — it fails the WHOLE call, for every id in the chunk.
           *
           * Which is how it presented: the picker listed every advertiser by
           * name from the first endpoint, and showed "? · ?" for currency and
           * timezone on all 26 of them, because this call had thrown and been
           * caught as "detail unavailable". A field-name typo reads on screen
           * as TikTok withholding data it was never asked for correctly.
           */
          fields: JSON.stringify([
            "advertiser_id",
            "name",
            "currency",
            "timezone",
          ]),
        },
      );
      // Normalised to the shared shape so callers never see the second spelling.
      out.push(
        ...(data.list ?? []).map((r) => ({
          advertiser_id: String(r.advertiser_id),
          advertiser_name: r.name,
          currency: r.currency,
          timezone: r.timezone,
        })),
      );
    }
    return out;
  }

  /**
   * Daily spend per campaign over a window.
   *
   * `service_type=AUCTION` and `report_type=BASIC` are the combination that
   * returns ordinary paid-campaign delivery; the alternatives cover reservation
   * buying and audience breakdowns, neither of which this dashboard reads.
   *
   * ── 🔴 Why this paginates ─────────────────────────────────────────────
   *
   * One row comes back per campaign per day, so the row count is
   * campaigns × days — a 7-day window needs only ~143 active campaigns to pass
   * a single 1000-row page. The first version of this method requested
   * `page_size: 1000` and returned `data.list` without ever reading
   * `page_info`, so beyond that point spend was silently *understated*: no
   * error, no warning, just a smaller number than Ads Manager shows.
   *
   * That is precisely the silent-under-reporting failure this whole application
   * exists to replace, and it is worse here than a hard failure would be,
   * because low spend looks plausible. `MetaClient.getAds` sets the standard —
   * it walks the cursor and then THROWS rather than return a partial set. This
   * does the same: every page is fetched, and if the report is somehow still
   * incomplete after the safety cap, it refuses to report a partial total
   * rather than quietly halving someone's spend.
   */
  async getDailyInsights(
    advertiserId: string,
    startKey: string,
    endKey: string,
  ): Promise<TiktokInsightRow[]> {
    try {
      return await this.dailyInsights(advertiserId, startKey, endKey, true);
    } catch (err) {
      if (!isOptionalMetricRefusal(err, [OBJECTIVE_METRIC])) throw err;
      console.warn("[tiktok] report refused objective_type; retrying without it:", (err as Error).message);
      return this.dailyInsights(advertiserId, startKey, endKey, false);
    }
  }

  private async dailyInsights(
    advertiserId: string,
    startKey: string,
    endKey: string,
    withObjective: boolean,
  ): Promise<TiktokInsightRow[]> {
    const advertiser = normalizeAdvertiserId(advertiserId);
    const rows: TiktokInsightRow[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const data = await this.request<{
        list?: TiktokInsightRow[];
        page_info?: { total_page?: number; total_number?: number };
      }>("/report/integrated/get/", {
        advertiser_id: advertiser,
        report_type: "BASIC",
        service_type: "AUCTION",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify([
          "campaign_name",
          "spend",
          "impressions",
          "clicks",
          "conversion",
          ...(withObjective ? [OBJECTIVE_METRIC] : []),
        ]),
        start_date: startKey,
        end_date: endKey,
        page,
        page_size: PAGE_SIZE,
      });

      rows.push(...(data.list ?? []));

      /*
       * Trust `total_page` only when TikTok sends it. An absent or zero value
       * means "this is all there is" — treating it as unknown-and-keep-going
       * would loop on an empty account until the cap.
       */
      totalPages = Number(data.page_info?.total_page) || 1;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    if (totalPages > MAX_PAGES) {
      throw new TiktokApiError(
        `TikTok report for ${advertiser} spans ${totalPages} pages (cap ${MAX_PAGES}); ` +
          `refusing to report partial spend`,
        -1,
      );
    }
    return rows;
  }

  /**
   * Each ad group's "Results" per day, with its campaign.
   *
   * ── 🔴 Why ad groups, not campaigns ──────────────────────────────────
   *
   * TikTok computes a result against the ad group's optimisation goal, and its
   * report returns `result: 0` at campaign level — verified 24 Oct 2026 on a
   * lead campaign with 91 form leads: 0 at campaign level, 91 at ad group
   * level. Summed per campaign-day by the sync, this is the number TikTok Ads
   * Manager shows as Results.
   *
   * Best-effort by design: the sync catches any failure here, and spend — which
   * comes from `getDailyInsights` — never depends on it. Paginated with the same
   * refuse-to-truncate rule, because a partial set would understate results.
   */
  async getAdgroupResults(
    advertiserId: string,
    startKey: string,
    endKey: string,
  ): Promise<TiktokAdgroupResult[]> {
    const advertiser = normalizeAdvertiserId(advertiserId);
    const out: TiktokAdgroupResult[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const data = await this.request<{
        list?: TiktokInsightRow[];
        page_info?: { total_page?: number };
      }>("/report/integrated/get/", {
        advertiser_id: advertiser,
        report_type: "BASIC",
        service_type: "AUCTION",
        data_level: "AUCTION_ADGROUP",
        dimensions: JSON.stringify(["adgroup_id", "stat_time_day"]),
        metrics: JSON.stringify(["campaign_id", "result", OBJECTIVE_METRIC]),
        start_date: startKey,
        end_date: endKey,
        page,
        page_size: PAGE_SIZE,
      });

      for (const row of data.list ?? []) {
        const campaignId = row.metrics.campaign_id;
        const day = row.dimensions.stat_time_day;
        if (campaignId === null || campaignId === undefined || !day) continue;
        const result = Number(row.metrics.result);
        const objective = row.metrics[OBJECTIVE_METRIC];
        out.push({
          campaignId: String(campaignId),
          statTimeDay: day,
          result: Number.isFinite(result) ? result : 0,
          objective: typeof objective === "string" && objective ? objective : null,
        });
      }
      totalPages = Number(data.page_info?.total_page) || 1;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    if (totalPages > MAX_PAGES) {
      throw new TiktokApiError(
        `TikTok ad group report for ${advertiser} spans ${totalPages} pages (cap ${MAX_PAGES}); ` +
          `refusing to report partial results`,
        -1,
      );
    }
    return out;
  }

  /**
   * Engagement and video figures per campaign-day — likes, comments, shares,
   * follows, profile visits, plays and quartiles (`TIKTOK_EXTRAS`).
   *
   * Best-effort, like the results report: the sync catches any failure and
   * spend never depends on it. A 40002 naming some of the fields is retried
   * without them (twice at most), and `fields` says which came back, so a
   * refused field is stored as missing rather than as zero.
   */
  async getDailyExtras(
    advertiserId: string,
    startKey: string,
    endKey: string,
  ): Promise<{ rows: TiktokExtrasRow[]; fields: string[] }> {
    let fields: string[] = Object.values(TIKTOK_EXTRAS);
    for (let attempt = 0; ; attempt++) {
      try {
        return { rows: await this.extrasReport(advertiserId, startKey, endKey, fields), fields };
      } catch (err) {
        const refused = refusedMetrics(err);
        const left = fields.filter((f) => !refused.includes(f));
        if (attempt >= 2 || refused.length === 0 || left.length === fields.length || left.length === 0) {
          throw err;
        }
        console.warn("[tiktok] extras report refused", refused.join(", "), "; retrying without them");
        fields = left;
      }
    }
  }

  private async extrasReport(
    advertiserId: string,
    startKey: string,
    endKey: string,
    fields: readonly string[],
  ): Promise<TiktokExtrasRow[]> {
    const advertiser = normalizeAdvertiserId(advertiserId);
    const out: TiktokExtrasRow[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const data = await this.request<{
        list?: TiktokInsightRow[];
        page_info?: { total_page?: number };
      }>("/report/integrated/get/", {
        advertiser_id: advertiser,
        report_type: "BASIC",
        service_type: "AUCTION",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify(fields),
        start_date: startKey,
        end_date: endKey,
        page,
        page_size: PAGE_SIZE,
      });

      for (const row of data.list ?? []) {
        const campaignId = row.dimensions.campaign_id;
        const day = row.dimensions.stat_time_day;
        if (!campaignId || !day) continue;
        const metrics: Record<string, number> = {};
        for (const f of fields) {
          const v = Number(row.metrics[f]);
          metrics[f] = Number.isFinite(v) ? v : 0;
        }
        out.push({ campaignId: String(campaignId), statTimeDay: day, metrics });
      }
      totalPages = Number(data.page_info?.total_page) || 1;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    if (totalPages > MAX_PAGES) {
      throw new TiktokApiError(
        `TikTok extras report for ${advertiser} spans ${totalPages} pages (cap ${MAX_PAGES}); ` +
          `refusing to report partial figures`,
        -1,
      );
    }
    return out;
  }
}

/**
 * Advertiser ids are numeric and are interpolated into a request.
 *
 * The same guard `MetaClient.normalizeAccountId` applies, for the same reason:
 * this is the single point where a stored id reaches an outbound URL.
 */
export function normalizeAdvertiserId(id: string): string {
  const clean = id.trim();
  if (!/^\d{6,25}$/.test(clean)) {
    throw new Error(`Invalid TikTok advertiser id: "${id}" (must be numeric)`);
  }
  return clean;
}

/**
 * `"2026-07-01 00:00:00"` → `"2026-07-01"`.
 *
 * 🔴 `stat_time_day` is a DATETIME, not a date. Written into a `date` column
 * Postgres accepts it and discards the time, which is harmless — but as a
 * unique-constraint value and as a map key the two strings are different, so
 * one day would produce two rows and every total would double.
 *
 * Lives here rather than in `sync.ts` because it is pure, and because `sync.ts`
 * imports the database at module scope — testing it from there would require a
 * `DATABASE_URL` to assert on string slicing.
 */
export function dayOf(statTimeDay: string | undefined): string | null {
  if (!statTimeDay) return null;
  const key = statTimeDay.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

/** TikTok returns every metric as a string. Cast on ingest, never at read. */
export function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
