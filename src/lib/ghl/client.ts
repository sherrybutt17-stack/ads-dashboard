import type {
  GhlContact,
  GhlLocation,
  GhlOpportunity,
  GhlPipeline,
  GhlPipelineStage,
} from "./types";

const BASE_URL = "https://services.leadconnectorhq.com";

/**
 * Required header with a strict enum. v2 is `2021-07-28`; sending anything else
 * (or omitting it) fails the request.
 */
const API_VERSION = "2021-07-28";

export class GhlApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GhlApiError";
  }

  /**
   * Worth trying again, as opposed to worth reporting.
   *
   * 429 and 5xx only. A 401 means the token is dead and a 404 means the id is
   * wrong; retrying either just delays the same answer while holding a sync
   * open.
   */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * How many times a retryable failure is retried, and how long between.
 *
 * 🔴 This client had no retry at all, and it is the one that needs it most.
 *
 * `meta/client.ts` reads Meta's throttle headers and backs off; `google/client.
 * ts` retries 429 and 5xx with exponential backoff. GHL — the only one that
 * pages through an entire location in a tight loop, up to 500 requests with no
 * pause — threw on the first 429 and aborted.
 *
 * What that costs is specific to this integration. The day-0 backfill is the
 * one chance to establish the floor of what is knowable, because GoHighLevel
 * exposes no stage-transition history; a run that dies at page 40 of 200 leaves
 * a snapshot that is silently partial, and the opportunities it never reached
 * have no other source. Re-running is possible but nothing prompts it — the
 * `sync_runs` row says failed and the dashboard just looks quiet.
 */
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1_000;

export class GhlClient {
  constructor(private readonly token: string) {}

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
    attempt = 0,
  ): Promise<T> {
    const { query, ...rest } = init;
    const url = new URL(`${BASE_URL}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const res = await fetch(url, {
      ...rest,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: API_VERSION,
        Accept: "application/json",
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...rest.headers,
      },
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
      const err = new GhlApiError(
        `GHL ${res.status} on ${path}: ${
          typeof body === "string" ? body : JSON.stringify(body)
        }`,
        res.status,
        body,
      );

      if (err.isRetryable && attempt < MAX_RETRIES) {
        /*
         * `Retry-After` when the server states one, exponential backoff when it
         * does not. Honouring the header matters more than the curve: GHL's
         * burst limit refills on a short window, so a server-supplied wait is
         * usually shorter than our own guess, and ignoring it in favour of
         * doubling turns a two-second pause into thirty.
         */
        const stated = Number(res.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(stated) && stated > 0
            ? Math.min(stated * 1000, 60_000)
            : Math.min(2 ** attempt * RETRY_BASE_MS, 30_000);
        await new Promise((r) => setTimeout(r, waitMs));
        return this.request<T>(path, init, attempt + 1);
      }
      throw err;
    }
    return body as T;
  }

  /**
   * Verification call used during onboarding — proves the token is valid AND
   * that it can actually reach this specific location, which a token that is
   * merely well-formed cannot.
   */
  async getLocation(locationId: string): Promise<GhlLocation> {
    const res = await this.request<{ location?: GhlLocation } & GhlLocation>(
      `/locations/${encodeURIComponent(locationId)}`,
    );
    return res.location ?? (res as GhlLocation);
  }

  async getPipelines(locationId: string): Promise<GhlPipeline[]> {
    const res = await this.request<{ pipelines?: GhlPipeline[] }>(
      `/opportunities/pipelines`,
      { query: { locationId } },
    );
    return res.pipelines ?? [];
  }

  async getOpportunity(opportunityId: string): Promise<GhlOpportunity | null> {
    try {
      const res = await this.request<{ opportunity?: GhlOpportunity }>(
        `/opportunities/${encodeURIComponent(opportunityId)}`,
      );
      return res.opportunity ?? null;
    } catch (err) {
      if (err instanceof GhlApiError && err.status === 404) return null;
      throw err;
    }
  }

  async getContact(contactId: string): Promise<GhlContact | null> {
    try {
      const res = await this.request<{ contact?: GhlContact }>(
        `/contacts/${encodeURIComponent(contactId)}`,
      );
      return res.contact ?? null;
    } catch (err) {
      if (err instanceof GhlApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Page through every opportunity in a location.
   *
   * Used for the day-0 backfill snapshot. Cursor semantics on this endpoint are
   * thinly documented, so we drive it by page number and stop as soon as a page
   * comes back empty or short — and hard-cap the loop so a pagination quirk
   * cannot spin forever.
   */
  async *iterateOpportunities(
    locationId: string,
    { limit = 100, maxPages = 500 } = {},
  ): AsyncGenerator<GhlOpportunity[]> {
    let page = 1;
    while (page <= maxPages) {
      const res = await this.request<{
        opportunities?: GhlOpportunity[];
        meta?: { nextPageUrl?: string | null; total?: number };
      }>(`/opportunities/search`, {
        query: { location_id: locationId, limit, page, status: "all" },
      });

      const batch = res.opportunities ?? [];
      if (batch.length === 0) return;
      yield batch;

      // Stop on a short page, or when the API stops offering a next page.
      if (batch.length < limit) return;
      if (res.meta && res.meta.nextPageUrl === null) return;
      page += 1;
    }

    /*
     * 🔴 The cap was reached, so this stopped early — say so.
     *
     * Falling off the loop silently is indistinguishable from finishing, and
     * the caller is the day-0 backfill: it would write `sync_runs.status =
     * success` over a snapshot missing everything past page 500. Nothing else
     * would ever mention it, because GoHighLevel has no stage history to
     * reconcile against later.
     */
    console.warn(
      `[ghl] stopped paging opportunities for location ${locationId} at the ` +
        `${maxPages}-page cap (~${maxPages * limit} records). The snapshot is ` +
        `PARTIAL. Raise maxPages if this location is genuinely larger.`,
    );
  }
}

/**
 * Flatten GHL's pipelines into our stage rows.
 *
 * Defensive about key spelling because the element shape of `stages[]` is
 * unpublished — GHL's own SDK types it as an untyped array.
 */
export function flattenStages(
  pipelines: GhlPipeline[],
): Array<{
  pipelineId: string;
  pipelineName: string | null;
  stageId: string;
  stageName: string | null;
  position: number;
}> {
  const out: ReturnType<typeof flattenStages> = [];
  for (const p of pipelines) {
    const stages = Array.isArray(p.stages) ? p.stages : [];
    stages.forEach((s: GhlPipelineStage, i: number) => {
      const stageId = s.id ?? s._id;
      if (!stageId) return;
      out.push({
        pipelineId: p.id,
        pipelineName: p.name ?? null,
        stageId: String(stageId),
        stageName: (s.name ?? s.stageName ?? null) as string | null,
        position: typeof s.position === "number" ? s.position : i,
      });
    });
  }
  return out;
}
