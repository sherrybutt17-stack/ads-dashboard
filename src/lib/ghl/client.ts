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
   * 429, 5xx, and 408 — our own time limit on a call that never answered. A
   * 401 means the token is dead and a 404 means the id is wrong; retrying
   * either just delays the same answer while holding a sync open.
   */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}

/**
 * A failure that may well pass if tried again: GoHighLevel busy or down, a call
 * that ran out of time, or the network between us. What an import pauses on
 * rather than fails on.
 */
export function isTransientGhlFailure(err: unknown): boolean {
  if (err instanceof GhlApiError) return err.isRetryable;
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" || /\bfetch failed\b/i.test(err.message));
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

/**
 * The longest one call may take before it is abandoned and retried.
 *
 * There was no limit at all: a call GoHighLevel never answered held its
 * request until the platform killed it, and a killed request reports nothing.
 */
const CALL_TIMEOUT_MS = 60_000;

/**
 * How long a call may run, for a caller with its own clock to keep — an import
 * that must answer before the route's time limit.
 */
export interface CallLimits {
  /** Abandon a call after this long (default 60 s). */
  timeoutMs?: number;
  /** Epoch ms: start no call or retry wait that would run past this. */
  deadline?: number;
}

export class GhlClient {
  constructor(private readonly token: string) {}

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | undefined>; limits?: CallLimits } = {},
    attempt = 0,
  ): Promise<T> {
    const { query, limits, ...rest } = init;
    const left = limits?.deadline === undefined ? Infinity : limits.deadline - Date.now();
    if (left <= 0) throw new GhlApiError(`GHL call on ${path} not started: out of time`, 408);
    const timeoutMs = Math.max(1, Math.min(limits?.timeoutMs ?? CALL_TIMEOUT_MS, left));
    const url = new URL(`${BASE_URL}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        ...rest,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Version: API_VERSION,
          Accept: "application/json",
          ...(rest.body ? { "Content-Type": "application/json" } : {}),
          ...rest.headers,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (cause) {
      // Ran out of time, or never connected: worth another try while time allows.
      const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      if (!timedOut && !isTransientGhlFailure(cause)) throw cause;
      const err = timedOut ? new GhlApiError(`GHL timed out on ${path} after ${Math.round(timeoutMs / 1000)}s`, 408) : cause;
      const waitMs = Math.min(2 ** attempt * RETRY_BASE_MS, 30_000);
      if (attempt < MAX_RETRIES && fitsBefore(limits?.deadline, waitMs)) {
        await new Promise((r) => setTimeout(r, waitMs));
        return this.request<T>(path, init, attempt + 1);
      }
      throw err;
    }
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
        // A wait that would end past the caller's deadline is no retry at all.
        if (fitsBefore(limits?.deadline, waitMs)) {
          await new Promise((r) => setTimeout(r, waitMs));
          return this.request<T>(path, init, attempt + 1);
        }
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
   * Page through every contact in a location, 500 at a time — with each one's
   * creation date, tags and both attribution touches, the same shape
   * `getContact` returns, so the live path's parsing reads it unchanged.
   *
   * POST /contacts/search, cursored by GHL's own `searchAfter` (the last
   * contact's), which pages past the 10,000 records a page number can reach.
   * Verified on production 26 Oct 2026: pages do not overlap, 500 is the most
   * one page holds (more is a 400), and `total` is the location's count.
   *
   * Yields each page with the cursor that carries on after it, so a caller
   * that stops between pages can resume exactly there.
   */
  async *iterateContacts(
    locationId: string,
    {
      pageLimit = 500,
      searchAfter,
      maxPages = 400,
      limits,
    }: { pageLimit?: number; searchAfter?: unknown[]; maxPages?: number; limits?: CallLimits } = {},
  ): AsyncGenerator<{ contacts: GhlContact[]; next: unknown[] | null; total: number | null }> {
    let after = searchAfter;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.request<{ contacts?: GhlContact[]; total?: number }>(`/contacts/search`, {
        method: "POST",
        body: JSON.stringify({ locationId, pageLimit, ...(after ? { searchAfter: after } : {}) }),
        limits,
      });
      const contacts = res.contacts ?? [];
      if (contacts.length === 0) return;
      const last = contacts[contacts.length - 1] as { searchAfter?: unknown };
      const next = Array.isArray(last.searchAfter) && contacts.length >= pageLimit ? last.searchAfter : null;
      yield { contacts, next, total: typeof res.total === "number" ? res.total : null };
      if (!next) return;
      after = next;
    }
    console.warn(
      `[ghl] stopped paging contacts for location ${locationId} at the ${maxPages}-page cap ` +
        `(~${maxPages * pageLimit} contacts). The import is PARTIAL.`,
    );
  }

  /**
   * Page through every opportunity in a location, 100 at a time.
   *
   * 🔴 Cursored with GHL's own `startAfter` + `startAfterId` (from each page's
   * `meta`), never by page number: past 10,000 records GHL refuses a page
   * number outright — "Please use startAfter and startAfterId for pagination"
   * (SEARCH_USE_START_AFTER_PAGINATION). Soroudi holds 17,796 opportunities;
   * paging by number stopped dead at the 10,000th (26 Oct 2026). Verified on
   * production: the cursor's next page does not overlap the one before.
   *
   * Yields each page with the cursor that carries on after it, so an import
   * that stops between pages resumes exactly there; the cap keeps a
   * pagination quirk from spinning forever, and says so when it is hit.
   */
  async *iterateOpportunityPages(
    locationId: string,
    {
      limit = 100,
      after,
      maxPages = 2000,
      limits,
    }: { limit?: number; after?: OpportunityCursor; maxPages?: number; limits?: CallLimits } = {},
  ): AsyncGenerator<{ opportunities: GhlOpportunity[]; next: OpportunityCursor | null; total: number | null }> {
    let cursor = after;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.request<{
        opportunities?: GhlOpportunity[];
        meta?: { startAfter?: unknown; startAfterId?: unknown; nextPageUrl?: string | null; total?: number };
      }>(`/opportunities/search`, {
        query: {
          location_id: locationId,
          limit,
          status: "all",
          ...(cursor ? { startAfter: cursor.startAfter, startAfterId: cursor.startAfterId } : {}),
        },
        limits,
      });

      const batch = res.opportunities ?? [];
      if (batch.length === 0) return;
      const m = res.meta ?? {};
      // More only on a full page that names where to carry on, and when the API offers a next page at all.
      const next =
        batch.length >= limit &&
        m.nextPageUrl !== null &&
        typeof m.startAfter === "number" &&
        typeof m.startAfterId === "string" &&
        m.startAfterId !== ""
          ? { startAfter: m.startAfter, startAfterId: m.startAfterId }
          : null;
      yield { opportunities: batch, next, total: typeof m.total === "number" ? m.total : null };
      if (!next) return;
      cursor = next;
    }

    /*
     * 🔴 The cap was reached, so this stopped early — say so. Falling off the
     * loop silently is indistinguishable from finishing, and GoHighLevel has
     * no stage history to reconcile a partial import against later.
     */
    console.warn(
      `[ghl] stopped paging opportunities for location ${locationId} at the ` +
        `${maxPages}-page cap (~${maxPages * limit} records). The import is ` +
        `PARTIAL. Raise maxPages if this location is genuinely larger.`,
    );
  }

  /** Every opportunity in a location, a page at a time — `iterateOpportunityPages` without the cursors. */
  async *iterateOpportunities(
    locationId: string,
    opts: { limit?: number; maxPages?: number } = {},
  ): AsyncGenerator<GhlOpportunity[]> {
    for await (const page of this.iterateOpportunityPages(locationId, opts)) yield page.opportunities;
  }
}

/** Where opportunity paging carries on: GHL's own cursor, from a page's `meta`. */
export interface OpportunityCursor {
  startAfter: number;
  startAfterId: string;
}

/** Whether waiting this long still leaves time before the deadline for another call. */
function fitsBefore(deadline: number | undefined, waitMs: number): boolean {
  return deadline === undefined || Date.now() + waitMs < deadline;
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
