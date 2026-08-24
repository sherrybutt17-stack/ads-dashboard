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

/**
 * ⚠️ CONFIRM THIS AGAINST GOOGLE'S RELEASE NOTES BEFORE THE FIRST REAL CALL.
 *
 * Google ships roughly three Ads API versions a year and sunsets each after
 * about thirteen months. Unlike Meta — which silently falls back to an older
 * version and gives you quietly wrong numbers — Google **hard-errors** on a
 * sunset version. That is the better failure: loud, immediate, and impossible
 * to mistake for a data problem.
 *
 * The previous default was `v18` (released around Nov 2024), which is long past
 * sunset and would fail every call. `v22` is the version this release series
 * lands on by that cadence, but it is a projection, not a checked fact, and
 * nothing here has yet made a live request. Set `GOOGLE_ADS_API_VERSION`
 * explicitly once the developer token is approved and the first call is made.
 */
const DEFAULT_API_VERSION = "v22";

function apiVersion(): string {
  return process.env.GOOGLE_ADS_API_VERSION ?? DEFAULT_API_VERSION;
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

/** One account in a manager hierarchy, as `customer_client` reports it. */
export interface GoogleAccountNode {
  customerId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  /** An intermediate manager — structure, not something that can run ads. */
  isManager: boolean;
  /** Depth beneath the queried manager: 1 = direct child. */
  level: number;
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
  customerClient?: {
    /** A resource name — `customers/1234567890`, not a bare id. */
    clientCustomer?: string;
    level?: string | number;
    manager?: boolean;
    descriptiveName?: string;
    currencyCode?: string;
    timeZone?: string;
    status?: string;
  };
}

export class GoogleAdsClient {
  /**
   * @param refreshTokenOverride  a per-account token, for an account not under
   *   the agency MCC. Falls back to the agency refresh token.
   * @param loginCustomerIdOverride  🔴 the manager account this customer is
   *   reached THROUGH. See below.
   */
  constructor(
    private readonly refreshTokenOverride?: string,
    private readonly loginCustomerIdOverride?: string | null,
  ) {}

  /**
   * The `login-customer-id` header.
   *
   * 🔴 Per account, not one global env var, and the distinction only shows up
   * once a client signs in with their OWN Google account rather than being
   * linked under the agency MCC. Their accounts sit under THEIR manager, or
   * under no manager at all, and sending our MCC id then produces a permission
   * error — or, worse, a successful call that returns nothing for an account
   * that plainly has spend. The header is syntactically valid either way, so
   * nothing looks broken.
   *
   * Three cases, in order:
   *
   *   1. An explicit per-account manager id — the self-serve path.
   *   2. `""` stored explicitly — the account has no manager above it, so the
   *      header must be OMITTED rather than defaulted to ours.
   *   3. Nothing stored — the agency MCC from env, exactly as before.
   */
  private loginCustomerId(): string | null {
    if (this.loginCustomerIdOverride !== undefined && this.loginCustomerIdOverride !== null) {
      const trimmed = this.loginCustomerIdOverride.trim();
      // Case 2: a deliberate "no manager", distinct from "not configured".
      return trimmed === "" ? null : normalizeCustomerId(trimmed);
    }
    const mcc = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    if (!mcc) throw new Error("GOOGLE_ADS_LOGIN_CUSTOMER_ID (your MCC id) is not set.");
    return normalizeCustomerId(mcc);
  }

  /** `{"login-customer-id": …}` or `{}` — never an empty-valued header. */
  private loginHeader(): Record<string, string> {
    const id = this.loginCustomerId();
    return id ? { "login-customer-id": id } : {};
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
        // Omitted entirely when the account has no manager above it — sending
        // an empty header is not the same as sending none, and Google rejects
        // the former.
        ...this.loginHeader(),
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
   * Every customer the authorizing Google account can touch directly.
   *
   * The entry point for self-serve connect: the user signs in, and this is the
   * list Google hands back. Two things it is NOT:
   *
   *   · It is **not** a hierarchy. If the user authorizes with a manager
   *     account, this returns that ONE manager, not the accounts beneath it —
   *     which is why `listClientAccounts` exists.
   *   · It returns **resource names** (`customers/1234567890`), not ids, so the
   *     trailing segment has to be taken rather than the string used whole.
   *
   * Deliberately does NOT send `login-customer-id`: this call is about the
   * authorizing identity itself, and scoping it through a manager would be
   * asking the wrong question.
   */
  async listAccessibleCustomers(): Promise<string[]> {
    const accessToken = await getAccessToken(this.refreshTokenOverride);
    const url = `${API_HOST}/${apiVersion()}/customers:listAccessibleCustomers`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": this.developerToken(),
      },
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GoogleAdsError(
        `Google Ads ${res.status} listing accessible customers: ${text}`,
        res.status,
        text,
      );
    }

    const body = JSON.parse(text || "{}") as { resourceNames?: string[] };
    return (body.resourceNames ?? []).map((n) => n.split("/").pop() ?? "").filter(Boolean);
  }

  /**
   * Every account beneath a manager account, at any depth.
   *
   * `customer_client` is a flattened view of the tree, so one query with
   * `level > 0` returns children, grandchildren and below — no recursion. The
   * caller supplies the manager id as BOTH the queried customer and the
   * `login-customer-id`, which is the shape Google requires for a manager
   * traversal and the reason this cannot reuse the agency default.
   *
   * `status = 'ENABLED'` filters out cancelled and closed accounts, which
   * otherwise show up in the picker and fail on first sync.
   */
  async listClientAccounts(managerId: string): Promise<GoogleAccountNode[]> {
    const rows = await this.search(
      managerId,
      `SELECT customer_client.client_customer,
              customer_client.level,
              customer_client.manager,
              customer_client.descriptive_name,
              customer_client.currency_code,
              customer_client.time_zone,
              customer_client.status
       FROM customer_client
       WHERE customer_client.level > 0
         AND customer_client.status = 'ENABLED'`,
    );

    return rows.flatMap((r) => {
      const cc = r.customerClient;
      const id = cc?.clientCustomer?.split("/").pop();
      if (!id) return [];
      return [
        {
          customerId: id,
          name: cc?.descriptiveName ?? null,
          currency: cc?.currencyCode ?? null,
          timezone: cc?.timeZone ?? null,
          // `manager` marks an intermediate manager in the tree. Those cannot
          // be queried for spend, so the picker shows them as structure rather
          // than as a choice that would report zero forever.
          isManager: Boolean(cc?.manager),
          level: Number(cc?.level ?? 0),
        },
      ];
    });
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
