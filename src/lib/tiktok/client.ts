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
  advertiser_name?: string;
  currency?: string;
  timezone?: string;
}

export interface TiktokInsightRow {
  dimensions: { stat_time_day?: string; campaign_id?: string };
  metrics: Record<string, string | number | null>;
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
      const data = await this.request<{ list?: TiktokAdvertiser[] }>(
        "/advertiser/info/",
        {
          advertiser_ids: JSON.stringify(chunk),
          fields: JSON.stringify([
            "advertiser_id",
            "advertiser_name",
            "currency",
            "timezone",
          ]),
        },
      );
      out.push(...(data.list ?? []));
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
