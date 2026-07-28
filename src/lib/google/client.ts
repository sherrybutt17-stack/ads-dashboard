import { getAccessToken } from "./oauth";

/**
 * Google Ads API HTTP wrapper — the Google analog of `MetaClient`.
 *
 * Every call goes through the MCC: `login-customer-id` is our Manager account,
 * and the URL targets a linked child `customer-id`. One developer token (env)
 * plus one OAuth access token authorize them all.
 *
 * Two traps handled here:
 *  1. **cost is in micros.** `metrics.cost_micros` is 1,000,000× the currency
 *     amount — divide by 1e6 or every spend figure is a million times too big.
 *  2. **ids must be digits only.** Customer ids are shown with dashes
 *     (123-456-7890) but the API wants 1234567890 in both the URL and the
 *     login-customer-id header.
 */

const API_HOST = "https://googleads.googleapis.com";

function apiVersion(): string {
  return process.env.GOOGLE_ADS_API_VERSION ?? "v18";
}

/** Strip everything but digits — customer ids carry dashes in the UI. */
export function normalizeCustomerId(raw: string): string {
  return raw.replace(/\D/g, "");
}

export class GoogleAdsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GoogleAdsError";
  }
  /** Transient conditions worth a backoff-and-retry. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface GoogleCustomerInfo {
  descriptiveName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
}

export interface GoogleDailyRow {
  dateKey: string;
  campaignId: string;
  campaignName: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return 0;
}

interface GaqlRow {
  campaign?: { id?: string; name?: string };
  metrics?: {
    costMicros?: string | number;
    impressions?: string | number;
    clicks?: string | number;
    conversions?: string | number;
  };
  segments?: { date?: string };
  customer?: {
    descriptiveName?: string;
    currencyCode?: string;
    timeZone?: string;
  };
}

export class GoogleAdsClient {
  constructor(private readonly refreshTokenOverride?: string) {}

  private loginCustomerId(): string {
    const mcc = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    if (!mcc) throw new Error("GOOGLE_ADS_LOGIN_CUSTOMER_ID (your MCC id) is not set.");
    return normalizeCustomerId(mcc);
  }

  private developerToken(): string {
    const t = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (!t) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is not set.");
    return t;
  }

  /**
   * Run a GAQL query against one customer via `searchStream`, returning every
   * result row across all stream chunks. Retries transient failures serially.
   */
  private async search(
    customerId: string,
    query: string,
    attempt = 0,
  ): Promise<GaqlRow[]> {
    const cid = normalizeCustomerId(customerId);
    const accessToken = await getAccessToken(this.refreshTokenOverride);
    const url = `${API_HOST}/${apiVersion()}/customers/${cid}/googleAds:searchStream`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": this.developerToken(),
        "login-customer-id": this.loginCustomerId(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!res.ok) {
      const err = new GoogleAdsError(
        `Google Ads ${res.status} on customer ${cid}: ${
          typeof body === "string" ? body : JSON.stringify(body)
        }`,
        res.status,
        body,
      );
      if (err.isRetryable && attempt < 4) {
        await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 2000, 60_000)));
        return this.search(customerId, query, attempt + 1);
      }
      throw err;
    }

    // searchStream returns an array of chunks, each `{ results: [...] }`.
    const chunks = Array.isArray(body) ? body : body ? [body] : [];
    const rows: GaqlRow[] = [];
    for (const chunk of chunks as Array<{ results?: GaqlRow[] }>) {
      if (Array.isArray(chunk.results)) rows.push(...chunk.results);
    }
    return rows;
  }

  /**
   * Verification call used during onboarding — proves the token can reach this
   * customer AND that it is linked to our MCC, echoing back name/currency/tz so a
   * wrong id or an unlinked account is caught immediately.
   */
  async getCustomer(customerId: string): Promise<GoogleCustomerInfo> {
    const rows = await this.search(
      customerId,
      "SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer",
    );
    const c = rows[0]?.customer ?? {};
    return {
      descriptiveName: c.descriptiveName ?? null,
      currencyCode: c.currencyCode ?? null,
      timeZone: c.timeZone ?? null,
    };
  }

  /**
   * Daily campaign metrics over an inclusive date range (dates are `YYYY-MM-DD`
   * in the account's own timezone, same rule as Meta).
   */
  async getDailyMetrics(
    customerId: string,
    since: string,
    until: string,
  ): Promise<GoogleDailyRow[]> {
    const query = `
      SELECT campaign.id, campaign.name, segments.date,
             metrics.cost_micros, metrics.impressions, metrics.clicks,
             metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${until}'
    `;
    const rows = await this.search(customerId, query);
    return rows.map((r) => ({
      dateKey: r.segments?.date ?? "",
      campaignId: r.campaign?.id ?? "",
      campaignName: r.campaign?.name ?? null,
      impressions: num(r.metrics?.impressions),
      clicks: num(r.metrics?.clicks),
      // The micros trap: cost_micros is 1e6× the currency amount.
      spend: num(r.metrics?.costMicros) / 1_000_000,
      conversions: num(r.metrics?.conversions),
    }));
  }
}
